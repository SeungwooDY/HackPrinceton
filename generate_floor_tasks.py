#!/usr/bin/env python3
"""Generate a per-floor tactical task list for one hero building.

Works for both commercial (office/retail, tenants from location-occupancy.jsonl)
and multifamily (apartments, unit mix from apartment-listing.jsonl) properties.

Code gathers every fact (floor name/size, occupants, hazard flags) from the
CoStar kit data -- those facts, and their source fields, are the single source
of truth for anything under "refs". The OpenRouter model
(inclusionai/ling-3.2-flash:free, free tier) only writes the task title/
description text.

Room/location data comes from Matterport's Model API (real sweeps and rooms
for the property's scanned model(s), fetched with MATTERPORT_API_KEY/
MATTERPORT_API_TOKEN from .env) when available. CoStar's floors[] and
Matterport's floor ids share no key, so a real room can't be attributed to one
specific CoStar floor -- the property's whole real-room pool is offered to
every floor instead of guessing a match (see "floorMappingNote" in the
output). The model must pick from that real pool; it is never allowed to
invent a location while real ones exist. Only when no Matterport data is
available at all does it fall back to an invented placeholder room label,
clearly tagged "llm-invented-placeholder" so it's never mistaken for a fact.

For multifamily properties, CoStar's apartment-listing.jsonl gives a unit mix
(bed/bath/rent) for the WHOLE property, not per floor, so each model's unit
count is evenly split across the property's floors. That estimate is tagged
"unitCountSource" in the output -- it is not a per-floor fact from CoStar.

Usage (from the repo root):
    python3 generate_floor_tasks.py                    # top hero building
    python3 generate_floor_tasks.py --property-id 23568
    python3 generate_floor_tasks.py --property-id 23453 # multifamily example
"""
import argparse
import base64
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from functools import lru_cache
from itertools import cycle

from find_hero_buildings import (
    DATA,
    HAZARD_INDUSTRIES,
    INDUSTRY,
    KIT,
    MATERIAL,
    PROPERTY_TYPE,
    jsonl,
)

OUT = os.path.join(os.path.dirname(__file__), "out")
ENUMS = json.load(open(os.path.join(KIT, "schemas", "enums.json"), encoding="utf-8"))
FLOOR_NAME = ENUMS["FloorName"]
APARTMENT_LIFESTYLE = ENUMS["ApartmentLifestyleType"]
MULTIFAMILY_TYPE_CODE = next(k for k, v in PROPERTY_TYPE.items() if v == "Multifamily")

RESIDENTIAL_LIFESTYLE_HAZARDS = {
    "Senior": "non-ambulatory occupants (senior housing)",
    "Student": "high occupant density (student housing)",
}

OPENROUTER_MODEL = "inclusionai/ling-3.2-flash:free"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
TASK_TYPES = {"Search", "Rescue", "Recon", "Ventilation", "Utility", "Hazard", "Evacuation"}

MATTERPORT_GRAPHQL_URL = "https://api.matterport.com/api/models/graph"
MAX_LOCATIONS_IN_PROMPT = 40
FLOOR_MAPPING_NOTE = ("This Matterport scan is not linked to a specific CoStar floor id; "
                       "the property's real-room pool is offered to every floor the same way.")

SYSTEM_PROMPT = """You are a fire-department tactical planning assistant. \
You will be given deterministic facts about ONE floor of a building, plus a list \
of "availableLocations" (real rooms already 3D-scanned for this building, each \
with an "id" and a "label"). Write a short first-arriving-crew task list for that \
floor only.

Rules:
- Use ONLY the given facts for numbers, unit/suite counts, occupant names, and the \
floor id. Never invent a headcount, square footage, unit or suite number, occupant \
name, or floor id.
- If "availableLocations" is non-empty, every task MUST target one of those rooms: \
set "locationRef" to its exact "id" and "roomLabel" to its exact "label" (copy it \
verbatim, do not reword it). Spread tasks across different listed rooms when there \
are enough of them. Do not invent a room while real ones are listed.
- Only if "availableLocations" is empty may you invent a short, plausible, generic \
roomLabel instead (clearly flavor text, not a real scanned room), and set \
"locationRef" to null.
- Every task's "refs.propertyFloorId" must be exactly the floor id given in the facts.
- If a task is about a specific occupant entry, "refs.occupantRef" must exactly match \
one of the occupant "refName" values given in the facts; otherwise set it to null.
- "type" must be one of: Search, Rescue, Recon, Ventilation, Utility, Hazard, Evacuation.
- Write 3 to 6 tasks. Keep each title under 8 words and each description to 1-2 sentences.
- Reply with ONLY a JSON object: {"tasks": [{"id": str, "type": str, "title": str, \
"description": str, "roomLabel": str, "locationRef": str|null, \
"refs": {"propertyFloorId": int, "occupantRef": str|null}}]}
"""


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


