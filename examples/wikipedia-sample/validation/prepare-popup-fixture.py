#!/usr/bin/env python3
"""Restore only the one-time tooltip flag in the isolated Wikipedia test package."""

import argparse
import hashlib
import json
import shlex
import subprocess
import xml.etree.ElementTree as ET

PACKAGE = "org.wikipedia.dev.bridge_sample"
FILE = f"shared_prefs/{PACKAGE}_preferences.xml"
KEY = "showCustomizeToolbarTooltip"


def prepare(serial):
    def adb(*args, **kwargs):
        return subprocess.check_output(["adb", "-s", serial, *args], timeout=20, **kwargs)

    adb("shell", "am", "force-stop", PACKAGE)
    original = adb("exec-out", "run-as", PACKAGE, "cat", FILE)
    root = ET.fromstring(original)
    selected = [element for element in root if element.get("name") == KEY]
    if len(selected) > 1 or any(element.tag != "boolean" for element in selected):
        raise ValueError("Invalid tooltip preference")
    unchanged = {e.get("name"): ET.tostring(e).strip() for e in root if e.get("name") != KEY}
    previous = selected[0].get("value") if selected else None
    if selected:
        selected[0].set("value", "true")
    else:
        ET.SubElement(root, "boolean", {"name": KEY, "value": "true"})
    replacement = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    adb("shell", "-T", "run-as", PACKAGE, "sh", "-c", shlex.quote(f"cat > {FILE}.bridge-fixture"), input=replacement)
    adb("shell", "run-as", PACKAGE, "mv", f"{FILE}.bridge-fixture", FILE)
    actual = adb("exec-out", "run-as", PACKAGE, "cat", FILE)
    parsed = ET.fromstring(actual)
    assert unchanged == {e.get("name"): ET.tostring(e).strip() for e in parsed if e.get("name") != KEY}
    assert [e.get("value") for e in parsed if e.get("name") == KEY] == ["true"]
    return {"serial": serial, "packageName": PACKAGE, "file": FILE, "changedKey": KEY,
            "previousValue": previous, "fixtureValue": True, "otherPreferencesUnchanged": True,
            "beforeSha256": hashlib.sha256(original).hexdigest(), "afterSha256": hashlib.sha256(actual).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serial")
    print(json.dumps(prepare(parser.parse_args().serial), indent=2))
