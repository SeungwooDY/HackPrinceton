#!/usr/bin/env python3
"""Generate sourced residential exterior training tasks and Vexcel quiz JSON.

Uses only the local CoStar kit and the Python standard library. No API keys,
network calls, or LLM are required for task generation. Task text comes from deterministic templates;
property facts never come from generated prose. Tasks remain unlocated unless
spatial anchors are supplied, or --locate-vexcel finds feature candidates.

Examples:
    python3 generate_exterior_tasks.py
    python3 generate_exterior_tasks.py --model-id Ki9YdfpNKum
    python3 generate_exterior_tasks.py --listing-id 181343128
    python3 generate_exterior_tasks.py --property-id 500019659444
"""
import argparse
import csv
import hashlib
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_KIT = ROOT / 'costar-hackathon-kit'
POSITION_NOTE = 'No feature location is available. This task is shown in the property checklist, not pinned on the map.'
MAX_TASKS = 10
FEATURE_GROUPS = {
    'garage': {'Attached Garage', 'Detached Garage', 'Garage', 'Carport', 'Attached Carport', 'Detached Carport'},
    'access': {'Driveway', 'Circular Driveway', 'Driveway Gate', 'Security Gate', 'Electric Gate',
               'Automatic Gate', 'Gated Property', 'Gated Community', 'Gated Parking', 'Gated with Attendant'},
    'fencing': {'Back Yard Fenced', 'Fenced Yard', 'Fully Fenced Property', 'Partially Fenced Property',
                'Fenced', 'Wood Fence', 'Wrought Iron Fence', 'Block Wall Fence', 'Chain Link Fence'},
    'private-pool': {'Private Pool'},
    'community-pool': {'Community Pool'},
    'roof': {'Composition Roof', 'Shingle Roof', 'Metal Roof', 'Tile Roof', 'Wood Roof', 'Flat Roof Shape',
             'Asphalt Roof', 'Clay Roof', 'Spanish Tile Roof', 'Built-Up Roof', 'Slate Roof', 'Concrete Roof'},
    'exterior-material': {'Brick Exterior Construction'},
    'outdoor': {'Deck', 'Patio', 'Covered Patio or Porch', 'Open Patio', 'Covered Deck', 'Rooftop Deck'},
}
# Questions assess record interpretation and verification, not firefighting tactics.
TEMPLATES = {
    'garage': ('Garage review', 'Recon', 'Review the reported garage or carport and verify its location and access.',
               'What can you conclude from a reported garage or carport feature?',
               'Its type is recorded; location, access, and current conditions still need verification.',
               ['Its exact location is the quiz marker.', 'It proves the space is empty and accessible.']),
    'access': ('Access review', 'Recon', 'Review reported driveway or gate features and verify current access conditions.',
               'How should the reported driveway or gate features be used?',
               'As prompts to verify the route, gate location, and current access conditions.',
               ['As proof that all gates are unlocked.', 'As confirmation that the route suits every vehicle.']),
    'fencing': ('Fence review', 'Recon', 'Locate the reported fencing and verify actual openings during the exterior review.',
                'Does a fencing feature establish a usable opening or exit?',
                'No; the fence location and usable openings must be verified separately.',
                ['Yes; the quiz marker identifies an opening.', 'Yes; a fenced yard always has an unlocked rear gate.']),
    'private-pool': ('Private pool review', 'Recon', 'Verify the reported private pool location and surrounding barriers.',
                     'What does the private-pool feature establish?',
                     'The listing reports a private pool; its location and current conditions remain unverified.',
                     ['The pool is exactly at the marker.', 'The pool is a verified firefighting water supply.']),
    'community-pool': ('Community pool context', 'Recon', 'Distinguish the reported community amenity from features on the individual home lot.',
                       'Does a community-pool feature put a private pool on this home lot?',
                       'No; it reports a shared amenity, whose location must be checked separately.',
                       ['Yes; every home in the community has a private pool.', 'Yes; the marker is the pool location.']),
    'roof': ('Roof information review', 'Recon', 'Compare the listed roof information with reviewed exterior observations.',
             'What does the recorded roof covering or shape tell you?',
             'A listing characteristic; it does not establish structural condition or safe roof access.',
             ['That the roof is safe to walk on.', 'That its framing and load capacity are confirmed.']),
    'exterior-material': ('Exterior material review', 'Recon', 'Review the listed exterior material without treating it as a structural-system assessment.',
                          'Does brick exterior construction prove the entire structural system is masonry?',
                          'No; exterior material alone does not establish the structural system.',
                          ['Yes; exterior brick confirms every structural element.', 'Yes; it establishes current structural integrity.']),
    'outdoor': ('Outdoor space review', 'Recon', 'Locate the listed outdoor spaces and verify their connections to the home.',
                'Does a listed deck or patio confirm a usable evacuation route?',
                'No; connections, access, and current conditions need separate verification.',
                ['Yes; every deck has stairs to ground level.', 'Yes; the marker identifies a verified exit.']),
    'building': ('Building overview', 'Recon', 'Review the recorded building characteristics before comparing them with the exterior.',
                 'How should recorded stories, age, and lot information be used?',
                 'As sourced listing information to verify, with missing details kept unknown.',
                 ['To infer where every entrance and stair is located.', 'To treat the image edges as legal property boundaries.']),
    'unknowns': ('Verify missing site details', 'Recon', 'Identify missing exterior information before treating the listing as a complete site plan.',
                 'What should happen when hydrant, shutoff, or entrance locations are missing?',
                 'Keep them unknown and seek a verified source; do not infer them from training markers.',
                 ['Treat each quiz marker as a verified site feature.', 'Assume missing features do not exist.']),
}


