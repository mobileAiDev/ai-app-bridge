import sys, json, sqlite3, zipfile, hashlib
from pathlib import Path

# No extraction of untrusted member paths: only the single declared DB is read.
archive, output = map(Path, sys.argv[1:3])
with zipfile.ZipFile(archive) as z:
    if z.namelist() != ['NotallyDatabase'] or z.testzip() is not None:
        raise ValueError('This narrow fixture requires one intact unencrypted NotallyDatabase')
    data = z.read('NotallyDatabase')
    if data[:16] != b'SQLite format 3\0':
        raise ValueError('SQLite header required')
    output.mkdir()
    database = output / 'NotallyDatabase'
    database.write_bytes(data)
    db = sqlite3.connect(database.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    db.row_factory = sqlite3.Row
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('SQLite integrity check failed')
    observed = {'schemaVersion': db.execute('PRAGMA user_version').fetchone()[0],
        'roomIdentity': db.execute('SELECT identity_hash FROM room_master_table WHERE id=42').fetchone()[0],
        'notes': [dict(row) for row in db.execute('SELECT * FROM BaseNote ORDER BY id')],
        'labels': [dict(row) for row in db.execute('SELECT * FROM Label ORDER BY value')]}
    for note in observed['notes']:
        for key in ['labels', 'spans', 'items', 'images', 'files', 'audios', 'reminders']:
            note[key] = json.loads(note[key])
        for key in ['pinned', 'isPinnedToStatus']:
            note[key] = bool(note[key])
    db.close()
    if database.read_bytes() != data:
        raise ValueError('Read-only SQLite oracle changed source')
    result = {'ok': True, 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'databaseSha256': hashlib.sha256(data).hexdigest(), 'entries': z.namelist(), 'data': observed}
    (output / 'observed.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'ok': True, 'notes': len(observed['notes']), 'labels': len(observed['labels'])}))