@lru_cache(maxsize=1)
def _company_detail_index():
    """id -> {name, employees, industry}, built with one pass over company-detail.jsonl."""
    companies = {}
    for c in jsonl("company-detail.jsonl"):
        prof = c.get("profile") or {}
        companies[c["id"]] = {
            "name": c.get("name"),
            "employees": c.get("numEmployees"),
            "industry": INDUSTRY.get(str(prof.get("industryType")), "Unknown"),
        }
    return companies


@lru_cache(maxsize=1)
def _location_occupancy_by_property():
    """propertyId -> [occupancy records], built with one pass over location-occupancy.jsonl."""
    by_property = defaultdict(list)
    for o in jsonl("location-occupancy.jsonl"):
        if o.get("toDate"):
            continue
        by_property[o.get("propertyId")].append(o)
    return by_property


@lru_cache(maxsize=1)
def _apartment_listing_by_property():
    """propertyId -> apartment-listing record, built with one pass over apartment-listing.jsonl."""
    by_property = {}
    for a in jsonl("apartment-listing.jsonl"):
        by_property[a.get("propertyId")] = a
    return by_property


@lru_cache(maxsize=1)
def _commercial_property_index():
    """id -> property record, built with one pass over commercial-property.jsonl."""
    return {p["id"]: p for p in jsonl("commercial-property.jsonl")}


def commercial_occupants_by_floor(property_id):
    companies = _company_detail_index()

    floor_occupants = defaultdict(list)
    for o in _location_occupancy_by_property().get(property_id, []):
        company = companies.get(o.get("tenantLocationId")) or {}
        industry = company.get("industry") or INDUSTRY.get(str(o.get("industryType")), "Unknown")
        for s in o.get("spaces") or []:
            fid = s.get("propertyFloorId")
            if not fid:
                continue
            name = company.get("name") or "Unknown tenant"
            floor_occupants[fid].append({
                "refName": name,
                "industry": industry,
                "employees": company.get("employees"),
                "suite": s.get("suite"),
                "squareFeetOccupied": s.get("squareFeetOccupied"),
            })

    hazards_by_floor = {
        fid: sorted({HAZARD_INDUSTRIES[o["industry"]] for o in occs if o["industry"] in HAZARD_INDUSTRIES})
        for fid, occs in floor_occupants.items()
    }
    return floor_occupants, hazards_by_floor, {}


def residential_occupants_by_floor(property_id, num_floors):
    apt = _apartment_listing_by_property().get(property_id)
    if apt is None or num_floors == 0:
        return defaultdict(list), {}, {}

    lifestyle = APARTMENT_LIFESTYLE.get(str(apt.get("lifestyleType")), "Unknown")
    hazard = RESIDENTIAL_LIFESTYLE_HAZARDS.get(lifestyle)
    building_extra = {"buildingName": apt.get("buildingName"), "totalNumUnits": apt.get("totalNumUnits"), "lifestyleType": lifestyle}

    floor_occupants = defaultdict(list)
    for m in apt.get("apartmentModels") or []:
        total_units = m.get("numUnits") or 0
        if total_units <= 0:
            continue
        per_floor, remainder = divmod(total_units, num_floors)
        for i in range(num_floors):
            units_here = per_floor + (1 if i < remainder else 0)
            if units_here <= 0:
                continue
            floor_occupants[i].append({
                "refName": f"{m.get('name')} unit model (id {m['id']})",
                "numBeds": m.get("numBeds"),
                "numBaths": m.get("numBaths"),
                "estimatedUnitsOnFloor": units_here,
                "minSquareFeet": m.get("minSquareFeet"),
                "maxSquareFeet": m.get("maxSquareFeet"),
                "unitCountSource": "estimated: this model's total unit count evenly split across the "
                                    "property's floors -- CoStar's apartment-listing data gives unit "
                                    "mix per property, not per floor",
            })

    hazards_by_floor = defaultdict(list)
    if hazard:
        for i in range(num_floors):
            hazards_by_floor[i] = [hazard]
    return floor_occupants, hazards_by_floor, building_extra


