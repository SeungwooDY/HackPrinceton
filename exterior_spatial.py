"""Conservative Vexcel spatial anchors. Never substitute a ring of guessed pins.

GeoJSON coordinates are EPSG:4326 [longitude, latitude]. Automatic locations
are candidates, not verified site facts. Missing/ambiguous detections stay null.
"""
import json
import math
import re
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

RADIUS = 6378137


def lonlat_to_offset(lon, lat, center_lon, center_lat):
    return {'east': RADIUS * math.cos(math.radians(center_lat)) * math.radians(lon - center_lon),
            'north': RADIUS * math.radians(lat - center_lat)}


def wkt_geometry(text):
    """Read the 2D polygon forms returned in Vexcel's footprint fields."""
    if not isinstance(text, str):
        return None
    match = re.fullmatch(r'\s*(POLYGON|MULTIPOLYGON)\s*(\(.*\))\s*', text, re.I | re.S)
    if not match:
        return None
    tokens = re.findall(r'[(),]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?', match[2])
    index = 0

    def group():
        nonlocal index
        if index >= len(tokens) or tokens[index] != '(':
            raise ValueError('Invalid WKT')
        index += 1
        items = []
        while index < len(tokens) and tokens[index] != ')':
            if tokens[index] == '(':
                items.append(group())
            else:
                coordinate = []
                while index < len(tokens) and tokens[index] not in ',()':
                    coordinate.append(float(tokens[index]))
                    index += 1
                if len(coordinate) != 2 or not all(math.isfinite(v) for v in coordinate):
                    raise ValueError('Expected 2D WKT')
                items.append(coordinate)
            if index < len(tokens) and tokens[index] == ',':
                index += 1
        if index >= len(tokens):
            raise ValueError('Invalid WKT')
        index += 1
        return items
    try:
        coordinates = group()
        if index != len(tokens):
            return None
        return {'type': 'Polygon' if match[1].upper() == 'POLYGON' else 'MultiPolygon', 'coordinates': coordinates}
    except (ValueError, IndexError):
        return None


def polygons(geometry):
    if not isinstance(geometry, dict):
        return []
    coordinates = geometry.get('coordinates') or []
    if geometry.get('type') == 'Polygon':
        return [coordinates]
    if geometry.get('type') == 'MultiPolygon':
        return coordinates
    return []


def valid_geometry(geometry):
    rings = [ring for polygon in polygons(geometry) for ring in polygon]
    return bool(rings) and all(len(ring) >= 4 and all(
        isinstance(p, (list, tuple)) and len(p) == 2 and
        all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in p)
        and -180 <= p[0] <= 180 and -90 <= p[1] <= 90 for p in ring) for ring in rings)


def in_ring(point, ring):
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])
        if abs(cross) < 1e-14 and min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1]):
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def contains(geometry, point):
    return any(polygon and in_ring(point, polygon[0]) and not any(in_ring(point, hole) for hole in polygon[1:])
               for polygon in polygons(geometry))


def interior_point(geometry):
    """Pick an interior point; a polygon's bounding-box center may fall outside it."""
    if not valid_geometry(geometry):
        return None
    for polygon in polygons(geometry):
        ring = polygon[0]
        min_x, max_x = min(p[0] for p in ring), max(p[0] for p in ring)
        min_y, max_y = min(p[1] for p in ring), max(p[1] for p in ring)
        center = ((min_x + max_x) / 2, (min_y + max_y) / 2)
        if contains(geometry, center):
            return center
        # Sample the polygon interior, rather than falling back to an outside centroid.
        for step in range(1, 20):
            for column in range(1, 20):
                point = (min_x + (max_x - min_x) * column / 20, min_y + (max_y - min_y) * step / 20)
                if contains(geometry, point):
                    return point
    return None


def date_key(value):
    if not isinstance(value, str):
        return datetime.min
    for form in ('%Y-%m-%d', '%b %d, %Y %I:%M:%S %p', '%Y-%m-%dT%H:%M:%S'):
        try:
            return datetime.strptime(value, form)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).replace(tzinfo=None)
    except ValueError:
        return datetime.min


def select_property(data, lon, lat):
    """Only real parcels containing the address, from an ortho capture."""
    candidates = []
    for feature in data.get('features', []):
        props = feature.get('properties') or {}
        geometry = feature.get('geometry')
        if (props.get('metadata.is-ortho-image') is not True or props.get('parcel-source') != 'real'
                or not valid_geometry(geometry) or not contains(geometry, (lon, lat))):
            continue
        if date_key(props.get('metadata.ortho-date-estimate')) == datetime.min or not props.get('metadata.collection'):
            continue
        candidates.append(feature)
    candidates.sort(key=lambda f: date_key(f['properties'].get('metadata.ortho-date-estimate')), reverse=True)
    if not candidates:
        return None
    # Equal-vintage, distinct parcels are ambiguous; don't choose an arbitrary one.
    newest = date_key(candidates[0]['properties'].get('metadata.ortho-date-estimate'))
    peers = [f for f in candidates if date_key(f['properties'].get('metadata.ortho-date-estimate')) == newest]
    if len({json.dumps(f['geometry'], sort_keys=True) for f in peers}) > 1:
        return None
    return candidates[0]


