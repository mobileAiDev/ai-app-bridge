#!/usr/bin/env python3
"""Verify a workout from an externally copied, quiescent Flexify database.

Stop the exact sample App process before copying Documents, including SQLite
journals. This program reads a separate copy and never writes the phone or the
original snapshot. It establishes persisted results, not UI or Script coverage.
"""
import argparse
import hashlib
import json
import math
import pathlib
import shutil
import sqlite3
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--case', required=True, type=pathlib.Path)
    parser.add_argument('--plan-title', required=True)
    parser.add_argument('--started-at-ms', required=True, type=int)
    parser.add_argument('--finished-at-ms', required=True, type=int)
    parser.add_argument('--day')
    parser.add_argument('--time-zone')
    parser.add_argument('--expected-day-volume-kg', type=float)
    args = parser.parse_args()
    if args.finished_at_ms < args.started_at_ms:
        parser.error('--finished-at-ms must not precede --started-at-ms')
    day_arguments = [args.day, args.time_zone, args.expected_day_volume_kg]
    if any(v is not None for v in day_arguments) and any(v is None for v in day_arguments):
        parser.error('--day, --time-zone and --expected-day-volume-kg must be provided together')

    source = args.snapshot.resolve()
    output = args.output.resolve()
    expected = json.loads(args.case.read_text())
    database = source / 'flexify.sqlite'
    if not database.is_file():
        parser.error('--snapshot must contain flexify.sqlite')
    names = ['flexify.sqlite', 'flexify.sqlite-wal', 'flexify.sqlite-shm',
             'flexify.sqlite-journal']
    files = [{'path': name, 'bytes': (source / name).stat().st_size,
              'sha256': digest(source / name)}
             for name in names if (source / name).is_file()]

    output.mkdir(parents=False, exist_ok=False)
    work = output / 'read-copy'
    work.mkdir()
    for item in files:
        shutil.copy2(source / item['path'], work / item['path'])
    db = sqlite3.connect((work / 'flexify.sqlite').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('pragma query_only=on')
    integrity = [row[0] for row in db.execute('pragma integrity_check')]
    version = db.execute('pragma user_version').fetchone()[0]
    plans = [dict(row) for row in db.execute(
        'select id, title, days from plans where title = ? order by id',
        (args.plan_title,))]
    exercises = [dict(row) for row in db.execute('''
        select e.id, e.plan_id, e.exercise, e.enabled
        from plan_exercises e join plans p on p.id = e.plan_id
        where p.title = ? order by e.id
    ''', (args.plan_title,))]
    sets = [dict(row) for row in db.execute('''
        select s.id, s.plan_id, s.name, s.reps, s.weight, s.unit,
               s.created, s.hidden, s.cardio
        from gym_sets s join plans p on p.id = s.plan_id
        where p.title = ? order by s.id
    ''', (args.plan_title,))]
    # Drift stores DateTime in whole Unix seconds for this pinned schema.
    start_second = math.floor(args.started_at_ms / 1000)
    finish_second = math.ceil(args.finished_at_ms / 1000)
    run_sets = [dict(row) for row in db.execute('''
        select id, plan_id, name, created from gym_sets
        where hidden = 0 and created between ? and ? order by id
    ''', (start_second, finish_second))]
    day_result = None
    if args.day is not None:
        day = datetime.strptime(args.day, '%Y-%m-%d').replace(tzinfo=ZoneInfo(args.time_zone))
        day_start, day_end = day.timestamp(), (day + timedelta(days=1)).timestamp()
        day_sets = [dict(row) for row in db.execute('''
            select id, plan_id, reps, weight, created from gym_sets
            where name = ? and hidden = 0 and cardio = 0 and unit = 'kg'
              and created >= ? and created < ? order by id
        ''', (expected['exercise'], day_start, day_end))]
        day_result = {'day': args.day, 'timeZone': args.time_zone,
                      'sets': day_sets,
                      'volumeKg': sum(row['reps'] * row['weight'] for row in day_sets),
                      'expectedVolumeKg': args.expected_day_volume_kg}
    db.close()

    actual_sets = [{'weight': row['weight'], 'reps': row['reps'], 'unit': row['unit']}
                   for row in sets]
    repetitions = sum(row['reps'] for row in sets)
    volume = sum(row['reps'] * row['weight'] for row in sets)
    checks = {
        'sqliteIntegrity': integrity == ['ok'],
        'pinnedSchema': version == 56,
        'uniquePlan': len(plans) == 1,
        'planDay': len(plans) == 1 and plans[0]['days'] == expected['days'],
        'enabledExercise': len(exercises) == 1
            and exercises[0]['exercise'] == expected['exercise']
            and exercises[0]['enabled'] == 1,
        'exactSets': actual_sets == expected['expectedSets'],
        'exerciseAndType': len(sets) > 0 and all(row['name'] == expected['exercise']
            and row['hidden'] == 0 and row['cardio'] == 0 for row in sets),
        'expectedRepetitions': repetitions == expected['expectedRepetitions'],
        'expectedVolumeKg': volume == expected['expectedVolumeKg'],
        'freshRunRecords': len(sets) > 0
            and [row['id'] for row in sets] == [row['id'] for row in run_sets],
        'sourceUnchanged': all(digest(source / item['path']) == item['sha256']
            for item in files),
    }
    if day_result is not None:
        checks['runWithinGraphDay'] = day_start <= args.started_at_ms / 1000 <= args.finished_at_ms / 1000 < day_end
        checks['exactDayVolumeKg'] = day_result['volumeKg'] == args.expected_day_volume_kg
    result = {
        'ok': all(checks.values()),
        'scope': 'external quiescent SQLite workout snapshot',
        'source': str(source), 'sourceFiles': files, 'schemaVersion': version,
        'caseFile': str(args.case.resolve()), 'caseSha256': digest(args.case),
        'planTitle': args.plan_title,
        'runWindowMs': {'start': args.started_at_ms, 'finish': args.finished_at_ms},
        'checks': checks, 'expected': expected,
        'actual': {'plans': plans, 'exercises': exercises, 'sets': sets,
                   'runSets': run_sets, 'repetitions': repetitions, 'volumeKg': volume,
                   'day': day_result},
    }
    with (output / 'result.json').open('x') as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
        file.write('\n')
    print(json.dumps({'ok': result['ok'], 'checks': checks,
                      'output': str(output / 'result.json')}, ensure_ascii=False))
    if not result['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
