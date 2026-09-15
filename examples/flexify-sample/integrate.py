#!/usr/bin/env python3
"""Apply only Debug Bridge startup, route capture and independent iOS signing."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile

sample = Path(__file__).resolve().parent
repo = sample.parent.parent
upstream = sample / 'upstream'
source = json.loads((sample / 'source.json').read_text())
parser = argparse.ArgumentParser()
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--team-id', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[A-Z0-9]{10}', args.team_id):
    raise SystemExit('team-id must be an Apple Team identifier')
report = sample / 'build/integration.json'
if report.exists():
    raise SystemExit('Integration already recorded; use a fresh pinned checkout')
if hashlib.sha256(args.archive.read_bytes()).hexdigest() != source['archiveSha256']:
    raise SystemExit('The source archive does not match source.json')

files = ['pubspec.yaml', 'lib/main.dart', 'ios/Runner.xcodeproj/project.pbxproj']
original = {}
with tarfile.open(args.archive) as archive:
    for name in files:
        member = f"Flexify-{source['commit']}/{name}"
        original[name] = archive.extractfile(member).read()
        if (upstream / name).read_bytes() != original[name]:
            raise SystemExit(f'Changed upstream input: {name}')

updated = {name: data.decode() for name, data in original.items()}

def replace(name, before, after, count=1):
    if updated[name].count(before) != count:
        raise SystemExit(f'Expected {count} exact integration anchors: {name}')
    updated[name] = updated[name].replace(before, after)

replace('pubspec.yaml', '\ndependencies:\n',
        '\ndependencies:\n  ai_app_bridge_flutter: 0.3.7\n')
replace('lib/main.dart', "import 'dart:async';", "import 'dart:async';\n\n"
        "import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';\n"
        "import 'package:flutter/foundation.dart';")
replace('lib/main.dart', '      WidgetsFlutterBinding.ensureInitialized();',
        "      WidgetsFlutterBinding.ensureInitialized();\n"
        "      if (kDebugMode) {\n"
        "        AiAppBridge.instance.initialize(appName: 'Flexify Bridge Sample');\n"
        "      }")
replace('lib/main.dart', "          title: 'Flexify',", "          title: 'Flexify',\n"
        "          navigatorObservers: [if (kDebugMode) AiAppBridge.instance.navigatorObserver],")
project = 'ios/Runner.xcodeproj/project.pbxproj'
replace(project, 'DEVELOPMENT_TEAM = CN8336593W;', f'DEVELOPMENT_TEAM = {args.team_id};', count=6)
replace(project, 'PRODUCT_BUNDLE_IDENTIFIER = com.presley.flexify;',
        f"PRODUCT_BUNDLE_IDENTIFIER = {source['iosBundleId']};", count=3)
replace(project, 'PRODUCT_BUNDLE_IDENTIFIER = com.presley.flexify.RunnerTests;',
        f"PRODUCT_BUNDLE_IDENTIFIER = {source['iosBundleId']}.RunnerTests;", count=3)

for name, text in updated.items():
    (upstream / name).write_text(text)
manifest = {'upstreamCommit': source['commit'], 'bundleId': source['iosBundleId'],
            'flutterVersion': source['flutterVersion'], 'teamId': args.team_id,
            'files': [{'path': name, 'beforeSha256': hashlib.sha256(original[name]).hexdigest(),
                       'afterSha256': hashlib.sha256(updated[name].encode()).hexdigest()} for name in files]}
report.parent.mkdir(exist_ok=True)
report.write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