def read_jsonl(path):
    with path.open(encoding='utf-8') as source:
        for number, line in enumerate(source, 1):
            if line.strip():
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f'{path.name}:{number}: invalid JSON') from error


def get_path(record, path):
    for part in path.split('.'):
        if not isinstance(record, dict):
            return None
        record = record.get(part)
    return record


def valid_number(value, positive=False):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and (not positive or value > 0))


def select_listing(kit, *, listing_id=None, property_id=None, model_id=None):
    """CSV ListingId is the JSONL id; ResidentialListingId is a different key."""
    records = {row['id']: row for row in read_jsonl(kit / 'data/residential-listings.jsonl')}
    with (kit / 'residential-listings.csv').open(newline='', encoding='utf-8-sig') as source:
        matches = []
        for mapping in csv.DictReader(source):
            record = records.get(int(mapping['ListingId']))
            if record is None:
                continue
            model = mapping['MatterportModelId']
            if listing_id is not None and record['id'] != listing_id:
                continue
            if property_id is not None and record.get('propertyId') != property_id:
                continue
            if model_id is not None and model != model_id:
                continue
            if not re.fullmatch(r'[A-Za-z0-9]{11}', model):
                continue
            matches.append((record, model))
    if not matches:
        raise ValueError('No residential listing/model matches the supplied IDs. Use ListingId, not ResidentialListingId; commercial PropertyIds are a separate dataset.')
    # For an explicit selector, prefer the newest matching listing deterministically.
    # With no selector, use the first CSV row, matching the documented demo default.
    if any(value is not None for value in (listing_id, property_id, model_id)):
        matches.sort(key=lambda pair: (pair[0].get('listDate') or '', pair[0]['id'], pair[1]), reverse=True)
    record, model = matches[0]
    lat = get_path(record, 'property.address.latitude')
    lon = get_path(record, 'property.address.longitude')
    if not (valid_number(lat) and valid_number(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f'Listing {record["id"]} has no valid address coordinates for Vexcel.')
    return record, model


def gather_facts(listing, features_record=None, include_inferred=False):
    facts, groups = {}, {}

    def add(fact_id, value, dataset, path, origin=None, feature_id=None):
        evidence = {'dataset': dataset, 'recordId': listing['id'], 'path': path, 'value': value}
        if origin:
            evidence['origin'] = origin
        if feature_id is not None:
            evidence['featureId'] = feature_id
        facts[fact_id] = evidence

    for fact_id, path in [('latitude', 'property.address.latitude'), ('longitude', 'property.address.longitude'),
                          ('address', 'property.address.fullStreetAddress'), ('listDate', 'listDate')]:
        value = get_path(listing, path)
        if value is not None:
            add(fact_id, value, 'residential-listings.jsonl', path)

    scalar_paths = {
        'stories': ['resoValues.structure.stories'],
        'yearBuilt': ['property.yearBuilt', 'resoValues.structure.yearBuilt'],
        'lotAcres': ['property.lotSizeAcresMin'],
        'parkingSpaces': ['property.totalParkingSpaces', 'resoValues.structure.parkingTotal'],
        'garageSpaces': ['resoValues.structure.garageSpaces'],
    }
    derived_paths = {'stories': 'numberOfStories', 'yearBuilt': 'yearBuilt', 'lotAcres': 'lotSizeInAcres',
                     'parkingSpaces': 'totalParkingSpaces', 'garageSpaces': 'totalGarageSpaces'}
    def usable_scalar(fact_id, value):
        # An explicit zero parking count is a fact, not a missing value.
        return (valid_number(value, positive=fact_id not in {'parkingSpaces', 'garageSpaces'})
                and value >= 0)

    for fact_id, paths in scalar_paths.items():
        for path in paths:
            value = get_path(listing, path)
            if usable_scalar(fact_id, value):
                add(fact_id, value, 'residential-listings.jsonl', path)
                break
        if fact_id not in facts and features_record:
            path = 'derivedValues.' + derived_paths[fact_id]
            value = get_path(features_record, path)
            if usable_scalar(fact_id, value):
                add(fact_id, value, 'residential-listing-features.jsonl', path, 'Derived')

    permitted = {'Mls', 'Research'}
    if include_inferred:
        permitted |= {'MachineLearning', 'ComputerVision'}
    for index, feature in enumerate((features_record or {}).get('features') or []):
        if feature.get('source') not in permitted or feature.get('boolValue') is False:
            continue
        if feature.get('doubleValue') is not None and not valid_number(feature['doubleValue'], positive=True):
            continue
        for group, names in FEATURE_GROUPS.items():
            if feature.get('name') not in names:
                continue
            fact_id = f'feature-{index}'
            add(fact_id, feature['name'], 'residential-listing-features.jsonl',
                f'features[{index}].name', feature['source'], feature.get('id'))
            groups.setdefault(group, []).append(fact_id)
    return facts, groups


def build_exterior_tasks(listing, model_id, features_record=None, *, max_tasks=8, include_inferred=False):
    if not 1 <= max_tasks <= MAX_TASKS:
        raise ValueError('max_tasks must be between 1 and 10.')
    if features_record is not None and features_record.get('id') != listing['id']:
        raise ValueError('Features must join on the residential listing id.')
    if not re.fullmatch(r'[A-Za-z0-9]{11}', model_id):
        raise ValueError('model_id must be an 11-character Matterport model ID.')
    lat, lon = (get_path(listing, f'property.address.{axis}') for axis in ('latitude', 'longitude'))
    if not (valid_number(lat) and valid_number(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError('Valid property address coordinates are required.')
    facts, groups = gather_facts(listing, features_record, include_inferred)
    building_ids = [key for key in ('stories', 'yearBuilt', 'lotAcres', 'parkingSpaces', 'garageSpaces') if key in facts]
    candidates = [('building', building_ids)] if building_ids else []
    candidates.extend((key, groups[key]) for key in FEATURE_GROUPS if key in groups)
    # An explicit verification task keeps unsupported operational details unknown.
    candidates = candidates[:max_tasks - 1] + [('unknowns', ['latitude', 'longitude'])]
    tasks, points = [], []
    for category, fact_ids in candidates:
        label, task_type, instruction, question, correct, wrong = TEMPLATES[category]
        task_id = f'exterior-{listing["id"]}-{category}-v1'
        evidence = [facts[key] for key in fact_ids]
        summary = '; '.join(f'{key}: {facts[key]["value"]}' if not key.startswith('feature-') else str(facts[key]['value']) for key in fact_ids)
        # Keep visible text inside importer limits; complete evidence stays attached.
        description = f'{instruction} Listing reports: {summary}.' if category != 'unknowns' else instruction
        description = description[:950]
        rotation = int(hashlib.sha256(f'{model_id}:{category}'.encode()).hexdigest()[:8], 16) % 3
        options = [correct, *wrong]
        options = options[rotation:] + options[:rotation]
        explanation = ('The cited fields report listing information, not current conditions or measured feature positions. '
                       + correct)
        point = {'id': task_id, 'label': label, 'east': None, 'north': None, 'placementStatus': 'unlocated', 'category': category,
                 'description': description, 'quiz': {'question': question, 'options': options, 'correctIndex': options.index(correct)},
                 'explanation': explanation, 'evidence': evidence, 'placementNote': POSITION_NOTE}
        points.append(point)
        tasks.append({'id': task_id, 'type': task_type, 'title': label, 'description': description,
                      'refs': {'listingId': listing['id'], 'propertyId': listing.get('propertyId'), 'factIds': fact_ids},
                      'location': {'matterportModelId': model_id, 'pointId': task_id,
                                   'positionSource': 'unlocated', 'featureCoordinates': None,
                                   'note': POSITION_NOTE}})
    unknowns = ['Exact entrances and usable access routes', 'Hydrant and fire department connection locations',
                'Utility shutoff locations', 'Current occupancy and incident conditions',
                'Fire suppression system status (a generic residential sprinkler feature is not proof)',
                'Structural system and roof load capacity', 'Legal parcel boundary geometry']
    unknowns.extend(key for key in ('stories', 'yearBuilt', 'lotAcres', 'parkingSpaces', 'garageSpaces') if key not in facts)
    return {'version': 1, 'modelId': model_id, 'listingId': listing['id'], 'propertyId': listing.get('propertyId'),
            'generator': 'deterministic-residential-exterior-v2', 'facts': facts, 'unknowns': unknowns,
            'notes': ['Listing records are not live site observations.', POSITION_NOTE,
                      'No feature record is available for this listing.' if features_record is None else 'Feature provenance is retained in each evidence entry.',
                      'MachineLearning/ComputerVision features are included and labeled.' if include_inferred else 'MachineLearning/ComputerVision features are excluded.'],
            'tasks': tasks, 'points': points}



def apply_spatial_anchors(result, anchors):
    """Add only explicitly supplied spatial evidence; never infer missing anchors."""
    tasks = {task['id']: task for task in result['tasks']}
    for point in result['points']:
        anchor = anchors.get(point['category'])
        if anchor is None:
            continue
        east, north = anchor.get('east'), anchor.get('north')
        status = anchor.get('status')
        source = anchor.get('source')
        if (not valid_number(east) or not valid_number(north) or abs(east) > 800 or abs(north) > 1600 / 3
                or status not in {'candidate', 'reviewed'} or not isinstance(source, str) or not source.strip()):
            raise ValueError(f'Invalid spatial anchor for {point["category"]}.')
        point.update(east=east, north=north, placementStatus=status)
        point['placementNote'] = (f'{"Image-reviewed" if status == "reviewed" else "Detected candidate"} location from {source}. '
                                  'Confirm it belongs to this property and matches the displayed imagery.')
        point['evidence'].append({'dataset': source[:300], 'recordId': str(anchor.get('collection') or result['modelId']),
                                  'path': str(anchor.get('sourcePath') or point['category'])[:300],
                                  'value': f'east={east:.2f} m; north={north:.2f} m',
                                  'origin': 'ImageReviewed' if status == 'reviewed' else 'MachineLearning'})
        task = tasks[point['id']]
        task['location'].update(positionSource=source, note=point['placementNote'],
                                featureCoordinates={'east': east, 'north': north, 'status': status})
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--listing-id', type=int, help='CoStar ListingId (not ResidentialListingId)')
    parser.add_argument('--property-id', type=int, help='Residential propertyId; newest matching listing is selected')
    parser.add_argument('--model-id', help='Matterport model ID from residential-listings.csv')
    parser.add_argument('--kit-dir', type=Path, default=DEFAULT_KIT, help='Path to the local CoStar hackathon kit')
    parser.add_argument('--output', type=Path, help='Output JSON; defaults to out/exterior_tasks_<listingId>_<modelId>.json')
    parser.add_argument('--max-tasks', type=int, choices=range(1, 11), default=8)
    parser.add_argument('--include-inferred-features', action='store_true', help='Include labeled MachineLearning/ComputerVision features')
    spatial = parser.add_mutually_exclusive_group()
    spatial.add_argument('--locate-vexcel', action='store_true', help='Query Vexcel parcel geometry and object detection for candidate feature positions')
    spatial.add_argument('--anchors-file', type=Path, help='Reviewed/detected anchors JSON with matching modelId and anchors keyed by task category')
    args = parser.parse_args(argv)
    try:
        listing, model_id = select_listing(args.kit_dir, listing_id=args.listing_id, property_id=args.property_id, model_id=args.model_id)
        feature_path = args.kit_dir / 'data/residential-listing-features.jsonl'
        features = next((row for row in read_jsonl(feature_path) if row.get('id') == listing['id']), None) if feature_path.exists() else None
        result = build_exterior_tasks(listing, model_id, features, max_tasks=args.max_tasks,
                                      include_inferred=args.include_inferred_features)
        if args.locate_vexcel:
            from exterior_spatial import locate_vexcel
            from vexcel import vexcel_key
            anchors, spatial_notes = locate_vexcel(result['facts']['longitude']['value'], result['facts']['latitude']['value'],
                                                  {point['category'] for point in result['points']}, vexcel_key())
            apply_spatial_anchors(result, anchors)
            result['notes'].extend(spatial_notes)
        elif args.anchors_file:
            anchor_data = json.loads(args.anchors_file.read_text(encoding='utf-8'))
            if anchor_data.get('modelId') != model_id or not isinstance(anchor_data.get('anchors'), dict):
                raise ValueError('Anchors file must contain the current modelId and an anchors object.')
            apply_spatial_anchors(result, anchor_data['anchors'])
        output = args.output or ROOT / 'out' / f'exterior_tasks_{listing["id"]}_{model_id}.json'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f'Unable to generate exterior tasks: {error}\n')
    print(f'Listing {listing["id"]} / model {model_id}: {len(result["tasks"])} sourced exterior tasks and quizzes')
    print(f'Wrote {output}')
    located = sum(point['placementStatus'] != 'unlocated' for point in result['points'])
    print(f'{located} feature locations; {len(result["points"]) - located} tasks remain in the property checklist.')
    print('Open this model in Vexcel and choose Import quiz JSON. Candidate locations need image review.')
    return 0


if __name__ == '__main__':
    main()
