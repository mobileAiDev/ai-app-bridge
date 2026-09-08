#!/usr/bin/env python3
"""Wire-level capture regression. Synthetic load is explicitly NOT LocalSend business evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.parse
import urllib.request

PACKAGE = 'org.localsend.localsend_app.bridge_sample'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--apk-sha256', required=True)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--stress-records', type=int, default=0)
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--max-query-ms', type=int, default=5000)
    args = parser.parse_args()
    assert args.stress_records >= 0 and args.rounds > 0 and args.max_query_ms > 0
    args.out.mkdir(parents=True, exist_ok=False)
    report = dict(schemaVersion='localsend.capture-window-check/v1', ok=False,
                  serial=args.serial, packageName=PACKAGE, apkSha256=args.apk_sha256,
                  stressRecords=args.stress_records, queries=[], startedAtMs=int(time.time()*1000),
                  scope='Mobile capture transport/storage only; synthetic records are not business evidence')

    def save():
        (args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')

    def adb(*cmd):
        return subprocess.check_output(['adb', '-s', args.serial, *cmd], text=True).strip()

    def request(stream, params=None, body=None):
        url = f'http://127.0.0.1:{args.port}/v1/{stream}'
        if params:
            url += '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=22) as response:
            return json.load(response)

    def query(name, stream, params, expected=None):
        row = dict(name=name, stream=stream, parameters=params, requestedAtMs=int(time.time()*1000))
        start = time.monotonic()
        data = None
        try:
            data = request(stream, params)
            raw = json.dumps(data, ensure_ascii=False).encode()
            file = args.out / (name + '.json')
            file.write_bytes(raw)
            row.update(path=file.name, sha256=hashlib.sha256(raw).hexdigest(),
                       result={k: data.get(k) for k in ['ok', 'coverage', 'reason', 'count', 'hasMore', 'watermarkCursor', 'runtimeEpoch']})
        except Exception as error:
            row['error'] = str(error)
        row['elapsedMs'] = round((time.monotonic()-start)*1000)
        row['passed'] = bool(data and data.get('ok') and data.get('coverage') == dict(status='complete', gap=False, committed=True)
                             and data.get('hasMore') is False and row['elapsedMs'] < args.max_query_ms)
        if expected is not None:
            row['passed'] = row['passed'] and any(item.get('id') == expected['id'] and item.get('data') == expected['data']
                                                 for item in data.get('items', [])) if data else False
        report['queries'].append(row)
        save()
        print(json.dumps(row), flush=True)
        return data

    try:
        forwards = subprocess.check_output(['adb', 'forward', '--list'], text=True).splitlines()
        assert [args.serial, f'tcp:{args.port}', 'tcp:18080'] in [line.split() for line in forwards], 'forward_target_mismatch'
        package_paths = adb('shell', 'pm', 'path', PACKAGE).splitlines()
        assert len(package_paths) == 1 and package_paths[0].startswith('package:/data/app/')
        assert adb('shell', 'sha256sum', package_paths[0][len('package:'):]).split()[0] == args.apk_sha256, 'installed_apk_changed'
        status = request('status')
        assert status['app']['packageName'] == PACKAGE
        report['runtimeEpoch'] = status['debugBridge']['runtimeEpoch']
        report['capturePersistence'] = status['capturePersistence']
        (args.out / 'status.json').write_text(json.dumps(status))
        save()
        last = None
        if args.stress_records:
            # A deterministic fixture definition plus every actual HTTP receipt is retained.
            fixture = dict(category='bridge-validation', name='capture-window-stress',
                           data=dict(fixture='storage-regression-only', padding='x' * 16384))
            (args.out / 'synthetic-fixture.json').write_text(json.dumps(fixture))
            started = time.monotonic()
            with (args.out / 'stress-receipts.jsonl').open('w') as receipts:
                for index in range(args.stress_records):
                    fixture['data']['index'] = index
                    result = request('events', body=fixture)
                    receipts.write(json.dumps(result) + '\n')
                    assert result['ok'] is True
                    last = result['event']
                    if (index + 1) % 500 == 0:
                        print(json.dumps(dict(stage='synthetic-load', receipts=index+1)), flush=True)
            report['stressReceiptMs'] = round((time.monotonic()-started)*1000)
            receipt_hash = hashlib.sha256()
            with (args.out / 'stress-receipts.jsonl').open('rb') as receipts:
                for chunk in iter(lambda: receipts.read(1024 * 1024), b''):
                    receipt_hash.update(chunk)
            report['stressReceiptSha256'] = receipt_hash.hexdigest()
            # Verifies disk-committed content, not merely the HTTP append receipt.
            query('last-synthetic-fact', 'events', dict(view='decision-window', sinceId=last['id']-1,
                                                       sinceMs=last['timestampMs'], limit=200), expected=last)
            time.sleep(1.2)
        for round_number in range(args.rounds):
            for stream in ['events', 'state', 'logs']:
                before = query(f'{round_number+1}-{stream}-time', stream,
                               dict(view='decision-window', sinceMs=int(time.time()*1000)-1000, limit=200))
                if before and before.get('watermarkCursor'):
                    query(f'{round_number+1}-{stream}-cursor', stream,
                          dict(view='decision-window', factCursor=before['watermarkCursor'],
                               runtimeEpoch=report['runtimeEpoch'], limit=200))
        report['ok'] = all(row['passed'] for row in report['queries'])
    except Exception as error:
        report['error'] = str(error)
    finally:
        report['finishedAtMs'] = int(time.time()*1000)
        save()
    print(json.dumps(dict(ok=report['ok'], report=str(args.out / 'report.json'))), flush=True)
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
