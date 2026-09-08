#!/usr/bin/env python3
"""Apply the Bridge-only debug integration to the frozen upstream checkout."""
from pathlib import Path
import hashlib
import json

sample = Path(__file__).resolve().parent
repo = sample.parent.parent
upstream = sample / 'upstream'
aar = repo / 'android/ai-app-bridge-android/build/outputs/aar/ai-app-bridge-android-debug.aar'
if not aar.is_file():
    raise SystemExit('Build :ai-app-bridge-android:assembleDebug before integration')

def replace(relative, before, after):
    target = upstream / relative
    source = target.read_text()
    if source.count(before) != 1:
        raise SystemExit(f'Expected one unchanged integration anchor: {relative}')
    target.write_text(source.replace(before, after))

replace('app/pubspec.yaml', '\ndependencies:\n',
        '\ndependencies:\n  ai_app_bridge_flutter:\n    path: ../../../../flutter/ai_app_bridge_flutter\n')
replace('app/lib/main.dart', "import 'package:flutter/material.dart';",
        "import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';\nimport 'package:flutter/material.dart';")
replace('app/lib/main.dart', '  runApp(\n',
        "  AiAppBridge.instance.initialize(appName: 'LocalSend Bridge Sample');\n  runApp(\n")
replace('app/lib/main.dart', '              title: t.appName,',
        '              title: t.appName,\n              navigatorObservers: [AiAppBridge.instance.navigatorObserver],')
replace('app/android/app/build.gradle', 'applicationIdSuffix ".debug"',
        'applicationIdSuffix ".bridge_sample"')

# Explicit sample-only substitution. It must not silently resolve the published
# 0.2.8 runtime while validating the working tree's Android SDK.
replace('app/android/build.gradle', 'allprojects {\n',
        "allprojects {\n    configurations.configureEach {\n"
        "        exclude group: 'com.github.mobileAiDev.ai-app-bridge', module: 'ai-app-bridge-android'\n"
        "    }\n")
replace('app/android/app/build.gradle', "flutter {\n",
        "dependencies {\n    debugImplementation files('../../../../../../android/ai-app-bridge-android/build/outputs/aar/ai-app-bridge-android-debug.aar')\n}\n\nflutter {\n")

files = ['app/pubspec.yaml', 'app/lib/main.dart', 'app/android/app/build.gradle', 'app/android/build.gradle']
manifest = {
    'upstreamCommit': 'af0416be50770a97760f7070684bc667b759a15c',
    'packageName': 'org.localsend.localsend_app.bridge_sample',
    'flutterVersion': '3.41.9',
    'androidAarSha256': hashlib.sha256(aar.read_bytes()).hexdigest(),
    'modifiedFiles': {f: hashlib.sha256((upstream / f).read_bytes()).hexdigest() for f in files},
}
(sample / 'build').mkdir(exist_ok=True)
(sample / 'build/integration.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
