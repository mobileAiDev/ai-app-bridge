"""Read an already verified, quiesced SQLite copy; never touches Android."""
import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import xml.etree.ElementTree as ET

spec = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="notallyx-oracle-") as tmp:
    db = pathlib.Path(tmp) / "NotallyDatabase"
    shutil.copyfile(spec["database"], db)
    for suffix in ("wal", "shm"):
        if spec.get(suffix):
            shutil.copyfile(spec[suffix], str(db) + "-" + suffix)
    connection = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
    if integrity != ["ok"]:
        raise ValueError("sqlite_integrity_failed:" + str(integrity))
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version != 11:
        raise ValueError("schema_version_not_11:" + str(version))
    identity = connection.execute("SELECT identity_hash FROM room_master_table WHERE id=42").fetchone()
    if not identity or identity[0] != "80a04d33cf13bc8ca45396f5a5d85e61":
        raise ValueError("room_schema_identity_mismatch")
    expected_columns = {"id", "type", "folder", "color", "title", "pinned", "timestamp", "modifiedTimestamp", "labels", "body", "spans", "items", "images", "files", "audios", "reminders", "viewMode", "isPinnedToStatus"}
    if {row[1] for row in connection.execute("PRAGMA table_info(BaseNote)")} != expected_columns:
        raise ValueError("note_columns_mismatch")
    if {row[1] for row in connection.execute("PRAGMA table_info(Label)")} != {"value", "order"}:
        raise ValueError("label_columns_mismatch")
    notes = [dict(row) for row in connection.execute("SELECT * FROM BaseNote ORDER BY id")]
    for note in notes:
        for field in ("labels", "spans", "items", "images", "files", "audios", "reminders"):
            note[field] = json.loads(note[field])
            if not isinstance(note[field], list):
                raise ValueError("non_array_note_field:" + field)
        for field in ("pinned", "isPinnedToStatus"):
            if note[field] not in (0, 1):
                raise ValueError("non_boolean_note_field:" + field)
            note[field] = bool(note[field])
    labels = [dict(row) for row in connection.execute('SELECT * FROM Label ORDER BY value')]
    connection.close()

preferences = {}
if spec.get("preferences"):
    root = ET.parse(spec["preferences"]).getroot()
    if root.tag != "map":
        raise ValueError("preferences_not_android_map")
    for element in root:
        name = element.attrib["name"]
        if name in preferences:
            raise ValueError("duplicate_preference_key:" + name)
        if element.tag == "string":
            value = element.text or ""
        elif element.tag in ("int", "long"):
            value = int(element.attrib["value"])
        elif element.tag == "float":
            value = float(element.attrib["value"])
        elif element.tag == "boolean":
            if element.attrib["value"] not in ("true", "false"):
                raise ValueError("invalid_preference_boolean")
            value = element.attrib["value"] == "true"
        elif element.tag == "set":
            if any(child.tag != "string" for child in element):
                raise ValueError("invalid_preference_set")
            value = sorted(child.text or "" for child in element)
        else:
            raise ValueError("unsupported_preference_type:" + element.tag)
        preferences[name] = value
json.dump({"schemaVersion": version, "roomIdentity": identity[0], "notes": notes, "labels": labels, "preferences": preferences}, sys.stdout, ensure_ascii=False, allow_nan=False)
