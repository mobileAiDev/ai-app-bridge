#!/usr/bin/env python3
"""Read original Wikipedia reading-list tables from a quiescent device archive.

The caller records the device/package and verifies every App process is stopped
before copying databases, then resumes it in finally. This reader only extracts
the Wikipedia SQLite files into a new local copy; it never edits the phone or
the source archive. UI coverage and expected business results belong to the
controller, not to this data reader.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    source = args.archive.resolve()
    source_hash = digest(source.read_bytes())
    output = args.output.resolve()
    output.mkdir(exist_ok=False)
    copy = output / 'read-copy'
    copy.mkdir()
    files = []
    with tarfile.open(source) as archive:
        names = archive.getnames()
        for name in ['wikipedia.db', 'wikipedia.db-wal', 'wikipedia.db-shm',
                     'wikipedia.db-journal']:
            member = 'databases/' + name
            if member not in names:
                if name == 'wikipedia.db':
                    raise ValueError('Archive has no original wikipedia.db')
                continue
            if names.count(member) != 1 or not archive.getmember(member).isfile():
                raise ValueError('A SQLite member is duplicated or is not a regular file')
            data = archive.extractfile(member).read()
            (copy / name).write_bytes(data)
            files.append({'path': member, 'bytes': len(data), 'sha256': digest(data)})
    db = sqlite3.connect((copy / 'wikipedia.db').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('pragma query_only=on')
    integrity = [row[0] for row in db.execute('pragma integrity_check')]
    version = db.execute('pragma user_version').fetchone()[0]
    tables = {name: [dict(row) for row in db.execute('select * from ' + name + ' order by id')]
              for name in ['ReadingList', 'ReadingListPage']}
    db.close()
    if digest(source.read_bytes()) != source_hash:
        raise ValueError('Source archive changed during the read')
    result = {'schemaVersion': 'wikipedia-reading-lists/v1', 'integrity': integrity,
              'databaseVersion': version, 'sourceArchive': str(source),
              'sourceSha256': source_hash, 'sourceFiles': files, 'tables': tables}
    (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'ok': integrity == ['ok'], 'result': str(output / 'result.json'),
                      'counts': {name: len(rows) for name, rows in tables.items()}}, ensure_ascii=False))
    if integrity != ['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
