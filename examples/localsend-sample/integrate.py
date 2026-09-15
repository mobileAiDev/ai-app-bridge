#!/usr/bin/env python3
"""Apply the Bridge-only debug integration to the frozen upstream checkout."""
from pathlib import Path
import hashlib
import json

sample = Path(__file__).resolve().parent
repo = sample.parent.parent
upstream = sample / 'upstream'

def replace(relative, before, after):
    target = upstream / relative
    source = target.read_text()
    if source.count(before) != 1:
        raise SystemExit(f'Expected one unchanged integration anchor: {relative}')
    target.write_text(source.replace(before, after))

replace('app/pubspec.yaml', '\ndependencies:\n',
        '\ndependencies:\n  ai_app_bridge_flutter: 0.3.7\n')
replace('app/lib/main.dart', "import 'package:flutter/material.dart';",
        "import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';\nimport 'package:flutter/material.dart';")
replace('app/lib/main.dart', '  runApp(\n',
        "  AiAppBridge.instance.initialize(appName: 'LocalSend Bridge Sample');\n  runApp(\n")
replace('app/lib/main.dart', '              title: t.appName,',
        '              title: t.appName,\n              navigatorObservers: [AiAppBridge.instance.navigatorObserver],')
replace('app/android/app/build.gradle', 'applicationIdSuffix ".debug"',
        'applicationIdSuffix ".bridge_sample"')

files = ['app/pubspec.yaml', 'app/lib/main.dart', 'app/android/app/build.gradle', 'app/android/build.gradle']
manifest = {
    'upstreamCommit': 'af0416be50770a97760f7070684bc667b759a15c',
    'packageName': 'org.localsend.localsend_app.bridge_sample',
    'flutterVersion': '3.41.9',
    'bridgeVersion': '0.3.7',
    'modifiedFiles': {f: hashlib.sha256((upstream / f).read_bytes()).hexdigest() for f in files},
}
(sample / 'build').mkdir(exist_ok=True)
(sample / 'build/integration.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
