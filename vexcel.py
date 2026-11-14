#!/usr/bin/env python3
"""Vexcel aerial extracts with CoStar coordinates and server-side credentials."""
import argparse
import csv
import json
import math
import os
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
KIT = ROOT / 'costar-hackathon-kit'
WIDTHS = (200, 400, 600, 1000, 1600)


class ImageryError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def vexcel_key():
    key = os.environ.get('VEXCEL_API_KEY', '').strip()
    if key:
        return key
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            name, separator, value = line.removeprefix('export ').partition('=')
            if separator and name.strip() == 'VEXCEL_API_KEY':
                return value.split(' #', 1)[0].strip().strip('\"\'')
    return ''


@lru_cache(maxsize=1)
def property_coordinates():
    path = KIT / 'data/commercial-property.jsonl'
    if not path.exists():
        return {}
    result = {}
    with path.open() as records:
        for line in records:
            if line.strip():
                record = json.loads(line)
                address = record.get('primaryAddress') or {}
                lat, lon = address.get('latitude'), address.get('longitude')
                if valid_coordinates(lat, lon):
                    result[str(record['id'])] = (lat, lon)
    return result


def valid_coordinates(lat, lon):
    return (isinstance(lat, (int, float)) and isinstance(lon, (int, float))
            and math.isfinite(lat) and math.isfinite(lon)
            and -90 <= lat <= 90 and -180 <= lon <= 180)


def get_property_latlon(property_id):
    return property_coordinates().get(str(property_id), (None, None))


@lru_cache(maxsize=1)
def model_sites():
    sites = {}
    path = KIT / 'commercial-properties.csv'
    if path.exists():
        with path.open(newline='') as source:
            for row in csv.DictReader(source):
                lat, lon = get_property_latlon(row['PropertyId'])
                if lat is not None:
                    sites[row['MatterportModelId']] = {
                        'propertyId': row['PropertyId'], 'latitude': lat, 'longitude': lon,
                        'address': ', '.join(row[key] for key in ('Address', 'City', 'State') if row.get(key)),
                        'coordinateSource': 'CoStar primaryAddress',
                    }

    residential_csv = KIT / 'residential-listings.csv'
    residential_data = KIT / 'data/residential-listings.jsonl'
    if residential_csv.exists() and residential_data.exists():
        with residential_csv.open(newline='') as source:
            listings = {row['ListingId']: row for row in csv.DictReader(source)}
        with residential_data.open() as records:
            for line in records:
                if not line.strip():
                    continue
                record = json.loads(line)
                row = listings.get(str(record.get('id')))
                if not row:
                    continue
                address = (record.get('property') or {}).get('address') or {}
                lat, lon = address.get('latitude'), address.get('longitude')
                if not valid_coordinates(lat, lon):
                    continue
                sites[row['MatterportModelId']] = {
                    'propertyId': str(record['propertyId']) if record.get('propertyId') is not None else None,
                    'listingId': row['ListingId'], 'latitude': lat, 'longitude': lon,
                    'address': ', '.join(row[key] for key in ('Address', 'City', 'State') if row.get(key)),
                    'coordinateSource': 'CoStar residential listing property.address',
                }
    return sites


def site_for_model(model_id):
    site = model_sites().get(model_id)
    if not site:
        raise ImageryError('No building coordinates are available for this model in the local property data.', 404)
    return {**site, 'configured': bool(vexcel_key())}


def get_site_imagery(lat, lon, vexcel_api_key=None, width_meters=600):
    """Return (content type, image bytes) for a north-up 3:2 aerial extract."""
    key = vexcel_api_key or vexcel_key()
    if not key:
        raise ImageryError('Set VEXCEL_API_KEY in .env to load aerial imagery.', 503)
    if not valid_coordinates(lat, lon):
        raise ImageryError('Valid building coordinates are required.', 400)
    if width_meters not in WIDTHS:
        raise ImageryError('Unsupported aerial view width.', 400)
    params = {
        'wkt': f'POINT({lon} {lat})', 'srid': '4326',
        'bbox-dimensions': f'{width_meters},{width_meters * 2 / 3:g}',
        'destination-dimensions': '1200,800,fit',
        'image-format': 'jpeg', 'attribution': 'true',
    }
    request = Request('https://api.vexcelgroup.com/v2/ortho/extract?' + urlencode(params),
                      headers={'X-API-KEY': key})
    try:
        with urlopen(request, timeout=30) as response:
            content_type = response.headers.get_content_type()
            if content_type not in ('image/jpeg', 'image/png'):
                raise ImageryError('Vexcel did not return an aerial image.')
            data = response.read(12 * 1024 * 1024 + 1)
            if not data or len(data) > 12 * 1024 * 1024:
                raise ImageryError('Vexcel returned an empty or oversized image.')
            return content_type, data
    except HTTPError as failure:
        if failure.code in (401, 403):
            raise ImageryError('Vexcel access was denied. Check the API key and imagery permissions.', 503) from None
        if failure.code == 404:
            raise ImageryError('Vexcel has no aerial imagery for this location.', 404) from None
        if failure.code == 429:
            raise ImageryError('Vexcel is busy. Please try again shortly.', 429) from None
        raise ImageryError('Vexcel could not load this aerial image. Please retry.') from None
    except (URLError, TimeoutError):
        raise ImageryError('Unable to reach Vexcel. Please retry.') from None


@lru_cache(maxsize=24)
def imagery_for_model(model_id, width_meters):
    site = site_for_model(model_id)
    return get_site_imagery(site['latitude'], site['longitude'], width_meters=width_meters)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--property-id', type=int, required=True)
    parser.add_argument('--output', type=Path, default=Path('/tmp/vexcel-aerial.jpg'))
    args = parser.parse_args()
    try:
        _, image = get_site_imagery(*get_property_latlon(args.property_id))
        args.output.write_bytes(image)
        print(f'Saved aerial imagery to {args.output}')
    except ImageryError as failure:
        parser.exit(1, str(failure) + '\n')
