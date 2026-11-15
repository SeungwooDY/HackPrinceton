"""Vercel Function adapter for the local Python API."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from serve import Handler, sdk_key

ROUTES = {'config': '/config.json', 'quiz': '/api/quiz', 'plan': '/api/plan',
          'aerial-site': '/api/aerial/site', 'aerial-image': '/api/aerial/image', 'health': '/api/health'}


def normalize_path(path):
    parsed = urlsplit(path)
    query = parse_qs(parsed.query)
    alias = query.pop('__route', [None])[0]
    target = ROUTES.get(alias) if alias else parsed.path
    if target not in ROUTES.values():
        raise ValueError('Unknown API endpoint.')
    if target not in ('/config.json', '/api/health') and not re.fullmatch(r'[A-Za-z0-9]{11}', query.get('model', [''])[0]):
        raise ValueError('A valid 11-character model query parameter is required.')
    return target + ('?' + urlencode(query, doseq=True) if query else '')


class handler(Handler):
    def do_GET(self):
        try:
            self.path = normalize_path(self.path)
        except ValueError as error:
            self.respond(400, 'application/json', json.dumps({'error': str(error)}).encode())
            return
        path = urlsplit(self.path).path
        if path == '/api/health':
            from vexcel import model_sites, vexcel_key
            self.respond(200, 'application/json', json.dumps({'ok': True, 'sdkConfigured': bool(sdk_key()),
                'aerialConfigured': bool(vexcel_key()), 'mappedModels': len(model_sites())}).encode())
            return
        if path == '/config.json':
            key = sdk_key()
            if not key:
                self.respond(503, 'application/json', json.dumps({'error': 'Set MATTER_PORT_SDK_KEY in Vercel Environment Variables and redeploy.'}).encode())
            else:
                # The Vercel build installs these assets; the function deliberately
                # excludes static files from its own deployment package.
                self.respond(200, 'application/json', json.dumps({'matterportSdkKey': key, 'matterportBundleUrl': '/bundle/showcase.html'}).encode())
            return
        super().do_GET()
