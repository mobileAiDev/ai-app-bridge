#!/usr/bin/env python3
"""Repeat process-cold starts with non-blocking Mac display/session evidence."""
import argparse
import datetime
import json
import os
import pathlib
import re
import subprocess
import threading
import time


def app_nap_observations(events, pid, started_at_ms, finished_at_ms):
    """Keep the last recorded state before measurement and every transition within it."""
    states = []
    pattern = re.compile(
        rf'\[anon<qemu-system-aarch64>\([^)]*\):{pid}\] Set AppNap state: '
        r'<[^>]*enabled:([YN]) active:([YN]) socket:([YN]) disk:([YN]) '
        r'priority:([YN]) cpu:([YN]) timer:([^ >]+)')
    for event in events:
        match = pattern.search(event.get('eventMessage', ''))
        if not match:
            continue
        at_ms = int(datetime.datetime.strptime(event['timestamp'], '%Y-%m-%d %H:%M:%S.%f%z').timestamp() * 1000)
        if at_ms > finished_at_ms:
            continue
        state = {'atMs': at_ms, 'pid': pid, 'source': 'runningboardd system log',
                 'raw': event['eventMessage']}
        state.update(zip(('enabled', 'active', 'socketThrottled', 'diskThrottled',
                          'priorityThrottled', 'cpuThrottled'),
                         (value == 'Y' for value in match.groups()[:6])))
        state['timerTier'] = match.group(7)
        states.append(state)
    states.sort(key=lambda state: state['atMs'])
    before = [state for state in states if state['atMs'] <= started_at_ms]
    return before[-1:] + [state for state in states if state['atMs'] > started_at_ms]


def summarize_environment(samples, errors, app_nap=None):
    signals = set()
    for sample in samples:
        if sample.get('ioConsoleLocked') is True or sample.get('sessionScreenLocked') is True:
            signals.add('session_locked')
        if sample.get('sessionOnConsole') is False:
            signals.add('session_not_on_console')
        if sample.get('frontmostBundleId') in (
                'com.apple.loginwindow', 'com.apple.ScreenSaver.Engine',
                'com.apple.ScreenSaver.Engine.legacy'):
            signals.add('login_or_screensaver_frontmost')
        displays = sample.get('displays', [])
        if displays and all(display['asleep'] for display in displays):
            signals.add('display_asleep')
        elif displays and not any(display['active'] for display in displays):
            signals.add('no_active_display')
        frontmost_pid = sample.get('frontmostPid')
        frontmost_observed = bool(sample.get('frontmostBundleId')) or (
            type(frontmost_pid) is int and frontmost_pid > 0)
        if (not isinstance(sample.get('ioConsoleLocked'), bool)
                or not isinstance(sample.get('sessionOnConsole'), bool)
                or not frontmost_observed
                or not displays or sample.get('displayQueryError') != 0):
            signals.add('incomplete_environment_sample')
    max_gap = max((b['atMs'] - a['atMs'] for a, b in zip(samples, samples[1:])), default=0)
    clock_skew = max((abs((b['atMs'] - a['atMs']) - (b['monotonicMs'] - a['monotonicMs']))
                      for a, b in zip(samples, samples[1:])), default=0)
    if max_gap >= 2000:
        signals.add('sampling_gap')
    if clock_skew >= 500:
        signals.add('clock_discontinuity')
    if errors or not samples:
        signals.add('probe_unavailable')
    if app_nap is not None:
        if any(state['active'] or state['cpuThrottled'] for state in app_nap):
            signals.add('emulator_app_nap')
        if not app_nap or not samples or app_nap[0]['atMs'] > samples[0]['atMs']:
            signals.add('emulator_initial_scheduling_unknown')
    inactive = signals.intersection({
        'session_locked', 'session_not_on_console', 'login_or_screensaver_frontmost',
        'display_asleep', 'no_active_display', 'emulator_app_nap'})
    status = 'inactive' if inactive else 'unknown' if signals else 'active_display_observed'
    return {
        'status': status, 'signals': sorted(signals),
        'maxSampleGapMs': max_gap, 'maxClockSkewMs': clock_skew,
        'sampleErrors': errors,
        'emulatorAppNap': app_nap,
        'guidance': ([
            'Display activity does not establish emulator CPU availability. '
            'Pass --emulator-pid with the verified emulator host PID to retain App Nap and CPU evidence.',
        ] if app_nap is None else []) + ([] if status == 'active_display_observed' else [
            'Execution continues. Keep these timings, but do not attribute them to the App alone.',
        ]) + ([
            'For a comparable rerun, inspect the Mac display/session and unlock it if needed; '
            'use --keep-display-awake with a new output directory. This does not unlock the Mac.',
        ] if signals.intersection({'session_locked', 'session_not_on_console',
                                   'login_or_screensaver_frontmost', 'display_asleep', 'no_active_display'}) else []) + ([
            'The emulator has a recorded App Nap / CPU throttling state. Show its existing window '
            'and recheck the recorded state before comparing timings. caffeinate -di does not '
            'disable App Nap. No system settings are changed and execution is not blocked.',
        ] if 'emulator_app_nap' in signals else []),
        'scope': 'Display/session samples and recorded App Nap transitions; absence of a log event '
                 'does not prove full emulator CPU availability or explain unmonitored outliers.',
    }


