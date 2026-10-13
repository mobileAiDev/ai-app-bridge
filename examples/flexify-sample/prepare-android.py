#!/usr/bin/env python3
"""Integrate the current Bridge into a fresh, pinned Android Flexify checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

sample = Path(__file__).resolve().parent
repo = sample.parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--android-sdk', type=Path, required=True)
parser.add_argument('--flutter-sdk', type=Path, required=True)
parser.add_argument('--android-bridge-aar', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
spec = json.loads((sample / 'source.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
if args.output.exists():
    raise SystemExit('Choose a new integration report; existing results are retained.')
if sha(args.archive.read_bytes()) != spec['archiveSha256']:
    raise SystemExit('Archive does not match the pinned upstream hash.')
if not args.android_bridge_aar.is_file():
    raise SystemExit('Build the current Android SDK debug AAR before integrating this sample.')
files = ['pubspec.yaml', 'lib/main.dart', 'android/build.gradle', 'android/app/build.gradle']
original = {}
with tarfile.open(args.archive) as archive:
    for name in files:
        original[name] = archive.extractfile(f"Flexify-{spec['commit']}/{name}").read()
        if (args.source / name).read_bytes() != original[name]:
            raise SystemExit(f'Integration input is already modified: {name}')
updated = {name: data.decode() for name, data in original.items()}

def replace(name, before, after):
    if updated[name].count(before) != 1:
        raise SystemExit(f'Expected one integration anchor: {name}: {before}')
    updated[name] = updated[name].replace(before, after)

replace('pubspec.yaml', '\ndependencies:\n', '\ndependencies:\n  ai_app_bridge_flutter:\n    path: '
        + json.dumps(str(repo / 'flutter/ai_app_bridge_flutter')) + '\n')
replace('lib/main.dart', "import 'dart:async';", "import 'dart:async';\n"
        "import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';\n"
        "import 'package:flutter/foundation.dart';")
replace('lib/main.dart', '      WidgetsFlutterBinding.ensureInitialized();',
        "      WidgetsFlutterBinding.ensureInitialized();\n"
        "      if (kDebugMode) AiAppBridge.instance.initialize(appName: 'Flexify Bridge Sample');")
replace('lib/main.dart', "          title: 'Flexify',", "          title: 'Flexify',\n"
        "          navigatorObservers: [if (kDebugMode) AiAppBridge.instance.navigatorObserver],")
replace('android/build.gradle', "    project.evaluationDependsOn(':app')", "    project.evaluationDependsOn(':app')\n"
        "    configurations.configureEach {\n"
        "        exclude group: 'com.github.mobileAiDev.ai-app-bridge', module: 'ai-app-bridge-android'\n"
        "    }")
replace('android/app/build.gradle', 'dependencies {', 'dependencies {\n'
        '    debugImplementation files(' + json.dumps(str(args.android_bridge_aar.resolve())) + ')')
local = args.source / 'android/local.properties'
if local.exists():
    raise SystemExit('Fresh source must not already contain android/local.properties.')
for name, content in updated.items():
    (args.source / name).write_text(content)
local.write_text(f'sdk.dir={args.android_sdk.resolve()}\nflutter.sdk={args.flutter_sdk.resolve()}\n')
report = {'upstream': spec, 'sourceDirectory': str(args.source.resolve()),
          'packageName': 'com.presley.flexify.bridge_sample', 'variant': 'debug',
          'buildEnvironment': {'FLEXIFY_APP_ID_SUFFIX': '.bridge_sample', 'FLEXIFY_APP_LABEL': 'Flexify Bridge Sample'},
          'bridgeSdk': str(repo / 'flutter/ai_app_bridge_flutter'),
          'androidBridgeAar': {'path': str(args.android_bridge_aar.resolve()),
                               'sha256': sha(args.android_bridge_aar.read_bytes())},
          'files': [{'path': name, 'beforeSha256': sha(original[name]),
                     'afterSha256': sha(updated[name].encode())} for name in files],
          'localPropertiesSha256': sha(local.read_bytes()),
          'scope': 'Local Dart and Android Bridge dependencies, startup and navigator observer; workout and database behavior unchanged.'}
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
