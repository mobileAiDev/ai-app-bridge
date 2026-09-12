#!/usr/bin/env python3
"""Integrate Bridge into the pinned VLC debug build without business source edits."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

sample = Path(__file__).resolve().parent
repo = sample.parent.parent
upstream = sample / "upstream"
source = json.loads((sample / "source.json").read_text())
aar = repo / "android/ai-app-bridge-android/build/outputs/aar/ai-app-bridge-android-debug.aar"


def git(*args):
    return subprocess.check_output(["git", "-C", str(upstream), *args], text=True).strip()


status = git("status", "--porcelain").splitlines()
if git("rev-parse", "HEAD") != source["commit"] or any(line != "?? application/remote-access-client/remoteaccess/" for line in status):
    raise SystemExit("Requires the pinned clean upstream checkout; existing edits are not reset")
for directory, commit in [("libvlcjni", source["libvlcCommit"]), ("application/remote-access-client/remoteaccess", source["remoteAccessCommit"])]:
    actual = subprocess.check_output(["git", "-C", str(upstream / directory), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(upstream / directory), "status", "--porcelain"], text=True).strip()
    if actual != commit or dirty:
        raise SystemExit("Requires pinned clean bootstrap source: " + directory)
if not aar.is_file():
    raise SystemExit("Build :ai-app-bridge-android:assembleDebug first")
changes = {}


def replace(file, before, after):
    original = changes.get(file, (upstream / file).read_text())
    if original.count(before) != 1:
        raise SystemExit("Expected exactly one integration anchor: " + file)
    changes[file] = original.replace(before, after)


plugin = os.path.relpath(repo / "android/ai-app-bridge-gradle-plugin", upstream)
runtime = os.path.relpath(aar, upstream / "application/app")
replace("settings.gradle", "pluginManagement {\n", f"pluginManagement {{\n    includeBuild('{plugin}')\n")
replace("build.gradle", '    appId = "org.videolan.vlc"', '    appId = "org.videolan.vlc.bridge_sample"')
replace("application/app/build.gradle", "plugins {\n", "plugins {\n    id 'io.github.mobileaidev.aiappbridge.android'\n")
replace("application/app/build.gradle", "    androidComponents {\n", "    androidComponents {\n        beforeVariants(selector().withBuildType(\"debug\")) { variantBuilder ->\n            variantBuilder.minSdk = 19\n        }\n")
replace("application/app/build.gradle", "\ndependencies {\n", f"\naiAppBridge {{\n    setOkHttpCaptureEnabled(true)\n}}\n\ndependencies {{\n    debugImplementation files('{runtime}')\n")

for relative, content in changes.items():
    (upstream / relative).write_text(content)
manifest = {
    "upstreamCommit": source["commit"], "packageName": source["packageName"],
    "libvlcCommit": source["libvlcCommit"], "remoteAccessCommit": source["remoteAccessCommit"],
    "androidAarSha256": hashlib.sha256(aar.read_bytes()).hexdigest(),
    "modifiedFiles": {name: hashlib.sha256((upstream / name).read_bytes()).hexdigest() for name in changes},
    "scope": "Isolated package identity, debug SDK/plugin and debug minSdk 19 required by Bridge; no VLC business source changes.",
}
(sample / "build").mkdir(exist_ok=True)
with (sample / "build/integration.json").open("x") as output:
    json.dump(manifest, output, indent=2)
    output.write("\n")
print(json.dumps(manifest, indent=2))