def roof_anchor(feature, lon, lat):
    props = feature['properties']
    structures = []
    for key, value in props.items():
        match = re.fullmatch(r'(structure\.\d+)\.footprint\.(?:geometry|wkt)', key)
        if not match:
            continue
        geometry = wkt_geometry(value) if isinstance(value, str) else value
        point = interior_point(geometry)
        if point and contains(feature['geometry'], point):
            structures.append((match[1], geometry, point, key))
    containing = [s for s in structures if contains(s[1], (lon, lat))]
    if len(containing) == 1:
        structure = containing[0]
    else:
        primary = [s for s in structures if props.get(s[0] + '.primary-structure') is True]
        if containing or len(primary) != 1:
            return None
        structure = primary[0]
    return make_anchor(structure[2], lon, lat, 'Vexcel property/extract', structure[3],
                       collection=props.get('metadata.collection'))


def make_anchor(point, lon, lat, source, source_path, confidence=None, collection=None):
    offsets = lonlat_to_offset(point[0], point[1], lon, lat)
    if abs(offsets['east']) > 800 or abs(offsets['north']) > 1600 / 3:
        return None
    return {**offsets, 'status': 'candidate', 'longitude': point[0], 'latitude': point[1],
            'source': source, 'sourcePath': source_path, 'confidence': confidence,
            'collection': collection}


def detection_anchors(data, parcel, lon, lat, requested, collection=None):
    candidates = {}
    for index, feature in enumerate(data.get('features', [])):
        props, geometry = feature.get('properties') or {}, feature.get('geometry')
        label, confidence = props.get('label'), props.get('confidence')
        if label not in requested or not isinstance(confidence, (float, int)) or isinstance(confidence, bool) or not .6 <= confidence <= 1:
            continue
        point = interior_point(geometry)
        if not point or not contains(parcel, point):
            continue
        vertices = [p for poly in polygons(geometry) for ring in poly[:1] for p in ring]
        if sum(contains(parcel, p) for p in vertices) / len(vertices) < .8:
            continue  # Reject neighboring/whole-block detections, even with an inside centroid.
        anchor = make_anchor(point, lon, lat, 'Vexcel elements/detect', f'features[{index}].geometry', confidence, collection)
        if anchor:
            candidates.setdefault(requested[label], []).append(anchor)
    # Multiple plausible objects are ambiguous without additional site evidence.
    return {category: options[0] for category, options in candidates.items() if len(options) == 1}


def request_json(endpoint, key, *, params=None, body=None):
    url = 'https://api.vexcelgroup.com/v2/' + endpoint
    if params:
        url += '?' + urlencode(params)
    request = Request(url, data=json.dumps(body).encode() if body is not None else None,
                      headers={'X-API-KEY': key, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=45) as response:
            if response.status == 204:
                return {'type': 'FeatureCollection', 'features': []}
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError('Vexcel spatial response is too large.')
            data = json.loads(raw)
            if not isinstance(data, dict) or not isinstance(data.get('features'), list):
                raise ValueError('Vexcel did not return a GeoJSON feature collection.')
            crs = json.dumps(data.get('crs', 'EPSG:4326'))
            if not any(name in crs for name in ['4326', 'CRS84']):
                raise ValueError('Vexcel response CRS is not EPSG:4326 longitude/latitude.')
            return data
    except HTTPError as error:
        raise ValueError(f'Vexcel {endpoint} returned HTTP {error.code}; no coordinates were inferred.') from None
    except (URLError, TimeoutError, json.JSONDecodeError):
        raise ValueError(f'Vexcel {endpoint} could not be read; no coordinates were inferred.') from None


def locate_vexcel(lon, lat, categories, key):
    if not key:
        raise ValueError('VEXCEL_API_KEY is required for --locate-vexcel.')
    property_data = request_json('property/extract', key, params={
        'wkt': f'POINT({lon} {lat})', 'srid': 4326, 'include': 'precomputed', 'latest': 'true'})
    feature = select_property(property_data, lon, lat)
    if feature is None:
        return {}, ['No unambiguous real parcel/ortho capture contains the address; tasks remain unlocated.']
    collection = feature['properties'].get('metadata.collection')
    anchors = {}
    if 'roof' in categories:
        roof = roof_anchor(feature, lon, lat)
        if roof:
            anchors['roof'] = roof
    prompts = {label: category for category, label in [('garage', 'garage'), ('access', 'driveway'),
               ('private-pool', 'swimming pool'), ('outdoor', 'patio')] if category in categories}
    notes = []
    if prompts:
        # A small property crop avoids searching an entire neighborhood.
        # The parcel itself remains the spatial ownership filter for all detections.
        vertices = [p for poly in polygons(feature['geometry']) for ring in poly[:1] for p in ring]
        if any(abs(lonlat_to_offset(p[0], p[1], lon, lat)['east']) > 100 or
               abs(lonlat_to_offset(p[0], p[1], lon, lat)['north']) > 100 for p in vertices):
            notes.append('Parcel exceeds the bounded detection area; object tasks remain unlocated.')
            return anchors, notes
        wkt = f'POINT({lon} {lat})'
        imagery = {'wkt': wkt, 'srid': 4326, 'bbox-dimensions': '200,200',
                   'destination-dimensions': '1200,1200,fit'}
        if collection:
            imagery['collection'] = collection
        try:
            detections = request_json('elements/detect', key, body={
                'wkt': wkt, 'srid': 4326, 'bbox-dimensions': [200, 200],
                'images': [{'endpoint': 'ortho/extract', 'request': imagery}],
                'model-input': {'elements': [{'label': label, 'detection-threshold': .6} for label in prompts],
                                'include': ['geometry', 'confidence']}})
            anchors.update(detection_anchors(detections, feature['geometry'], lon, lat, prompts, collection))
        except ValueError as error:
            notes.append(str(error))
    return anchors, notes
