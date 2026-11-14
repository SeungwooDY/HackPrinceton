"""Offline fixture tests for the residential exterior generator."""
import copy
import csv
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from generate_exterior_tasks import apply_spatial_anchors, build_exterior_tasks, gather_facts, main, select_listing

MODEL = 'Ki9YdfpNKum'
LISTING = {
    'id': 101, 'residentialListingId': 999, 'propertyId': 5001, 'listDate': '2026-01-01',
    'property': {'address': {'latitude': 29.8, 'longitude': -95.2, 'fullStreetAddress': 'Fixture home'},
                 'lotSizeAcresMin': 0.25, 'yearBuilt': 1990, 'totalParkingSpaces': 2},
    'resoValues': {'structure': {'stories': 2, 'garageSpaces': 1}},
}
FEATURES = {
    'id': 101,
    'features': [
        {'id': 1, 'name': 'Detached Garage', 'source': 'Mls'},
        {'id': 2, 'name': 'Back Yard Fenced', 'source': 'Mls'},
        {'id': 3, 'name': 'Private Pool', 'source': 'Mls', 'boolValue': False},
        {'id': 4, 'name': 'Community Pool', 'source': 'Mls'},
        {'id': 5, 'name': 'Composition Roof', 'source': 'MachineLearning'},
        {'id': 6, 'name': 'Brick Exterior Construction', 'source': 'Mls'},
        {'id': 7, 'name': 'Sprinkler System', 'source': 'Mls'},
        {'id': 8, 'name': 'Driveway', 'source': 'Mls'},
    ],
}


