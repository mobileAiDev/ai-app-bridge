#!/usr/bin/env python3
"""Read a quiescent, externally copied Core Data store without changing its evidence files.

The caller must stop the exact Kiwix process and capture Application Support first.
This verifier never writes the phone or fabricates SDK/mobile evidence.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import sqlite3
import urllib.parse


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--expected', required=True, type=pathlib.Path)
    args = parser.parse_args()
    source = args.snapshot.resolve()
    args.output = args.output.resolve()
    expected = json.loads(args.expected.read_text())
    args.output.mkdir(parents=False, exist_ok=False)
    files = [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': digest(p)}
             for p in sorted(source.iterdir()) if p.is_file()]
    work = args.output / 'read-copy'
    shutil.copytree(source, work)
    db = sqlite3.connect((work / 'DataModel.sqlite').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('pragma query_only=on')
    integrity = [row[0] for row in db.execute('pragma integrity_check')]
    rows = [dict(row) for row in db.execute('''
        select b.Z_PK as id, b.ZTITLE as title, b.ZARTICLEURL as articleURL,
               b.ZCREATED as created, b.ZZIMFILE as zimFile,
               hex(z.ZFILEID) as zimFileUUID
        from ZBOOKMARK b left join ZZIMFILE z on z.Z_PK = b.ZZIMFILE
        order by b.ZARTICLEURL
    ''')]
    db.close()
    actual = [{'title': row['title'], 'articleURL': row['articleURL']} for row in rows]
    checks = {
        'sqliteIntegrity': integrity == ['ok'],
        'exactBookmarks': actual == sorted(expected, key=lambda row: row['articleURL']),
        'noDuplicateURLs': len(rows) == len({row['articleURL'] for row in rows}),
        'correctArchiveRelationship': all(row['zimFile'] is not None
            and row['zimFileUUID'].lower() == urllib.parse.urlparse(row['articleURL']).netloc.replace('-', '').lower()
            for row in rows),
        'sourceUnchanged': all(digest(source / item['path']) == item['sha256'] for item in files),
    }
    result = {'ok': all(checks.values()), 'scope': 'external quiescent Core Data snapshot',
              'source': str(source), 'sourceFiles': files, 'checks': checks,
              'expected': expected, 'actual': rows}
    with (args.output / 'result.json').open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
