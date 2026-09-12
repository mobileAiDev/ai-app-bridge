#!/usr/bin/env python3
"""Copy the real iOS database after stopping this run's owned Flutter debugger.

Run outside Script after its terminal result. No UI result is derived from this
snapshot, and no database on the phone is edited or restored by this helper.
"""
import argparse
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-result', required=True, type=pathlib.Path)
    parser.add_argument('--terminal-result', required=True, type=pathlib.Path)
    parser.add_argument('--flutter-launch', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    runtime = json.loads(args.runtime_result.read_text())
    terminal = json.loads(args.terminal_result.read_text())
    launch = json.loads(args.flutter_launch.read_text())
    if runtime.get('ok') is not True or terminal.get('status') not in (
            'completed', 'failed', 'cancelled'):
        parser.error('A successful runtime read and terminal operation are required')
    binding = runtime['runtimeBinding']
    device_id = runtime['device']['udid']
    bundle_id = binding['bundleId']
    output = args.output.resolve()
    output.mkdir(exist_ok=False)

    def run(name, command):
        argv = ['/usr/bin/xcrun', 'devicectl', 'device', *command,
                '--device', device_id, '--timeout', '20',
                '--json-output', str(output / f'{name}.json')]
        with (output / f'{name}.log').open('x') as log:
            subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT,
                           check=True, timeout=25)
        result = json.loads((output / f'{name}.json').read_text())
        if result['info']['outcome'] != 'success':
            raise RuntimeError(f'{name}: devicectl did not succeed')
        if result['result']['deviceIdentifier'] != runtime['device']['identifier']:
            raise RuntimeError(f'{name}: device identity changed')
        return result['result']

    apps = run('apps-before', ['info', 'apps'])['apps']
    matches = [a for a in apps if a['bundleIdentifier'] == bundle_id]
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one installed target App')
    app_url = matches[0]['url'].rstrip('/') + '/'
    processes = run('processes-before', ['info', 'processes'])['runningProcesses']
    original = [p for p in processes if p['processIdentifier'] == binding['processId']]
    if len(original) != 1 or not original[0]['executable'].startswith(app_url):
        raise RuntimeError('Runtime PID does not belong to the installed target App')

    launch_args = launch['args']
    if launch_args[launch_args.index('-d') + 1] != device_id:
        raise RuntimeError('Flutter launcher belongs to a different device')
    app_binary = launch_args[launch_args.index('--use-application-binary') + 1]
    host_command = subprocess.run(
        ['ps', '-p', str(launch['pid']), '-o', 'command='], check=True,
        capture_output=True, text=True).stdout.strip()
    if not all(x in host_command for x in
               ['flutter_tools.snapshot', ' run ', app_binary, device_id]):
        raise RuntimeError('Recorded host PID no longer owns this Flutter launch')
    os.kill(launch['pid'], signal.SIGINT)
    (output / 'stop-debugger.json').write_text(json.dumps({
        'pid': launch['pid'], 'signal': 'SIGINT',
        'verifiedCommand': host_command, 'atMs': int(time.time() * 1000),
    }, indent=2) + '\n')

    def stopped(name):
        records = run(name, ['info', 'processes'])['runningProcesses']
        return not any(p['processIdentifier'] == binding['processId'] or
                       p.get('executable', '').startswith(app_url) for p in records)

    for index in range(5):
        if stopped(f'stopped-{index}'):
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('App is still present; database was not copied')
    run('copy-documents', ['copy', 'from', '--domain-type', 'appDataContainer',
                          '--domain-identifier', bundle_id, '--source', 'Documents',
                          '--destination', str(output / 'Documents')])
    if not stopped('stopped-after-copy'):
        raise RuntimeError('App restarted during copy; snapshot cannot be accepted')
    files = [{'path': str(p.relative_to(output)), 'bytes': p.stat().st_size,
              'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
             for p in sorted((output / 'Documents').rglob('*')) if p.is_file()]
    manifest = {'deviceId': device_id, 'bundleId': bundle_id,
                'runtimeBinding': binding, 'operationId': terminal['operationId'],
                'verifiedStopped': True, 'stopMethod': 'owned Flutter launcher SIGINT',
                'copiedAtMs': int(time.time() * 1000), 'files': files}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'ok': True, 'manifest': str(output / 'manifest.json'),
                      'files': len(files)}))


if __name__ == '__main__':
    main()
