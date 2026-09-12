#!/usr/bin/env python3
"""Read actual Android transfer growth and compare a stopped partial file."""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--mode', choices=['progress', 'partial'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads(args.manifest.read_text())
    name = expected['name']
    if Path(name).name != name or not name.startswith('BridgeInFlight'):
        parser.error('requires a task-owned BridgeInFlight file name')
    remote = '/storage/emulated/0/Download/' + name
    report = {'schemaVersion': 'localsend.partial-file-oracle/v1', 'ok': False,
              'mode': args.mode, 'serial': args.serial, 'remotePath': remote,
              'file': expected, 'samples': []}

    def stat():
        result = subprocess.run(['adb', '-s', args.serial, 'shell', 'stat', '-c', '%s', remote],
                                capture_output=True, text=True, timeout=10)
        item = {'atMs': int(time.time() * 1000), 'exists': result.returncode == 0}
        if item['exists']:
            item['bytes'] = int(result.stdout.strip())
        report['samples'].append(item)
        return item

    try:
        deadline = time.monotonic() + 10
        while True:
            current = stat()
            samples = report['samples']
            if args.mode == 'progress':
                if len(samples) >= 2 and all(x['exists'] for x in samples[-2:]) and (
                        1024 * 1024 <= samples[-2]['bytes'] < current['bytes'] < expected['bytes']):
                    report['ok'] = True
                    break
            elif len(samples) >= 3 and all(x['exists'] for x in samples[-3:]) and (
                    len({x['bytes'] for x in samples[-3:]}) == 1):
                break
            if time.monotonic() > deadline:
                raise ValueError('required file growth or stable file size was not observed')
            time.sleep(0.25 if args.mode == 'progress' else 0.5)
        if args.mode == 'partial':
            size = current['bytes']
            if not 0 < size < expected['bytes']:
                raise ValueError(f'not a partial file: {size} of {expected["bytes"]} bytes')
            with args.source.open('rb') as source:
                source_hash = hashlib.sha256()
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    source_hash.update(chunk)
                report['sourceMatchesManifest'] = source_hash.hexdigest() == expected['sha256']
            destination = args.out.parent / 'actual-partial.bin'
            process = subprocess.Popen(['adb', '-s', args.serial, 'exec-out', 'cat', remote],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            actual_hash, prefix_hash = hashlib.sha256(), hashlib.sha256()
            equal, actual_size = True, 0
            try:
                with args.source.open('rb') as source, destination.open('xb') as saved:
                    while True:
                        chunk = process.stdout.read(1024 * 1024)
                        if not chunk:
                            break
                        prefix = source.read(len(chunk))
                        equal = equal and chunk == prefix
                        actual_size += len(chunk)
                        actual_hash.update(chunk)
                        prefix_hash.update(prefix)
                        saved.write(chunk)
                if process.wait(timeout=15) != 0:
                    raise ValueError('independent adb read failed')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            after = stat()
            report.update(bytes=actual_size, sha256=actual_hash.hexdigest(),
                          sourcePrefixSha256=prefix_hash.hexdigest(), bytesEqualToSourcePrefix=equal,
                          actualCopy=str(destination.resolve()),
                          sizeUnchangedDuringRead=after.get('bytes') == size)
            report['ok'] = (report['sourceMatchesManifest'] and equal and actual_size == size
                            and report['sizeUnchangedDuringRead'])
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report['error'] = str(error)
    with args.out.open('x') as output:
        json.dump(report, output, indent=2, ensure_ascii=False)
        output.write('\n')
    print(json.dumps({'ok': report['ok'], 'mode': args.mode, 'samples': report['samples'],
                      'bytes': report.get('bytes'), 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
