#!/usr/bin/env python3
"""Build compact server-only site metadata without uploading the CoStar kit."""
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from vexcel import model_sites


def main():
    sites = model_sites()
    if not sites:
        raise SystemExit('Restore the local CoStar kit before preparing deployment data.')
    target = ROOT / 'deployment/sites.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(sites, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'Prepared {len(sites)} model/site mappings. No credentials or contact records included.')


if __name__ == '__main__':
    main()
