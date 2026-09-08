#!/usr/bin/env python3
"""Read LocalSend's persisted settings independently of Bridge and Script."""
import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True, choices=['FYZLAU49X8OVQGJ7', 'b46093e6'])
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--compare', type=Path)
args = parser.parse_args()
package = 'org.localsend.localsend_app.bridge_sample'
raw = subprocess.run(['adb', '-s', args.serial, 'exec-out', 'run-as', package,
                      'cat', 'shared_prefs/FlutterSharedPreferences.xml'], check=True, capture_output=True).stdout
settings = {}
for node in ET.fromstring(raw):
    name = node.attrib['name']
    if name in {'flutter.ls_theme', 'flutter.ls_locale', 'flutter.ls_color',
                'flutter.ls_custom_color', 'flutter.ls_destination'}:
        if node.tag != 'string':
            raise SystemExit('Unexpected stored setting type: ' + name)
        settings[name] = node.text
result = {'schemaVersion': 'localsend.settings-oracle/v1', 'serial': args.serial, 'packageName': package,
          'capturedAt': datetime.now(timezone.utc).isoformat(), 'settings': settings,
          'source': 'run-as read of FlutterSharedPreferences.xml; allowlisted settings only'}
if args.compare:
    baseline = json.loads(args.compare.read_text())
    if baseline['serial'] != args.serial or baseline['packageName'] != package:
        raise SystemExit('Baseline target mismatch')
    result['equal'] = settings == baseline['settings']
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result.get('equal') is False:
    raise SystemExit(1)
