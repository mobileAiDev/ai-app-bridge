#!/usr/bin/env python3
"""Compare actual LocalSend destination files with a frozen source manifest."""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument('--local', type=Path)
    destination.add_argument('--android-directory')
    parser.add_argument('--serial')
    parser.add_argument('--copies', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    if bool(args.android_directory) != bool(args.serial):
        parser.error('--serial is required only for an Android destination')
    manifest_bytes = args.manifest.read_bytes()
    manifest = json.loads(manifest_bytes)
    names = [item['name'] for item in manifest]
    if not names or len(set(names)) != len(names) or any(
            not name or name in {'.', '..'} or Path(name).name != name for name in names):
        parser.error('manifest requires unique file names without directories')
    report = {
        'schemaVersion': 'localsend.transfer-oracle/v1',
        'capturedAtMs': int(time.time() * 1000),
        'manifestSha256': sha256(manifest_bytes),
        'source': str(args.source.resolve()),
        'destination': str(args.local.resolve()) if args.local else args.android_directory,
        'serial': args.serial,
        'method': 'filesystem read' if args.local else 'adb exec-out cat',
        'files': [],
    }
    if args.copies:
        args.copies.mkdir(parents=True, exist_ok=False)
    for expected in manifest:
        name = expected['name']
        original = (args.source / name).read_bytes()
        item = {'name': name, 'expectedBytes': expected['bytes'],
                'expectedSha256': expected['sha256'],
                'sourceMatchesManifest': len(original) == expected['bytes'] and sha256(original) == expected['sha256']}
        try:
            if args.local:
                actual = (args.local / name).read_bytes()
            else:
                remote = args.android_directory.rstrip('/') + '/' + name
                actual = subprocess.run(
                    ['adb', '-s', args.serial, 'exec-out', 'cat', remote],
                    check=True, capture_output=True, timeout=60).stdout
            item.update(bytes=len(actual), sha256=sha256(actual),
                        bytesEqual=actual == original,
                        matchesManifest=len(actual) == expected['bytes'] and sha256(actual) == expected['sha256'])
            if name.endswith('.txt'):
                item['utf8Text'] = actual.decode('utf-8')
            if args.copies:
                (args.copies / name).write_bytes(actual)
        except (OSError, subprocess.SubprocessError, UnicodeError) as error:
            item.update(bytesEqual=False, matchesManifest=False, error=str(error))
        report['files'].append(item)
    report['ok'] = all(item['sourceMatchesManifest'] and item['bytesEqual'] and item['matchesManifest']
                       for item in report['files'])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open('x') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps({'ok': report['ok'], 'files': len(manifest), 'report': str(args.out)}, ensure_ascii=False))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
