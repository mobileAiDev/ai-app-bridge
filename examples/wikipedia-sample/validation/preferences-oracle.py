#!/usr/bin/env python3
"""Read the isolated sample's actual SharedPreferences without using Bridge."""

import argparse
import hashlib
import json
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = "org.wikipedia.dev.bridge_sample"
PREFERENCES = f"shared_prefs/{PACKAGE}_preferences.xml"
KEYS = ("showCustomizeToolbarTooltip", "customizeToolbarOrder", "customizeToolbarMenuOrder")


def read_preferences(serial):
    raw = subprocess.check_output(
        ["adb", "-s", serial, "exec-out", "run-as", PACKAGE, "cat", PREFERENCES], timeout=20
    )
    values = {}
    for key in KEYS:
        matches = [element for element in ET.fromstring(raw) if element.get("name") == key]
        if not matches:
            values[key] = {"present": False}
            continue
        if len(matches) != 1:
            raise ValueError(f"Duplicate preference: {key}")
        element = matches[0]
        if key == "showCustomizeToolbarTooltip":
            if element.tag != "boolean" or element.get("value") not in ("true", "false"):
                raise ValueError(f"Invalid boolean: {key}")
            value = element.get("value") == "true"
        else:
            if element.tag != "string":
                raise ValueError(f"Invalid string: {key}")
            value = json.loads(element.text)
            if not isinstance(value, list) or any(type(item) is not int for item in value):
                raise ValueError(f"Invalid order: {key}")
        values[key] = {"present": True, "value": value}
    return {
        "schemaVersion": "wikipedia-toolbar-preferences/v1",
        "serial": serial,
        "packageName": PACKAGE,
        "capturedAtMs": int(time.time() * 1000),
        "file": PREFERENCES,
        "fileSha256": hashlib.sha256(raw).hexdigest(),
        "values": values,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serial")
    args = parser.parse_args()
    print(json.dumps(read_preferences(args.serial), ensure_ascii=False, indent=2))
