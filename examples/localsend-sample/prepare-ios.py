#!/usr/bin/env python3
"""Give the pinned LocalSend Debug app independent iOS bundle identifiers.

Signing identity is supplied to xcodebuild. Upstream entitlements and business
behavior are preserved; unsupported signing capabilities must be reported.
"""
from pathlib import Path
import hashlib
import json
import re

sample = Path(__file__).resolve().parent
project = sample / 'upstream/app/ios/Runner.xcodeproj/project.pbxproj'
source = project.read_text()
identifiers = {
    'org.localsend.localsendApp': 'io.github.mobileaidev.localsend.sample',
    'org.localsend.localsendApp.ShareExtension': 'io.github.mobileaidev.localsend.sample.ShareExtension',
}
changed = []


def configure(match):
    block = match.group(0)
    for original, target in identifiers.items():
        before = f'PRODUCT_BUNDLE_IDENTIFIER = {original};'
        if before in block:
            changed.append(target)
            return block.replace(before, f'PRODUCT_BUNDLE_IDENTIFIER = {target};')
    return block


updated = re.sub(r'[A-F0-9]+ /\* Debug \*/ = \{.*?\n\t\t\};', configure, source, flags=re.S)
if sorted(changed) != sorted(identifiers.values()):
    raise SystemExit('Expected the two unchanged upstream Debug bundle identifiers; no files were changed')
manifest = {
    'bundleId': identifiers['org.localsend.localsendApp'],
    'shareExtensionBundleId': identifiers['org.localsend.localsendApp.ShareExtension'],
    'upstreamCommit': json.loads((sample / 'source.json').read_text())['commit'],
    'projectBeforeSha256': hashlib.sha256(source.encode()).hexdigest(),
    'projectAfterSha256': hashlib.sha256(updated.encode()).hexdigest(),
    'scope': 'Debug bundle identifiers only; upstream entitlements and business source unchanged',
}
output = sample / 'build/ios-integration.json'
output.parent.mkdir(exist_ok=True)
with output.open('x') as file:
    file.write(json.dumps(manifest, indent=2) + '\n')
project.write_text(updated)
print(json.dumps(manifest, indent=2))
