#!/usr/bin/env python3
"""Install a pinned official Matterport Bundle SDK into public/bundle."""
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile

URL = 'https://static.matterport.com/showcase-sdk/bundle/26.5.4_webgl-708-g332adb66f5/showcase-bundle.zip'
ROOT = Path(__file__).resolve().parents[1]
# static.matterport.com returns 403 for the default Python urllib User-Agent
# (confirmed: identical request succeeds with a browser-like one instead).
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'


def main():
    target = ROOT / 'public/bundle'
    request = Request(URL, headers={'User-Agent': USER_AGENT})
    with urlopen(request, timeout=60) as response:
        archive = response.read(100 * 1024 * 1024 + 1)
    if len(archive) > 100 * 1024 * 1024:
        raise ValueError('SDK archive exceeds the download limit.')
    with ZipFile(BytesIO(archive)) as bundle:
        for entry in bundle.infolist():
            if not (target / entry.filename).resolve().is_relative_to(target.resolve()):
                raise ValueError('SDK archive contains an invalid path.')
        bundle.extractall(target)
    if not (target / 'showcase.html').is_file():
        raise ValueError('SDK archive is missing showcase.html.')
    print(f'Installed Matterport Bundle SDK into {target}')


if __name__ == '__main__':
    main()
