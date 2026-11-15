import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.setup_matterport_bundle import REQUIRED, install_bundle


class BundleSetupTests(unittest.TestCase):
    def package(self, path):
        for name in REQUIRED:
            file = path / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('fixture-version' if name == 'version.txt' else 'fixture SDK asset')

    def test_fresh_install_works_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'package/built-bundle', root / 'public/bundle'
            self.package(source)
            with patch('urllib.request.urlopen', side_effect=AssertionError('No build-time download allowed')):
                self.assertEqual(install_bundle(source, target), 'fixture-version')
            self.assertTrue(all((target / name).is_file() for name in REQUIRED))

    def test_replacement_removes_stale_assets_from_old_sdk(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'package', root / 'bundle'
            self.package(source)
            target.mkdir()
            (target / 'old-chunk.js').write_text('old release')
            install_bundle(source, target)
            self.assertFalse((target / 'old-chunk.js').exists())
            self.assertEqual((target / 'showcase.html').read_text(), 'fixture SDK asset')

    def test_invalid_package_does_not_destroy_existing_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'package', root / 'bundle'
            self.package(source)
            (source / 'showcase.html').unlink()
            target.mkdir()
            (target / 'keep.txt').write_text('existing SDK')
            with self.assertRaisesRegex(ValueError, 'showcase.html'):
                install_bundle(source, target)
            self.assertEqual((target / 'keep.txt').read_text(), 'existing SDK')


if __name__ == '__main__':
    unittest.main()
