#!/usr/bin/env python3
"""Independent, read-only database proof for a Memos task toggle checkpoint."""
import argparse
from contextlib import closing
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import time


def main():
    parser = argparse.ArgumentParser()
    for name in ['database', 'baseline', 'case', 'output']:
        parser.add_argument(f'--{name}', type=Path, required=True)
    parser.add_argument('--state', choices=['checked', 'restored'], required=True)
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text())['rows']
    case = json.loads(args.case.read_text())
    original = [row for row in baseline if case['marker'] in row['content']]
    if len(original) != 1:
        raise ValueError('The baseline must identify exactly one existing memo')
    original = original[0]
    expected = case[args.state]
    args.output.mkdir(mode=0o700, exist_ok=False)
    snapshot = args.output / 'memos.sqlite'
    with closing(sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(snapshot)) as destination:
            source.backup(destination)
            destination.execute('PRAGMA journal_mode=DELETE').fetchone()
            destination.commit()
    snapshot.chmod(0o600)
    with closing(sqlite3.connect(snapshot.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute(
            'SELECT memo.id,uid,creator_id,content,visibility,memo.row_status,memo.created_ts,memo.updated_ts,payload,username '
            'FROM memo JOIN user ON memo.creator_id=user.id ORDER BY memo.id')]
    matches = [row for row in rows if row['id'] == original['id']]
    current = matches[0] if len(matches) == 1 else None
    checks = {'oneOriginalMemo': len(matches) == 1, 'memoCountUnchanged': len(rows) == len(baseline),
              'otherMemosUnchanged': [row for row in rows if row['id'] != original['id']]
              == [row for row in baseline if row['id'] != original['id']]}
    if current:
        expected_payload = copy.deepcopy(json.loads(original['payload']))
        # Memos uses protojson.Marshal: a proto3 bool's false default is omitted.
        if expected['hasIncompleteTasks']:
            expected_payload['property']['hasIncompleteTasks'] = True
        else:
            del expected_payload['property']['hasIncompleteTasks']
        checks.update(exactContent=current['content'] == expected['content'],
                      exactTaskAndTagProperties=json.loads(current['payload']) == expected_payload,
                      identityAndVisibilityUnchanged=all(current[key] == original[key]
                                                       for key in original if key not in ['content', 'payload', 'updated_ts']),
                      updateTimeDoesNotRegress=current['updated_ts'] >= original['updated_ts'])
    result = {'ok': all(checks.values()), 'state': args.state, 'observedAtMs': time.time_ns() // 1_000_000,
              'checks': checks, 'snapshotSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(),
              'caseSha256': hashlib.sha256(args.case.read_bytes()).hexdigest(), 'memo': current}
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'ok': result['ok'], 'state': args.state, 'checks': checks}))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
