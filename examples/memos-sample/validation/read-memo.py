#!/usr/bin/env python3
"""Read a consistent Memos SQLite snapshot independently of Bridge and the UI."""
import argparse
from contextlib import closing
import hashlib
import json
import pathlib
import sqlite3
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', type=pathlib.Path, required=True)
    parser.add_argument('--case', type=pathlib.Path, required=True)
    parser.add_argument('--baseline', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--username', required=True)
    parser.add_argument('--started-at-ms', type=int, required=True)
    parser.add_argument('--finished-at-ms', type=int, required=True)
    args = parser.parse_args()
    if args.started_at_ms > args.finished_at_ms:
        parser.error('finished-at-ms must follow started-at-ms')
    expected = json.loads(args.case.read_text())
    baseline = json.loads(args.baseline.read_text())['rows']
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    snapshot = args.output / 'memos.sqlite'
    with closing(sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(snapshot)) as copy:
            source.backup(copy)
            copy.execute('PRAGMA journal_mode=DELETE').fetchone()
            copy.commit()
    with closing(sqlite3.connect(snapshot.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute(
            'SELECT memo.id,uid,creator_id,content,visibility,memo.row_status,memo.created_ts,memo.updated_ts,payload,username '
            'FROM memo JOIN user ON memo.creator_id=user.id ORDER BY memo.id')]
    matches = [row for row in rows if expected['marker'] in row['content']]
    current = matches[0] if len(matches) == 1 else None
    checks = {'oneMatchingMemo': len(matches) == 1, 'oneNewMemo': len(rows) == len(baseline) + 1,
              'existingMemosUnchanged': all(any(all(row.get(key) == value for key, value in old.items())
                                              for row in rows) for old in baseline)}
    if current:
        payload = json.loads(current['payload'])
        checks.update(exactEditedContent=current['content'] == expected['editedContent'],
                      intendedOwner=current['username'] == args.username,
                      privateMemo=current['visibility'] == 'PRIVATE',
                      cancelledDeleteRetainsNormalMemo=current['row_status'] == 'NORMAL',
                      exactTag=payload.get('tags') == [expected['tag']],
                      createdDuringRun=args.started_at_ms // 1000 <= current['created_ts'] <= args.finished_at_ms // 1000,
                      updatedDuringRun=args.started_at_ms // 1000 <= current['updated_ts'] <= args.finished_at_ms // 1000,
                      taskListPreserved=payload.get('property', {}).get('hasTaskList') is True,
                      incompleteTaskPreserved=payload.get('property', {}).get('hasIncompleteTasks') is True)
    result = {'ok': all(checks.values()), 'observedAtMs': int(time.time() * 1000),
              'source': str(args.database.resolve()), 'snapshotSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(),
              'caseSha256': hashlib.sha256(args.case.read_bytes()).hexdigest(), 'checks': checks, 'memo': current}
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'ok': result['ok'], 'checks': checks}, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
