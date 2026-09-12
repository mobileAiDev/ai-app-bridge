#!/usr/bin/env python3
"""Read the sample's actual KML and settings without using Bridge observations."""
import hashlib
import json
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

PACKAGE = "app.organicmaps.bridge_sample.web.debug"
NAMESPACE = {"k": "http://www.opengis.net/kml/2.2"}


def inspect(serial):
    def read(*command):
        return subprocess.check_output(
            ["adb", "-s", serial, "exec-out", "run-as", PACKAGE, *command],
            timeout=15,
        )

    files = []
    placemarks = []
    names = read("ls", "-1", "files/bookmarks").decode("utf-8").splitlines()
    for name in sorted(names):
        if not name.endswith(".kml"):
            raise ValueError("Unexpected file in frozen bookmark directory: " + name)
        data = read("cat", "files/bookmarks/" + name)
        tree = ET.fromstring(data)
        marks = []
        for node in tree.findall(".//k:Placemark", NAMESPACE):
            point = node.find("k:Point", NAMESPACE)
            if point is None:
                raise ValueError("Unexpected non-point bookmark in frozen scenario")
            coordinates = point.findtext("k:coordinates", namespaces=NAMESPACE)
            title = node.findtext("k:name", namespaces=NAMESPACE)
            if not coordinates or not title:
                raise ValueError("Bookmark name and coordinates are required")
            marks.append({"name": title, "coordinates": coordinates.strip()})
        files.append({"name": name, "sha256": hashlib.sha256(data).hexdigest(), "placemarks": marks})
        placemarks.extend(marks)

    settings_data = read("cat", "files/settings.ini")
    settings = {}
    selected = {"Units", "AutoDownloadEnabled", "MapStyleKeyV1"}
    for line in settings_data.decode("utf-8").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() in selected:
            settings[key.strip()] = value.strip()
    if set(settings) != selected:
        raise ValueError("Frozen settings keys are missing")
    return {
        "serial": serial,
        "packageName": PACKAGE,
        "observedAtMs": time.time_ns() // 1_000_000,
        "bookmarkFiles": files,
        "placemarks": placemarks,
        "settings": settings,
        "settingsSha256": hashlib.sha256(settings_data).hexdigest(),
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: independent-oracle.py SERIAL")
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
