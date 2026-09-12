#!/usr/bin/env python3
"""Read the isolated Wikipedia sample's business preferences without Bridge."""

import argparse
import hashlib
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = "org.wikipedia.dev.bridge_sample"
PREFERENCES = f"shared_prefs/{PACKAGE}_preferences.xml"
TYPES = {"colorTheme": "int", "matchSystemTheme": "boolean", "languageApp": "string"}


def parse_values(raw):
    root = ET.fromstring(raw)
    if root.tag != "map":
        raise ValueError("Expected a SharedPreferences map")
    values = {}
    for key, expected_type in TYPES.items():
        matches = [element for element in root if element.get("name") == key]
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one preference: {key}")
        element = matches[0]
        if element.tag != expected_type or len(element):
            raise ValueError(f"Invalid preference type: {key}")
        if expected_type == "int":
            value = element.get("value")
            if value is None or re.fullmatch(r"-?(0|[1-9][0-9]*)", value) is None:
                raise ValueError(f"Invalid integer: {key}")
            value = int(value)
            if not -(2**31) <= value < 2**31:
                raise ValueError(f"Integer out of range: {key}")
        elif expected_type == "boolean":
            value = element.get("value")
            if value not in ("true", "false"):
                raise ValueError(f"Invalid boolean: {key}")
            value = value == "true"
        else:
            # ElementTree represents the explicit empty XML string as None.
            value = "" if element.text is None else element.text
        values[key] = value
    return values


def read_preferences(serial):
    raw = subprocess.check_output(
        ["adb", "-s", serial, "exec-out", "run-as", PACKAGE, "cat", PREFERENCES],
        timeout=20,
    )
    return {
        "schemaVersion": "wikipedia-business-preferences/v1",
        "serial": serial,
        "packageName": PACKAGE,
        "capturedAtMs": int(time.time() * 1000),
        "file": PREFERENCES,
        "fileSha256": hashlib.sha256(raw).hexdigest(),
        "values": parse_values(raw),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serial")
    args = parser.parse_args()
    print(json.dumps(read_preferences(args.serial), ensure_ascii=False, indent=2))
