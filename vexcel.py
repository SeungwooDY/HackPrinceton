#!/usr/bin/env python3
"""get_site_imagery(propertyId) -- Vexcel roof/footprint/staging imagery tool.

Lat/lon lookup is deterministic (CoStar primaryAddress, via find_hero_buildings'
cached commercial-property.jsonl index) -- no network call, always available.

The actual Vexcel HTTP call is NOT wired in yet: Vexcel's own API 2.0 docs
(api.vexcelgroup.com/v2/, vexcel.atlassian.net/wiki/spaces/APIDOCS) are gated
behind a Vexcel Viewer login (username/password -> token), which doesn't match
the single VEXCEL_API_KEY value we have in .env. Until that's confirmed
(check the hackathon Discord's /costar-keys channel, or a teammate with
working Vexcel access), get_site_imagery() returns an honestly-flagged
"not available" result instead of guessing an endpoint shape -- per this
repo's rule that unknown means worst case, never a guess.

Usage:
    python3 vexcel.py --property-id 23568
"""
import argparse
import json
import os
import sys

from generate_floor_tasks import _commercial_property_index, load_env

VEXCEL_AUTH_STATUS = (
    "Vexcel API auth scheme not yet confirmed: the docs require a Vexcel "
    "Viewer login (username/password -> token), but .env only has a single "
    "VEXCEL_API_KEY. Get real auth details before wiring up the HTTP call."
)


def get_property_latlon(property_id):
    """(lat, lon) from CoStar's primaryAddress, or (None, None) if missing."""
    prop = _commercial_property_index().get(property_id)
    if prop is None:
        return None, None
    addr = prop.get("primaryAddress") or {}
    return addr.get("latitude"), addr.get("longitude")


def get_site_imagery(lat, lon, vexcel_api_key=None):
    """Vexcel roof/footprint/staging imagery for one lat/lon.

    Returns a result with "available": False until the real Vexcel call is
    wired in -- never fabricates roof/footprint data.
    """
    if lat is None or lon is None:
        return {"available": False, "reason": "no primaryAddress lat/lon for this property (CoStar)"}
    if not vexcel_api_key:
        return {"available": False, "reason": "VEXCEL_API_KEY not set", "lat": lat, "lon": lon}
    return {"available": False, "reason": VEXCEL_AUTH_STATUS, "lat": lat, "lon": lon}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--property-id", type=int, required=True)
    args = ap.parse_args()

    env = load_env(os.path.join(os.path.dirname(__file__), ".env"))
    vexcel_key = env.get("VEXCEL_API_KEY") or os.environ.get("VEXCEL_API_KEY")

    lat, lon = get_property_latlon(args.property_id)
    if lat is None:
        sys.exit(f"property {args.property_id}: no primaryAddress lat/lon in commercial-property.jsonl")

    result = get_site_imagery(lat, lon, vexcel_key)
    print(json.dumps({"propertyId": args.property_id, "lat": lat, "lon": lon, "siteImagery": result}, indent=2))


if __name__ == "__main__":
    main()
