#!/usr/bin/env python3
"""Repeat process-cold starts while recording the Mac's actual lock state."""
import argparse
import json
import pathlib
import plistlib
import subprocess
import threading
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('serial')
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--count', type=int, default=6)
    parser.add_argument('--passive-ms', type=int,
                        help='Use a passive cold start with no early UI/SDK observation')
    args = parser.parse_args()
    if args.count < 1:
        parser.error('--count must be positive')
    if args.passive_ms is not None and args.passive_ms <= 0:
        parser.error('--passive-ms must be positive')
    args.output.mkdir(parents=False, exist_ok=False)
    records, samples, errors = [], [], []
    stop = threading.Event()

    def sample():
        state = plistlib.loads(subprocess.check_output(['ioreg', '-a', '-l', '-d', '1']))
        locked = state['IOConsoleLocked']
        if not isinstance(locked, bool):
            raise ValueError('Expected an explicit IOConsoleLocked boolean')
        return {'atMs': time.time_ns() // 1000000,
                'monotonicMs': time.monotonic_ns() // 1000000, 'locked': locked}

    def monitor():
        while not stop.wait(0.5):
            try:
                samples.append(sample())
            except Exception as error:
                errors.append(str(error))
                return

    samples.append(sample())
    if samples[0]['locked']:
        raise RuntimeError('Mac is locked; unlock before measuring awake startup')
    (args.output / 'assertions-before.txt').write_bytes(subprocess.check_output(['pmset', '-g', 'assertions']))
    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    try:
        for index in range(args.count):
            directory = args.output / f'run-{index + 1}'
            began = time.time_ns() // 1000000
            command = ['node', str(pathlib.Path(__file__).with_name('run-android.js')),
                       args.serial, str(directory)]
            command += (['startup-passive', str(args.passive_ms)] if args.passive_ms is not None
                        else ['startup', 'flutter'])
            process = subprocess.run(command, capture_output=True, text=True)
            (args.output / f'run-{index + 1}.log').write_text(process.stdout + process.stderr)
            path = directory / 'report.json'
            report = json.loads(path.read_text()) if path.exists() else None
            record = {'startedAtMs': began, 'finishedAtMs': time.time_ns() // 1000000,
                      'exitCode': process.returncode, 'report': report, 'evidence': str(directory)}
            records.append(record)
            print(json.dumps({'run': index + 1, 'exitCode': process.returncode,
                              'firstScreenMs': report.get('firstScreenMs') if report else None,
                              'firstFrameMs': report.get('firstFrameMs') if report else None}), flush=True)
            if process.returncode != 0:
                break
    finally:
        stop.set()
        thread.join()
        samples.append(sample())
        (args.output / 'assertions-after.txt').write_bytes(subprocess.check_output(['pmset', '-g', 'assertions']))
        max_sample_gap = max((b['atMs'] - a['atMs'] for a, b in zip(samples, samples[1:])), default=0)
        elapsed_skew = max((abs((b['atMs'] - a['atMs']) - (b['monotonicMs'] - a['monotonicMs']))
                            for a, b in zip(samples, samples[1:])), default=0)
        awake = not errors and not any(item['locked'] for item in samples) and max_sample_gap < 2000 and elapsed_skew < 500
        result = {'ok': awake and len(records) == args.count and all(item['report'] and item['report']['ok'] for item in records),
                  'allSamplesUnlocked': not any(item['locked'] for item in samples),
                  'maxSampleGapMs': max_sample_gap, 'maxClockSkewMs': elapsed_skew,
                  'sampleErrors': errors, 'samples': samples, 'runs': records,
                  'scope': 'Mac awake and unlocked process-cold Flutter starts; does not attribute unmonitored historical outliers.'}
        (args.output / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
