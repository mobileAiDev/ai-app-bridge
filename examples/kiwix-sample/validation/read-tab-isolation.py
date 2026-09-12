#!/usr/bin/env python3
"""Compare external quiescent stores after creating and closing one reading tab."""
import argparse
import hashlib
import json
import pathlib
import shutil
import sqlite3


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=pathlib.Path, required=True)
    parser.add_argument('--snapshot', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--active-tab', type=int, required=True)
    args = parser.parse_args()
    args.output.mkdir(exist_ok=False)

    def read(source, label):
        source = source.resolve()
        files = [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': digest(p)}
                 for p in sorted(source.iterdir()) if p.is_file()]
        work = args.output / label
        shutil.copytree(source, work)
        db = sqlite3.connect((work.resolve() / 'DataModel.sqlite').as_uri() + '?mode=ro', uri=True)
        db.row_factory = sqlite3.Row
        db.execute('pragma query_only=on')
        integrity = [row[0] for row in db.execute('pragma integrity_check')]
        tabs = [dict(row) for row in db.execute('''
            select Z_PK as id, ZTITLE as title, ZCREATED as created,
                   ZLASTOPENED as lastOpened, ZZIMFILE as zimFile,
                   ZINTERACTIONSTATE as interactionState from ZTAB order by Z_PK
        ''')]
        for tab in tabs:
            state = tab.pop('interactionState')
            tab['stateSha256'] = None if state is None else hashlib.sha256(state).hexdigest()
        bookmarks = [dict(row) for row in db.execute('''
            select Z_PK, ZTITLE, ZARTICLEURL, ZCREATED, ZZIMFILE from ZBOOKMARK order by Z_PK
        ''')]
        tabMax = db.execute("select Z_MAX from Z_PRIMARYKEY where Z_NAME='Tab'").fetchone()[0]
        db.close()
        return {'source': str(source), 'files': files, 'integrity': integrity, 'tabs': tabs,
                'tabMax': tabMax, 'bookmarks': bookmarks,
                'sourceUnchanged': all(digest(source / f['path']) == f['sha256'] for f in files)}

    before = read(args.baseline, 'baseline-read-copy')
    after = read(args.snapshot, 'post-read-copy')
    stable = lambda rows: [{k: row[k] for k in ['id', 'title', 'created', 'zimFile']} for row in rows]
    unvisited = lambda rows: [row for row in rows if row['id'] != args.active_tab]
    checks = {
        'sqliteIntegrity': before['integrity'] == after['integrity'] == ['ok'],
        'activeTabExists': sum(row['id'] == args.active_tab for row in before['tabs']) == 1,
        'originalTabsAndArchiveRelationshipsPreserved': stable(before['tabs']) == stable(after['tabs']),
        'exactlyOneNewTabAllocatedAndAbsentAfterClose': after['tabMax'] == before['tabMax'] + 1
            and all(row['id'] <= before['tabMax'] for row in after['tabs']),
        'unvisitedTabStateUnchanged': unvisited(before['tabs']) == unvisited(after['tabs']),
        'bookmarksUnchanged': before['bookmarks'] == after['bookmarks'],
        'originalEvidenceFilesUnchanged': before['sourceUnchanged'] and after['sourceUnchanged'],
    }
    result = {'ok': all(checks.values()), 'scope': 'external tab creation/closure and unaffected records; not persistent editor code',
              'checks': checks, 'before': before, 'after': after}
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'ok': result['ok'], 'checks': checks, 'result': str(args.output / 'result.json')}))
    if not result['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
