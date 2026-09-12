#!/usr/bin/env python3
"""Add Bridge to an isolated Organic Maps build, preserving business sources."""
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
manifest_path = sample / "build/integration.json"


def git(*args):
    return subprocess.check_output(["git", "-C", str(upstream), *args], text=True).strip()


if git("rev-parse", "HEAD") != source["commit"] or git("status", "--porcelain"):
    raise SystemExit("Requires the pinned clean upstream checkout; existing edits are not reset")
submodules = subprocess.check_output(
    ["git", "-C", str(upstream), "submodule", "status", "--recursive"], text=True
).splitlines()
if not submodules or any(line[0] != " " for line in submodules):
    raise SystemExit("Initialize all submodules at their pinned commits before integration")
version = subprocess.check_output(
    ["bash", "tools/unix/version.sh", "android_name"], cwd=upstream, text=True
).strip()
if version != source["versionName"]:
    raise SystemExit("Deepen the shallow checkout until version.sh reports " + source["versionName"])
if not aar.is_file():
    raise SystemExit("Build :ai-app-bridge-android:assembleDebug first")
if manifest_path.exists():
    raise SystemExit("Integration manifest already exists; preserve the earlier build evidence")
changes = {}


def replace(relative, before, after):
    original = changes.get(relative, (upstream / relative).read_text())
    if original.count(before) != 1:
        raise SystemExit("Expected exactly one integration anchor: " + relative)
    changes[relative] = original.replace(before, after)


plugin = os.path.relpath(repo / "android/ai-app-bridge-gradle-plugin", upstream / "android")
runtime = os.path.relpath(aar, upstream / "android/app")
replace("android/settings.gradle", "pluginManagement {\n", f"pluginManagement {{\n  includeBuild('{plugin}')\n")
replace("android/build.gradle", "  appId = 'app.organicmaps'", "  appId = 'app.organicmaps.bridge_sample'")
replace("android/app/build.gradle", "// Detect flavors from the task name.\n", "plugins {\n  id 'io.github.mobileaidev.aiappbridge.android'\n}\n\n// Detect flavors from the task name.\n")
replace("android/app/build.gradle", "\ndependencies {\n", f"\naiAppBridge {{\n  setOkHttpCaptureEnabled(true)\n}}\n\ndependencies {{\n  debugImplementation files('{runtime}')\n")
replace("android/app/build.gradle", r"app\.organicmaps(\.web)?", r"app\.organicmaps\.bridge_sample(\.web)?")
replace("android/gradle/wrapper/gradle-wrapper.properties", "validateDistributionUrl=true\n", "validateDistributionUrl=true\ndistributionSha256Sum=" + source["toolchain"]["gradleSha256"] + "\n")

for relative, content in changes.items():
    (upstream / relative).write_text(content)
manifest = {
    "upstreamCommit": source["commit"],
    "upstreamVersionName": version,
    "packageName": source["packageName"],
    "androidAarSha256": hashlib.sha256(aar.read_bytes()).hexdigest(),
    "submodules": [{"commit": line[1:].split()[0], "path": line[1:].split()[1]} for line in submodules],
    "modifiedFiles": {name: hashlib.sha256((upstream / name).read_bytes()).hexdigest() for name in changes},
    "scope": "Isolated package identity, debug SDK/plugin and official Gradle checksum; no business source changes.",
}
manifest_path.parent.mkdir(exist_ok=True)
with manifest_path.open("x") as output:
    json.dump(manifest, output, indent=2)
    output.write("\n")
print(json.dumps({key: value for key, value in manifest.items() if key != "submodules"}, indent=2))
