#!/usr/bin/env python3
"""Survey real Matterport room richness for a set of candidate properties.

Room COUNT isn't the useful signal for the room-type quiz feature -- a
property with 17 rooms all generically tagged "Other" is less useful than
one with 5 rooms tagged Kitchen/Bedroom/Bathroom, since quiz scenarios are
picked by room-type category. This reports real *typed* rooms (a human
label, or a non-generic tag) per property, separate from raw room count.

Candidates come from out/hero_buildings.csv (CoStar-data-richness ranked)
by default, plus any --property-ids you add by hand after eyeballing a
building yourself -- CoStar richness and demo-worthiness aren't the same
thing, so this is meant to be re-run with a growing, manually-curated list,
not just the top of the CoStar ranking.

Usage:
    python3 survey_matterport_richness.py --top 30
    python3 survey_matterport_richness.py --top 30 --property-ids 12345,67890
"""
import argparse
import csv
import os

from find_hero_buildings import KIT
from generate_floor_tasks import building_facts, load_env, real_location_pool, OUT

GENERIC_TAGS = {"other", "unfurnished"}


def _hero_candidates(n):
    path = os.path.join(OUT, "hero_buildings.csv")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [int(r["propertyId"]) for r in rows[:n]]


def _address_lookup():
    addr = {}
    with open(os.path.join(KIT, "commercial-properties.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            pid = int(r["PropertyId"])
            if pid not in addr:
                addr[pid] = (r["Address"], r["City"])
    return addr


def survey(property_ids, mp_key, mp_secret):
    addr = _address_lookup()
    rows = []
    for pid in property_ids:
        try:
            building, floors = building_facts(pid)
        except SystemExit:
            print(f"  skip {pid}: not found in commercial-property.jsonl")
            continue
        pool = real_location_pool(pid, mp_key, mp_secret)
        num_models = len({r["modelId"] for r in pool.values()})
        typed = [
            r for r in pool.values()
            if r["labelSource"] == "real-matterport-room-label"
            or (r["labelSource"] == "real-matterport-tags" and r["label"].strip().lower() not in GENERIC_TAGS)
        ]
        categories = sorted({r["label"] for r in typed})
        a = addr.get(pid, ("", ""))
        rows.append({
            "propertyId": pid, "propertyType": building["propertyType"],
            "address": a[0], "city": a[1], "numFloors": len(floors),
            "numModels": num_models, "numRooms": len(pool),
            "numTypedRooms": len(typed), "roomTypeCategories": "; ".join(categories),
        })
        print(f"  {pid}: {len(pool)} room(s), {len(typed)} typed ({', '.join(categories) or 'none'})")
    rows.sort(key=lambda r: (-r["numTypedRooms"], -r["numRooms"]))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=30, help="take the top N from out/hero_buildings.csv")
    ap.add_argument("--property-ids", default="", help="extra, comma-separated propertyIds to include")
    args = ap.parse_args()

    env = load_env(os.path.join(os.path.dirname(__file__), ".env"))
    mp_key = env.get("MATTERPORT_API_KEY") or os.environ.get("MATTERPORT_API_KEY")
    mp_secret = env.get("MATTERPORT_API_TOKEN") or os.environ.get("MATTERPORT_API_TOKEN")
    if not mp_key or not mp_secret:
        raise SystemExit("MATTERPORT_API_KEY / MATTERPORT_API_TOKEN not found in .env or environment")

    extra = [int(x) for x in args.property_ids.split(",") if x.strip()]
    candidates = list(dict.fromkeys(_hero_candidates(args.top) + extra))  # dedupe, keep order
    print(f"Surveying {len(candidates)} candidate(s)...")
    rows = survey(candidates, mp_key, mp_secret)

    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, "matterport_richness.csv")
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"\nWrote {out_path}\n")
    print(f"{'propertyId':>10}  {'type':10}  {'rooms':>5}  {'typed':>5}  categories")
    for r in rows:
        print(f"{r['propertyId']:>10}  {r['propertyType'][:10]:10}  {r['numRooms']:>5}  "
              f"{r['numTypedRooms']:>5}  {r['roomTypeCategories']}")


if __name__ == "__main__":
    main()