def building_facts(property_id):
    prop = _commercial_property_index().get(property_id)
    if prop is None:
        sys.exit(f"property {property_id} not found in commercial-property.jsonl")

    prop_floors = prop.get("floors") or []
    is_multifamily = str(prop.get("propertyType")) == MULTIFAMILY_TYPE_CODE
    if is_multifamily:
        floor_occupants, hazards_by_floor, building_extra = residential_occupants_by_floor(property_id, len(prop_floors))
    else:
        floor_occupants, hazards_by_floor, building_extra = commercial_occupants_by_floor(property_id)

    floors = []
    for i, f in enumerate(prop_floors):
        fid = f["propertyFloorId"]
        key = i if is_multifamily else fid
        floors.append({
            "propertyFloorId": fid,
            "floorName": FLOOR_NAME.get(str(f.get("floorName")), "Unknown"),
            "floorSizeSqFt": (f.get("floorSize") or {}).get("squareFeet"),
            "occupants": floor_occupants.get(key, []),
            "hazardFlags": hazards_by_floor.get(key, []),
        })

    building = {
        "propertyId": prop["id"],
        "propertyType": PROPERTY_TYPE.get(str(prop.get("propertyType")), str(prop.get("propertyType"))),
        "numStoriesAboveGrade": prop.get("numStoriesAboveGrade"),
        "hasSprinklers": prop.get("hasSprinklers"),
        "buildingConstructionMaterial": MATERIAL.get(str(prop.get("buildingConstructionMaterial")), "Unknown"),
        **building_extra,
    }
    return building, floors


