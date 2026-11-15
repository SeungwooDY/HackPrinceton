#!/usr/bin/env python3
"""Copy the pinned official Matterport npm assets; never download at build time."""
import json
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = '@matterport/webcomponent'
REQUIRED = ('showcase.html', 'version.txt', 'js/showcase.js', 'css/showcase.css',
            'sdk/sdk-client.js', 'vendors/three/0.184.0/three.module.min.js')


def install_bundle(source, target):
    """Validate first, then replace the generated directory without mixing versions."""
    missing = [name for name in REQUIRED if not (source / name).is_file()]
    if missing:
        raise ValueError('Matterport npm package is missing required SDK assets: ' + ', '.join(missing))
    version = (source / 'version.txt').read_text(encoding='utf-8').strip()
    if not version:
        raise ValueError('Matterport npm package has an empty SDK version.')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.bundle-install-', dir=target.parent) as directory:
        staging = Path(directory) / 'new'
        backup = Path(directory) / 'previous'
        shutil.copytree(source, staging)
        if target.exists():
            target.rename(backup)
        try:
            staging.rename(target)
        except OSError:
            if backup.exists():
                backup.rename(target)
            raise
    return version


def main():
    package_dir = ROOT / 'node_modules' / PACKAGE
    metadata = package_dir / 'package.json'
    if not metadata.is_file():
        raise SystemExit('Matterport SDK dependency is missing. Run npm ci (or npm install), then npm run setup:bundle.')
    installed = json.loads(metadata.read_text(encoding='utf-8'))['version']
    project = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    pinned = project['devDependencies'][PACKAGE]
    if installed != pinned:
        raise SystemExit(f'Matterport SDK version mismatch: installed {installed}, expected {pinned}. Run npm ci.')
    version = install_bundle(package_dir / 'built-bundle', ROOT / 'public/bundle')
    print(f'Installed Matterport SDK {version} from {PACKAGE}@{installed} (local npm assets; no HTTP download).')


if __name__ == '__main__':
    main()
