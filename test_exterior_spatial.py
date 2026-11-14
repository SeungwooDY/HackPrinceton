import copy
import unittest
from unittest.mock import patch

from exterior_spatial import (contains, detection_anchors, interior_point, locate_vexcel,
                              lonlat_to_offset, roof_anchor, select_property, wkt_geometry)


def rectangle(x0, y0, x1, y1):
    return {'type': 'Polygon', 'coordinates': [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def feature(geometry, **props):
    return {'type': 'Feature', 'geometry': geometry, 'properties': props}


def parcel(date='2026-01-01', geometry=None):
    return feature(geometry or rectangle(-.0005, -.0005, .0005, .0005), **{
        'metadata.is-ortho-image': True, 'parcel-source': 'real', 'metadata.collection': 'test-2026',
        'metadata.ortho-date-estimate': date,
        'structure.1.footprint.geometry': 'POLYGON((-.0001 -.0001,.0001 -.0001,.0001 .0001,-.0001 .0001,-.0001 -.0001))',
        'structure.1.primary-structure': True,
    })


class SpatialTests(unittest.TestCase):
    def test_wkt_and_interior_point_handle_holes_and_concavity(self):
        geometry = wkt_geometry('POLYGON((0 0,3 0,3 1,1 1,1 3,0 3,0 0))')
        point = interior_point(geometry)
        self.assertTrue(contains(geometry, point))
        self.assertFalse(contains(geometry, (2, 2)))
        multi = wkt_geometry('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)))')
        self.assertTrue(contains(multi, (.5, .5)))
        with_hole = wkt_geometry('POLYGON((0 0,3 0,3 3,0 3,0 0),(1 1,2 1,2 2,1 2,1 1))')
        self.assertFalse(contains(with_hole, (1.5, 1.5)))
        self.assertTrue(contains(with_hole, interior_point(with_hole)))
        self.assertIsNone(wkt_geometry('POINT(1 2)'))
        self.assertIsNone(wkt_geometry('POLYGON((0 0 3,1 1 4,2 0 3))'))

    def test_geographic_offsets_preserve_direction_and_latitude_scale(self):
        equator = lonlat_to_offset(.001, .001, 0, 0)
        north = lonlat_to_offset(.001, 60.001, 0, 60)
        self.assertAlmostEqual(equator['east'], 111.31949, places=4)
        self.assertAlmostEqual(north['east'], equator['east'] / 2, places=4)
        self.assertGreater(north['north'], 0)

    def test_capture_selection_uses_date_and_parcel_containment(self):
        old, new = parcel('2022-01-01'), parcel('2026-01-01')
        neighbor = parcel('2027-01-01', rectangle(.001, .001, .002, .002))
        self.assertEqual(select_property({'features': [old, neighbor, new]}, 0, 0), new)
        fake = copy.deepcopy(new)
        fake['properties']['parcel-source'] = 'inferred'
        self.assertIsNone(select_property({'features': [fake]}, 0, 0))
        oblique = copy.deepcopy(new)
        oblique['properties']['metadata.is-ortho-image'] = False
        self.assertIsNone(select_property({'features': [oblique]}, 0, 0))
        self.assertIsNone(select_property({'features': [parcel('unknown')]}, 0, 0))
        conflicting = parcel('2026-01-01', rectangle(-.0003, -.0003, .0003, .0003))
        self.assertIsNone(select_property({'features': [new, conflicting]}, 0, 0))

    def test_roof_uses_subject_footprint_not_neighbor(self):
        anchor = roof_anchor(parcel(), 0, 0)
        self.assertEqual(anchor['east'], 0)
        self.assertEqual(anchor['status'], 'candidate')
        neighbor = parcel()
        neighbor['properties']['structure.1.footprint.geometry'] = 'POLYGON((1 1,2 1,2 2,1 2,1 1))'
        self.assertIsNone(roof_anchor(neighbor, 0, 0))

    def test_detection_requires_confidence_ownership_and_unambiguous_match(self):
        polygon = parcel()['geometry']
        good = feature(rectangle(.0001, .0001, .0002, .0002), label='driveway', confidence=.85)
        low = feature(rectangle(0, 0, .0001, .0001), label='garage', confidence=.3)
        neighbor = feature(rectangle(.001, .001, .0012, .0012), label='garage', confidence=.99)
        whole_block = feature(rectangle(-.002, -.002, .002, .002), label='garage', confidence=.99)
        anchors = detection_anchors({'features': [good, low, neighbor, whole_block]}, polygon, 0, 0, {'driveway': 'access', 'garage': 'garage'})
        self.assertEqual(set(anchors), {'access'})
        ambiguous = detection_anchors({'features': [good, good]}, polygon, 0, 0, {'driveway': 'access'})
        self.assertEqual(ambiguous, {})

    @patch('exterior_spatial.request_json')
    def test_lookup_builds_documented_request_and_scopes_results(self, request):
        request.side_effect = [{'features': [parcel()]}, {'features': [feature(rectangle(.0001, .0001, .0002, .0002), label='driveway', confidence=.85)]}]
        anchors, notes = locate_vexcel(0, 0, {'roof', 'access', 'fencing', 'unknowns'}, 'fixture-key')
        self.assertEqual(set(anchors), {'roof', 'access'})
        self.assertEqual(notes, [])
        body = request.call_args.kwargs['body']
        self.assertEqual(body['images'][0]['endpoint'], 'ortho/extract')
        self.assertEqual(body['images'][0]['request']['collection'], 'test-2026')
        self.assertEqual(body['model-input']['elements'][0]['label'], 'driveway')

    @patch('exterior_spatial.request_json')
    def test_missing_parcel_does_not_fall_back_to_random_coordinates(self, request):
        request.return_value = {'features': []}
        anchors, notes = locate_vexcel(0, 0, {'roof', 'garage'}, 'fixture-key')
        self.assertEqual(anchors, {})
        self.assertTrue(notes)
        self.assertEqual(request.call_count, 1)

    @patch('exterior_spatial.request_json')
    def test_detection_failure_keeps_roof_and_unlocated_tasks(self, request):
        request.side_effect = [{'features': [parcel()]}, ValueError('Detector unavailable')]
        anchors, notes = locate_vexcel(0, 0, {'roof', 'garage'}, 'fixture-key')
        self.assertEqual(set(anchors), {'roof'})
        self.assertIn('Detector unavailable', notes)


if __name__ == '__main__':
    unittest.main()
