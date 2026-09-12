#!/usr/bin/env python3
"""Apply debug-only Bridge integration to the exact clean Wikipedia source."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

sample = Path(__file__).resolve().parent
repo = sample.parent.parent
upstream = sample / 'upstream'
source = json.loads((sample / 'source.json').read_text())
aar = repo / 'android/ai-app-bridge-android/build/outputs/aar/ai-app-bridge-android-debug.aar'
if not aar.is_file():
    raise SystemExit('Build :ai-app-bridge-android:assembleDebug first')


def git(*args):
    return subprocess.check_output(['git', '-C', str(upstream), *args], text=True).strip()


if git('rev-parse', 'HEAD') != source['commit'] or git('status', '--porcelain'):
    raise SystemExit('Requires the pinned, clean upstream checkout; no automatic reset or reapplication')

changes = {}


def replace(relative, before, after):
    original = changes.get(relative, (upstream / relative).read_text())
    if original.count(before) != 1:
        raise SystemExit('Expected one unchanged integration anchor: ' + relative)
    changes[relative] = original.replace(before, after)


plugin = os.path.relpath(repo / 'android/ai-app-bridge-gradle-plugin', upstream)
runtime = os.path.relpath(aar, upstream / 'app')
replace('settings.gradle.kts', 'pluginManagement {\n',
        'pluginManagement {\n    includeBuild("' + plugin + '")\n')
replace('app/build.gradle', 'plugins {\n',
        "plugins {\n    id 'io.github.mobileaidev.aiappbridge.android'\n")
replace('app/build.gradle', '        debug {\n            minifyEnabled false',
        "        debug {\n            applicationIdSuffix '.bridge_sample'\n            minifyEnabled false")
replace('app/build.gradle', '\ndependencies {\n',
        "\naiAppBridge {\n    setOkHttpCaptureEnabled(true)\n}\n\ndependencies {\n"
        "    debugImplementation files('" + runtime + "')\n")

# The upstream Google Services task requires an exact application ID. Reuse its
# public dev configuration in this debug variant, changing only the package ID.
google = json.loads((upstream / 'app/google-services.json').read_text())
clients = [client for client in google['client']
           if client['client_info']['android_client_info']['package_name'] == 'org.wikipedia.dev']
if len(clients) != 1:
    raise SystemExit('Requires one upstream dev Google Services client')
clients[0]['client_info']['android_client_info']['package_name'] = source['packageName']
google['client'] = clients
google_path = 'app/src/devDebug/google-services.json'
if (upstream / google_path).exists():
    raise SystemExit('Refuse to replace an existing debug Google Services configuration')
changes[google_path] = json.dumps(google, indent=2) + '\n'

for relative, value in changes.items():
    target = upstream / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value)

manifest = {
    'upstreamCommit': source['commit'], 'packageName': source['packageName'],
    'androidAarSha256': hashlib.sha256(aar.read_bytes()).hexdigest(),
    'modifiedFiles': {name: hashlib.sha256((upstream / name).read_bytes()).hexdigest()
                      for name in changes},
    'scope': 'Debug runtime, debug OkHttp instrumentation and isolated package identity; no business source edits.',
}
(sample / 'build').mkdir(exist_ok=True)
with (sample / 'build/integration.json').open('x') as output:
    json.dump(manifest, output, indent=2)
    output.write('\n')
print(json.dumps(manifest, indent=2))
