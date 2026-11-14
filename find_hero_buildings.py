#!/usr/bin/env python3
"""Rank CoStar kit properties by how complete a pre-incident plan we could build for them.

Usage (from the repo root, with the data folder in place):
    python3 scripts/find_hero_buildings.py            # top 25 overall
    python3 scripts/find_hero_buildings.py --top 50 --non-apartment

Reads costar-hackathon-kit/data/*.jsonl with the standard library only.
Writes scripts/out/hero_buildings.csv and prints the top of the list.
"""
import argparse
import csv
import json
import os
from collections import defaultdict

KIT = os.path.join(os.path.dirname(__file__), "costar-hackathon-kit")
DATA = os.path.join(KIT, "data")
OUT = os.path.join(os.path.dirname(__file__), "out")

ENUMS = json.load(open(os.path.join(KIT, "schemas", "enums.json"), encoding="utf-8"))
PROPERTY_TYPE = ENUMS.get("PropertyType", {})
MATERIAL = ENUMS["BuildingConstructionMaterialType"]
INDUSTRY = ENUMS["IndustryType"]

MATTERPORT_REF = {36, 234}
# AttachmentType2 values worth having for a pre-plan
PLAN_ATTACH = {10: "FloorPlan", 12: "TypicalFloorPlan", 112: "FloorPlanElevation", 11: "SitePlan", 9: "PlatMap"}
AERIAL_ATTACH = {1: "Aerial", 55: "AerialVideo", 57: "UavVideo", 60: "ShortUavVideo", 62: "PlaneView",
                 137: "MatterportAerialPlusInteriorXray", 138: "MatterportAerialExteriorOnly"}
# Tenant industries that change tactics (keys are IndustryType names)
HAZARD_INDUSTRIES = {
    "AccommodationAndFoodServices": "commercial kitchen / sleeping occupants",
    "HealthCareAndSocialAssistance": "non-ambulatory occupants",
    "EducationalServices": "children / large assembly",
    "Manufacturing": "process hazards / hazmat",
    "Wholesaler": "high-piled storage",
    "RetailersOrWholesalers": "high fuel load",
    "MiningQuarryingAndOilAndGasExtraction": "hazmat",
    "Utilities": "electrical / hazmat",
    "WasteManagementAndRemediationServices": "hazmat",
    "ArtsEntertainmentAndRecreation": "assembly occupancy",
}


def jsonl(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def year_built(p):
    years = [e.get("year") for e in p.get("constructionEvents") or []
             if e.get("eventType") == 2 and e.get("year")]  # ConstructionComplete
    return min(years) if years else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--non-apartment", action="store_true", help="skip Multifamily properties")
    args = ap.parse_args()

    addresses = {}
    with open(os.path.join(KIT, "commercial-properties.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            addresses[int(r["PropertyId"])] = (r["Address"], r["City"])

    print("Loading company details...")
    companies = {}
    for c in jsonl("company-detail.jsonl"):
        prof = c.get("profile") or {}
        companies[c["id"]] = (c.get("numEmployees"), prof.get("industryType"), c.get("name"))

    print("Loading current tenancies...")
    tenants = defaultdict(list)  # propertyId -> [(employees, industryName, floorIds)]
    for o in jsonl("location-occupancy.jsonl"):
        if o.get("toDate"):  # ended tenancy
            continue
        emp, ind, name = companies.get(o.get("tenantLocationId"), (None, None, None))
        if ind is None:
            ind = o.get("industryType")
        floors = {s.get("propertyFloorId") for s in o.get("spaces") or [] if s.get("propertyFloorId")}
        tenants[o["propertyId"]].append((emp, INDUSTRY.get(str(ind), "Unknown"), floors, name))

    print("Scoring properties...")
    rows = []
    for p in jsonl("commercial-property.jsonl"):
        ptype = PROPERTY_TYPE.get(str(p.get("propertyType")), str(p.get("propertyType")))
        if args.non_apartment and "multi" in ptype.lower():
            continue
        atts = p.get("attachments") or []
        n_mp = sum(1 for a in atts if a.get("videoExternalReferenceType") in MATTERPORT_REF)
        n_plan = sum(1 for a in atts if a.get("attachmentType") in PLAN_ATTACH)
        n_aerial = sum(1 for a in atts if a.get("attachmentType") in AERIAL_ATTACH)
        material = MATERIAL.get(str(p.get("buildingConstructionMaterial")), "Unknown")
        stories = p.get("numStoriesAboveGrade")
        yb = year_built(p)
        sprink = p.get("hasSprinklers")
        elevators = (p.get("structural") or {}).get("elevators") or []
        t = tenants.get(p["id"], [])
        known_emp = sum(e for e, *_ in t if e)
        tenants_on_floor = sum(1 for _, _, fl, _ in t if fl)
        hazards = sorted({HAZARD_INDUSTRIES[i] for _, i, _, _ in t if i in HAZARD_INDUSTRIES})
        addr = p.get("primaryAddress") or {}

        score = (
            3 * (n_mp > 0)
            + 2 * (n_plan > 0)
            + 1 * (n_aerial > 0)
            + 1 * (material != "Unknown")
            + 1 * (stories is not None)
            + 1 * (yb is not None)
            + 1 * (sprink is not None)
            + 1 * bool(elevators)
            + 2 * min(len(t), 5) / 5
            + 2 * (tenants_on_floor > 0)
            + 1 * (known_emp > 0)
            + 1 * min(len(hazards), 2)
        )
        rows.append({
            "score": round(score, 2), "propertyId": p["id"], "type": ptype,
            "address": addresses.get(p["id"], ("", ""))[0],
            "city": addresses.get(p["id"], ("", ""))[1],
            "stories": stories, "yearBuilt": yb, "material": material, "sprinklers": sprink,
            "matterportModels": n_mp, "floorPlans": n_plan, "aerials": n_aerial,
            "currentTenants": len(t), "tenantsWithFloor": tenants_on_floor,
            "knownEmployees": known_emp, "hazardFlags": "; ".join(hazards),
            "lat": addr.get("latitude"), "lon": addr.get("longitude"),
        })

    rows.sort(key=lambda r: -r["score"])
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "hero_buildings.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"\nWrote {len(rows)} properties to {path}\n")
    for r in rows[: args.top]:
        print(f"{r['score']:5}  {r['propertyId']:>10}  {r['type'][:14]:14}  {str(r['stories'] or '?'):>3}fl  "
              f"{str(r['yearBuilt'] or '?'):4}  {r['material'][:12]:12}  MP={r['matterportModels']} "
              f"plans={r['floorPlans']} tenants={r['currentTenants']} emp={r['knownEmployees']}  "
              f"{r['address'][:40]}  [{r['hazardFlags']}]")


if __name__ == "__main__":
    main()