def summarize_results(records, samples, errors, count, app_nap=None):
    return {
        'ok': len(records) == count and all(
            item['exitCode'] == 0 and item['report'] and item['report']['ok'] for item in records),
        'environment': summarize_environment(samples, errors, app_nap),
        'samples': samples, 'runs': records,
        'scope': 'App results and environment evidence are reported separately. '
                 'Environment warnings do not block execution or change App success.',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('serial')
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--count', type=int, default=6)
    parser.add_argument('--passive-ms', type=int,
                        help='Use a passive cold start with no early UI/SDK observation')
    parser.add_argument('--keep-display-awake', action='store_true',
                        help='Temporarily prevent idle display/system sleep for this process; does not unlock the Mac')
    parser.add_argument('--emulator-pid', type=int,
                        help='Verified host qemu PID; record its App Nap, visibility and cumulative CPU facts')
    args = parser.parse_args()
    if args.count < 1:
        parser.error('--count must be positive')
    if args.passive_ms is not None and args.passive_ms <= 0:
        parser.error('--passive-ms must be positive')
    if args.emulator_pid is not None and args.emulator_pid <= 0:
        parser.error('--emulator-pid must be positive')
    args.output.mkdir(parents=False, exist_ok=False)
    records, samples, errors = [], [], []
    stop = threading.Event()
    probe = args.output / 'mac-display-probe'
    try:
        build = subprocess.run(['swiftc', str(pathlib.Path(__file__).with_name('mac-display-probe.swift')),
                                '-o', str(probe)], capture_output=True, text=True, timeout=60)
        (args.output / 'probe-build.log').write_text(build.stdout + build.stderr)
        if build.returncode != 0:
            errors.append('Display/session probe did not compile; see probe-build.log')
    except (OSError, subprocess.TimeoutExpired) as error:
        errors.append(str(error))
    probe_ready = not errors
    caffeine = None
    if args.keep_display_awake:
        try:
            caffeine = subprocess.Popen(['caffeinate', '-di', '-w', str(os.getpid())])
        except OSError as error:
            errors.append(str(error))

    def sample():
        if probe_ready:
            try:
                command = [str(probe)] + ([str(args.emulator_pid)] if args.emulator_pid else [])
                result = json.loads(subprocess.check_output(command, timeout=3))
                if args.emulator_pid:
                    cpu = subprocess.check_output(
                        ['ps', '-p', str(args.emulator_pid), '-o', 'time=,pri=,nice=,command='],
                        timeout=3, text=True).strip().split(None, 3)
                    if len(cpu) != 4:
                        raise ValueError('Incomplete emulator ps snapshot')
                    result['emulator'].update(
                        cpuSeconds=sum(float(part) * 60 ** i for i, part in enumerate(reversed(cpu[0].split(':')))),
                        schedulerPriority=int(cpu[1]), nice=int(cpu[2]), command=cpu[3])
                return result
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                errors.append(str(error))
        return {'atMs': time.time_ns() // 1000000,
                'monotonicMs': time.monotonic_ns() // 1000000}

    def assertions(label):
        try:
            (args.output / f'assertions-{label}.txt').write_bytes(
                subprocess.check_output(['pmset', '-g', 'assertions'], timeout=3))
        except (OSError, subprocess.SubprocessError) as error:
            errors.append(str(error))

    def monitor():
        while not stop.wait(0.5):
            samples.append(sample())

    samples.append(sample())
    print(json.dumps({'environment': summarize_environment(
        samples, errors, [] if args.emulator_pid else None)}, ensure_ascii=False), flush=True)
    assertions('before')
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
        assertions('after')
        if caffeine is not None:
            caffeine.terminate()
            caffeine.wait()
        app_nap = None
        if args.emulator_pid:
            app_nap = []
            predicate = ('process == "runningboardd" AND '
                         f'eventMessage CONTAINS ":{args.emulator_pid}] Set AppNap state:"')
            command = ['/usr/bin/log', 'show', '--last', '1h', '--style', 'ndjson', '--predicate', predicate]
            try:
                logs = subprocess.run(command, capture_output=True, text=True, timeout=30)
                (args.output / 'emulator-app-nap.ndjson').write_text(logs.stdout)
                (args.output / 'emulator-app-nap.stderr').write_text(logs.stderr)
                if logs.returncode != 0:
                    raise RuntimeError(f'App Nap log query failed with exit {logs.returncode}; see emulator-app-nap.stderr')
                events = [json.loads(line) for line in logs.stdout.splitlines() if line.strip()]
                app_nap = app_nap_observations(events, args.emulator_pid, samples[0]['atMs'], samples[-1]['atMs'])
            except (OSError, subprocess.SubprocessError, ValueError, RuntimeError, KeyError, TypeError) as error:
                errors.append(str(error))
        result = summarize_results(records, samples, errors, args.count, app_nap)
        (args.output / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'ok': result['ok'], 'environment': result['environment']}, ensure_ascii=False), flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