class ExteriorTasksTests(unittest.TestCase):
    def test_feature_values_and_provenance(self):
        facts, groups = gather_facts(LISTING, FEATURES)
        self.assertNotIn('private-pool', groups)
        self.assertNotIn('roof', groups)
        self.assertIn('community-pool', groups)
        self.assertEqual(facts['feature-0']['path'], 'features[0].name')
        self.assertEqual(facts['feature-0']['recordId'], LISTING['id'])
        self.assertEqual(facts['feature-0']['origin'], 'Mls')
        self.assertEqual(facts['feature-0']['featureId'], 1)
        self.assertNotIn('Sprinkler System', [fact['value'] for fact in facts.values()])
        inferred_facts, inferred_groups = gather_facts(LISTING, FEATURES, include_inferred=True)
        self.assertIn('roof', inferred_groups)
        self.assertEqual(inferred_facts['feature-4']['origin'], 'MachineLearning')

    def test_deterministic_tasks_have_real_refs_and_no_guessed_positions(self):
        result = build_exterior_tasks(LISTING, MODEL, FEATURES)
        self.assertEqual(result, build_exterior_tasks(LISTING, MODEL, FEATURES))
        self.assertEqual(len({p['id'] for p in result['points']}), len(result['points']))
        for task, point in zip(result['tasks'], result['points']):
            self.assertEqual(task['id'], point['id'])
            self.assertTrue(set(task['refs']['factIds']) <= result['facts'].keys())
            self.assertEqual(point['evidence'], [result['facts'][key] for key in task['refs']['factIds']])
            self.assertIsNone(task['location']['featureCoordinates'])
            self.assertEqual(point['placementStatus'], 'unlocated')
            self.assertIsNone(point['east'])
            self.assertIsNone(point['north'])
            self.assertLessEqual(len(point['quiz']['question']), 300)
            self.assertTrue(all(len(option) <= 150 for option in point['quiz']['options']))
        self.assertNotIn('private-pool', ' '.join(t['id'] for t in result['tasks']))
        self.assertIn('community-pool', ' '.join(t['id'] for t in result['tasks']))

    def test_missing_feature_file_still_produces_sourced_overview_and_unknowns(self):
        result = build_exterior_tasks(LISTING, MODEL)
        self.assertEqual(len(result['tasks']), 2)
        self.assertTrue(any('No feature record' in note for note in result['notes']))
        self.assertTrue(any('Hydrant' in item for item in result['unknowns']))

    def test_missing_and_invalid_numbers_are_not_invented(self):
        listing = copy.deepcopy(LISTING)
        listing['resoValues'] = {'structure': {'stories': True}}
        listing['property'] = {'address': LISTING['property']['address']}
        result = build_exterior_tasks(listing, MODEL)
        self.assertEqual(len(result['tasks']), 1)
        self.assertNotIn('stories', result['facts'])
        self.assertIn('stories', result['unknowns'])

    def test_explicit_zero_parking_is_retained(self):
        listing = copy.deepcopy(LISTING)
        listing['property']['totalParkingSpaces'] = 0
        listing['resoValues']['structure']['garageSpaces'] = 0
        facts, _ = gather_facts(listing)
        self.assertEqual(facts['parkingSpaces']['value'], 0)
        self.assertEqual(facts['garageSpaces']['value'], 0)

    def test_derived_fallback_retains_its_source(self):
        listing = copy.deepcopy(LISTING)
        del listing['resoValues']['structure']['stories']
        features = {'id': 101, 'derivedValues': {'numberOfStories': 3}}
        facts, _ = gather_facts(listing, features)
        self.assertEqual(facts['stories']['value'], 3)
        self.assertEqual(facts['stories']['path'], 'derivedValues.numberOfStories')
        self.assertEqual(facts['stories']['origin'], 'Derived')

    def test_only_explicit_anchors_create_pins(self):
        result = build_exterior_tasks(LISTING, MODEL, FEATURES)
        apply_spatial_anchors(result, {'garage': {'east': 4, 'north': 12, 'status': 'reviewed', 'source': 'Reviewed aerial image'}})
        located = [p for p in result['points'] if p['placementStatus'] != 'unlocated']
        self.assertEqual(len(located), 1)
        self.assertEqual(located[0]['category'], 'garage')
        self.assertEqual(located[0]['east'], 4)
        with self.assertRaises(ValueError):
            apply_spatial_anchors(result, {'garage': {'east': 999, 'north': 0, 'status': 'reviewed', 'source': 'Bad anchor'}})

    def test_bad_join_coordinates_and_task_limit_rejected(self):
        with self.assertRaisesRegex(ValueError, 'listing id'):
            build_exterior_tasks(LISTING, MODEL, {'id': 5001})
        listing = copy.deepcopy(LISTING)
        listing['property']['address']['latitude'] = float('nan')
        with self.assertRaisesRegex(ValueError, 'coordinates'):
            build_exterior_tasks(listing, MODEL)
        with self.assertRaisesRegex(ValueError, 'between 1 and 10'):
            build_exterior_tasks(LISTING, MODEL, max_tasks=11)

    def make_kit(self, path):
        (path / 'data').mkdir()
        later = {**LISTING, 'id': 102, 'listDate': '2026-02-01'}
        (path / 'data/residential-listings.jsonl').write_text('\n'.join(json.dumps(r) for r in [LISTING, later]))
        with (path / 'residential-listings.csv').open('w', newline='') as source:
            writer = csv.DictWriter(source, fieldnames=['ListingId', 'ResidentialListingId', 'MatterportModelId'])
            writer.writeheader()
            writer.writerows([{'ListingId': r['id'], 'ResidentialListingId': r['residentialListingId'], 'MatterportModelId': MODEL} for r in [LISTING, later]])

    def test_selection_uses_listing_id_and_newest_matching_listing(self):
        with tempfile.TemporaryDirectory() as directory:
            kit = Path(directory)
            self.make_kit(kit)
            self.assertEqual(select_listing(kit)[0]['id'], 101)
            self.assertEqual(select_listing(kit, property_id=5001)[0]['id'], 102)
            self.assertEqual(select_listing(kit, listing_id=101)[0]['id'], 101)
            with self.assertRaisesRegex(ValueError, 'ListingId'):
                select_listing(kit, listing_id=999)
            with self.assertRaises(ValueError):
                select_listing(kit, listing_id=101, model_id='WrongModel1')

    def test_cli_output_is_accepted_by_actual_vexcel_importer_with_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            kit = Path(directory)
            self.make_kit(kit)
            (kit / 'data/residential-listing-features.jsonl').write_text(json.dumps(FEATURES))
            output = kit / 'output.json'
            self.assertEqual(main(['--kit-dir', str(kit), '--listing-id', '101', '--output', str(output)]), 0)
            script = """
import { readFileSync } from 'node:fs';
import { parseAerialQuizFile } from './src/aerialQuiz.js';
const data = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const points = parseAerialQuizFile(JSON.stringify(data), data.modelId);
if (points.length !== data.tasks.length) throw Error('task count changed');
for (let i = 0; i < points.length; i++) {
  if (JSON.stringify(points[i].evidence) !== JSON.stringify(data.points[i].evidence)) throw Error('evidence lost');
  if (points[i].placementNote !== data.points[i].placementNote) throw Error('placement note lost');
}
"""
            subprocess.run(['node', '--input-type=module', '-e', script, str(output)],
                           cwd=Path(__file__).resolve().parent, check=True, capture_output=True, text=True)


if __name__ == '__main__':
    unittest.main()
