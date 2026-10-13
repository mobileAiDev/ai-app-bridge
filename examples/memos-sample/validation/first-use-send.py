#!/usr/bin/env python3
"""Forward one public request to the owned harness and print a bounded UI projection."""
import json
import pathlib
import re
import sys
import urllib.request

out = pathlib.Path(sys.argv[1])
identity = json.loads((out / 'identity.json').read_text())
request = json.load(sys.stdin)
if request.get('answer') is not None:
    previous = json.loads((out / 'latest-control.json').read_text())
    pending = previous['pendingQuestion']
    request = {'name': request['name'], 'command': 'script', 'arguments': {
        'operation': 'decide', 'operationId': previous['operationId'],
        'requestId': pending['requestId'], 'revision': pending['revision'],
        'decision': request['answer']}}

def send(value):
    body = json.dumps(value).encode()
    result = json.load(urllib.request.urlopen(urllib.request.Request(
        f'http://127.0.0.1:{identity["controlPort"]}/command', data=body,
        headers={'Content-Type': 'application/json'}), timeout=90))
    result = result.get('result', result)
    if result.get('operationId'):
        (out / 'latest-control.json').write_text(json.dumps(result, indent=2))
    return result

result = send(request)
if request.get('command') == 'script' and result.get('status') in ('running', 'finishing'):
    result = send({'name': request['name'] + '-wait', 'command': 'script', 'arguments': {
        'operation': 'wait', 'operationId': result['operationId'],
        'afterSequence': result['eventSequence'], 'waitMs': 60000}})
pending = result.get('pendingQuestion')
dom = pending['request'].get('dom') if pending is not None else result.get('dom')
if dom:
    print(json.dumps({k: result.get(k) for k in ['ok', 'error', 'status', 'operationId', 'eventSequence']}, indent=2))
    print('URL:', dom.get('url'))
    print('BODY:', dom.get('bodyText'))
    for control in dom.get('controls', []):
        if re.fullmatch(r'2026-\d\d-\d\d', control.get('ariaLabel', '')) or control.get('role') in ('grid', 'row', 'columnheader'):
            continue
        print(json.dumps(control, ensure_ascii=False))
else:
    print(json.dumps(result, ensure_ascii=False, indent=2))