@lru_cache(maxsize=1)
def _matterport_model_ids_by_property():
    """propertyId -> [MatterportModelId, ...], built with one pass over commercial-properties.csv."""
    by_property = defaultdict(list)
    with open(os.path.join(KIT, "commercial-properties.csv"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            mid = (row.get("MatterportModelId") or "").strip()
            if not mid:
                continue
            pid = int(row["PropertyId"])
            if mid not in by_property[pid]:
                by_property[pid].append(mid)
    return by_property


def matterport_model_ids(property_id):
    return _matterport_model_ids_by_property().get(property_id, [])


def fetch_matterport_model(model_id, auth_header):
    query = """
    query getModelGraph($modelId: ID!) {
      model(id: $modelId) {
        name
        rooms { id label tags }
        locations { id room { id } }
      }
    }
    """
    body = json.dumps({"query": query, "variables": {"modelId": model_id}}).encode("utf-8")
    req = urllib.request.Request(
        MATTERPORT_GRAPHQL_URL,
        data=body,
        method="POST",
        headers={"Authorization": auth_header, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("errors"):
        raise RuntimeError(str(payload["errors"])[:300])
    return payload["data"]["model"]


def real_location_pool(property_id, mp_key, mp_secret):
    """Real rooms+sweeps for this property's Matterport scan(s), keyed by room id.

    Returns {} if no credentials, no scanned model, or the API call fails --
    callers must treat an empty pool as "fall back to a placeholder location",
    never as an error to crash on.
    """
    if not mp_key or not mp_secret:
        return {}
    model_ids = matterport_model_ids(property_id)
    if not model_ids:
        return {}

    auth_header = "Basic " + base64.b64encode(f"{mp_key}:{mp_secret}".encode()).decode()
    rooms = {}
    for model_id in model_ids:
        try:
            model = fetch_matterport_model(model_id, auth_header)
        except (urllib.error.URLError, RuntimeError, KeyError, ValueError) as e:
            print(f"  Matterport fetch failed for model {model_id}: {e}")
            continue
        room_meta = {r["id"]: r for r in model.get("rooms") or []}
        for loc in model.get("locations") or []:
            room = loc.get("room")
            if not room:
                continue
            room_id = room["id"]
            meta = room_meta.get(room_id) or {}
            label = (meta.get("label") or "").strip()
            tags = [t for t in (meta.get("tags") or []) if t != "unfurnished"]
            if label:
                display, label_source = label, "real-matterport-room-label"
            elif tags:
                display, label_source = ", ".join(t.replace("_", " ").title() for t in tags), "real-matterport-tags"
            else:
                display, label_source = "Unlabeled room", "real-matterport-unlabeled"
            entry = rooms.setdefault(room_id, {
                "id": room_id, "label": display, "labelSource": label_source,
                "modelId": model_id, "modelName": model.get("name"), "sweepIds": [],
            })
            entry["sweepIds"].append(loc["id"])
    return rooms


def call_openrouter(api_key, building, floor, available_locations):
    user_prompt = json.dumps(
        {"building": building, "floor": floor, "availableLocations": available_locations}, indent=2
    )
    body = json.dumps({
        "model": OPENROUTER_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.4,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        OPENROUTER_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/local/hackprinceton",
            "X-Title": "Pre-Incident Plan Agent",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            content = payload["choices"][0]["message"]["content"]
            if content:
                return content
            if attempt < 2:
                print("    model returned empty content, retrying...")
                time.sleep(2 * (attempt + 1))
                continue
            return None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            if e.code == 429 and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"OpenRouter request failed ({e.code}): {detail}")
    return None


def validate_tasks(raw_json, floor, location_pool, sweep_cycles):
    valid_refs = {o["refName"] for o in floor["occupants"]}
    if not raw_json:
        print("    model returned no content, skipping floor")
        return [], 0
    try:
        parsed = json.loads(raw_json)
        tasks = parsed["tasks"]
    except (json.JSONDecodeError, KeyError, TypeError):
        print(f"    model response wasn't valid JSON, skipping floor: {raw_json[:300]!r}")
        return [], 0

    kept = []
    for t in tasks:
        try:
            if t["type"] not in TASK_TYPES:
                print(f"    dropped task {t.get('id')!r}: type {t.get('type')!r} not in {sorted(TASK_TYPES)}")
                continue
            refs = t["refs"]
            if refs.get("propertyFloorId") != floor["propertyFloorId"]:
                print(f"    dropped task {t.get('id')!r}: refs.propertyFloorId {refs.get('propertyFloorId')!r} != {floor['propertyFloorId']}")
                continue
            occupant_ref = refs.get("occupantRef")
            if occupant_ref is not None and occupant_ref not in valid_refs:
                print(f"    dropped task {t.get('id')!r}: occupantRef {occupant_ref!r} not in {sorted(valid_refs)}")
                continue
            room_label = str(t["roomLabel"]).strip()
            if not room_label:
                print(f"    dropped task {t.get('id')!r}: empty roomLabel")
                continue

            location_ref = t.get("locationRef")
            if location_pool:
                if location_ref not in location_pool:
                    print(f"    dropped task {t.get('id')!r}: locationRef {location_ref!r} not in the real room pool")
                    continue
                meta = location_pool[location_ref]
                location = {
                    "roomLabel": meta["label"],
                    "roomLabelSource": meta["labelSource"],
                    "locationId": next(sweep_cycles[location_ref]),
                    "locationIdSource": "real-matterport-sweep-id",
                    "matterportModelId": meta["modelId"],
                    "floorMappingNote": FLOOR_MAPPING_NOTE,
                }
            else:
                location = {
                    "roomLabel": room_label,
                    "roomLabelSource": "llm-invented-placeholder",
                    "locationId": f"PLACEHOLDER-SWEEP-{floor['propertyFloorId']}-{len(kept) + 1}",
                    "locationIdSource": "not-a-real-matterport-sweep-id",
                }

            kept.append({
                "id": str(t["id"]),
                "type": t["type"],
                "title": str(t["title"]),
                "description": str(t["description"]),
                "refs": {"propertyFloorId": floor["propertyFloorId"], "occupantRef": occupant_ref},
                "location": location,
            })
        except (KeyError, TypeError) as e:
            print(f"    dropped task {t.get('id')!r}: malformed ({e})")
            continue
    return kept, len(tasks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--property-id", type=int, help="CoStar propertyId; defaults to the top row of out/hero_buildings.csv")
    args = ap.parse_args()

    env = load_env(os.path.join(os.path.dirname(__file__), ".env"))
    api_key = env.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        sys.exit("OPENROUTER_API_KEY not found in .env or environment")

    property_id = args.property_id
    if property_id is None:
        hero_csv = os.path.join(OUT, "hero_buildings.csv")
        if not os.path.exists(hero_csv):
            sys.exit("No --property-id given and out/hero_buildings.csv doesn't exist yet; run find_hero_buildings.py first")
        with open(hero_csv, encoding="utf-8") as f:
            property_id = int(next(csv.DictReader(f))["propertyId"])
        print(f"No --property-id given; using top hero building {property_id}")

    building, floors = building_facts(property_id)
    print(f"Building {property_id}: {building['propertyType']}, {len(floors)} floor(s) on record")

    mp_key = env.get("MATTERPORT_API_KEY") or os.environ.get("MATTERPORT_API_KEY")
    mp_secret = env.get("MATTERPORT_API_TOKEN") or os.environ.get("MATTERPORT_API_TOKEN")
    location_pool = real_location_pool(property_id, mp_key, mp_secret)
    if location_pool:
        n_models = len({r["modelId"] for r in location_pool.values()})
        print(f"Matterport: {len(location_pool)} real room(s) across {n_models} scanned model(s)")
    else:
        print("Matterport: no real room data for this property; tasks will use invented placeholder locations")
    available_locations = [
        {"id": r["id"], "label": r["label"], "modelName": r["modelName"]}
        for r in list(location_pool.values())[:MAX_LOCATIONS_IN_PROMPT]
    ]
    sweep_cycles = {room_id: cycle(r["sweepIds"]) for room_id, r in location_pool.items()}

    result_floors = []
    for floor in floors:
        label = floor["floorName"]
        print(f"  Floor {floor['propertyFloorId']} ({label}): requesting tasks from {OPENROUTER_MODEL}...")
        raw = call_openrouter(api_key, building, floor, available_locations)
        tasks, total = validate_tasks(raw, floor, location_pool, sweep_cycles)
        print(f"    kept {len(tasks)}/{total} task(s)")
        result_floors.append({"facts": floor, "tasks": tasks})

    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, f"floor_tasks_{property_id}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"building": building, "floors": result_floors}, f, indent=2)
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
