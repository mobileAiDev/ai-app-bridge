#!/usr/bin/env python3
"""Read Android's MediaSession and VLC's on-disk preferences, outside Bridge."""
import hashlib
import json
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

PACKAGE = "org.videolan.vlc.bridge_sample.debug"
PREFERENCE_KEYS = {
    "app_onboarding_done", "app_theme", "ml_scan", "show_update",
    "current_media", "current_media_resume", "media_list", "media_list_resume",
    "position_in_media", "position_in_media_list", "VideoResumeTime", "VideoSpeed",
    "current_song", "position_in_song", "video_hud_timeout_in_s",
}


def read_session(dump):
    # Persist only the isolated sample's block; other apps' sessions stay private.
    starts = list(re.finditer(r"(?m)^    [^\n]* " + re.escape(PACKAGE) + r"/[^\n]+$", dump))
    if not starts:
        return None
    if len(starts) != 1:
        raise ValueError("Expected exactly one VLC sample MediaSession")
    tail = dump[starts[0].start():]
    lines = tail.splitlines()
    selected = [lines[0]]
    for line in lines[1:]:
        if line and not line.startswith("      "):
            break
        selected.append(line)
    raw = "\n".join(selected).rstrip() + "\n"
    if f"      package={PACKAGE}\n" not in raw:
        raise ValueError("MediaSession package identity missing")
    match = re.search(r"state=PlaybackState \{state=(\w+)\((\d+)\), position=(-?\d+), buffered position=(-?\d+), speed=([\d.-]+), updated=(\d+),", raw)
    title = re.search(r"(?m)^      metadata: size=\d+, description=([^,]+),", raw)
    if not match or not title:
        raise ValueError("MediaSession playback/metadata format changed")
    return {"packageName": PACKAGE, "state": match[1], "stateCode": int(match[2]),
            "positionMs": int(match[3]), "speed": float(match[5]),
            "updatedElapsedRealtimeMs": int(match[6]), "title": title[1], "raw": raw}


def read(serial):
    def adb(*args):
        return subprocess.check_output(["adb", "-s", serial, *args], timeout=20)

    began = int(time.time() * 1000)
    session = read_session(adb("shell", "dumpsys", "media_session").decode())
    prefs = adb("exec-out", "run-as", PACKAGE, "cat", f"shared_prefs/{PACKAGE}_preferences.xml")
    values = {}
    for element in ET.fromstring(prefs):
        key = element.attrib["name"]
        if key not in PREFERENCE_KEYS:
            continue
        if element.tag == "string":
            value = element.text or ""
        elif element.tag in ("int", "long"):
            value = int(element.attrib["value"])
        elif element.tag == "float":
            value = float(element.attrib["value"])
        elif element.tag == "boolean":
            value = {"true": True, "false": False}[element.attrib["value"]]
        else:
            raise ValueError("Unexpected preference type: " + element.tag)
        values[key] = {"type": element.tag, "value": value}
    return {"schemaVersion": "vlc-independent-oracle/v1", "serial": serial, "packageName": PACKAGE,
            "startedAtMs": began, "completedAtMs": int(time.time() * 1000),
            "mediaSession": session, "preferences": {"sha256": hashlib.sha256(prefs).hexdigest(),
                "source": f"shared_prefs/{PACKAGE}_preferences.xml", "values": values,
                "rawXml": prefs.decode()}}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: independent-oracle.py SERIAL")
    print(json.dumps(read(sys.argv[1]), ensure_ascii=False))
