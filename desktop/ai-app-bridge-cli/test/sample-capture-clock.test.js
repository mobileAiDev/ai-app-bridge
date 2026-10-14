'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { main: resumeNative } = require('../scripts/validation/native-host-loss');
const { inspectPython } = require('../bin/script/python-runtime-adapter');

test('the Host-loss sample keeps its device capture boundary across explicit recovery', async t => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-sample-clock-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const calls = [], deviceSinceMs = 100_000, hostStartedAtMs = Date.now();
  const result = await resumeNative({ inputs: { outDir, began: hostStartedAtMs, deviceSinceMs },
    resume: () => ({ phase: 'verified-original-gesture' }), checkpoint: async () => {},
    call: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, result: command === 'state' ? { items: [{ timestampMs: deviceSinceMs + 5000 }] } : {} };
    } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.find(call => call.command === 'state').args, { sinceMs: deviceSinceMs, limit: 20 });
  assert.equal(calls.filter(call => call.command === 'native-gesture').length, 0, 'recovery must not replay the original gesture');
});

test('the Python wire-capture sample filters in SDK time even when the Host clock is far ahead', t => {
  const python = inspectPython();
  if (!python.available) { t.skip('Python >= 3.9 is not installed'); return; }
  const script = path.resolve(__dirname, '../../../examples/localsend-sample/validation/check-capture-window.py');
  const program = String.raw`
import contextlib, importlib.util, io, json, pathlib, sys, tempfile, urllib.parse
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('capture_sample', sys.argv[1])
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)
device_now = 100000
queries = []
def adb(argv, **kwargs):
    if argv == ['adb', 'forward', '--list']: return 'device-a tcp:12345 tcp:18080\n'
    if argv[-3:] == ['pm', 'path', sample.PACKAGE]: return 'package:/data/app/example/base.apk\n'
    if argv[-2] == 'sha256sum': return 'expected-sha /data/app/example/base.apk\n'
    raise AssertionError(argv)
class Response(io.BytesIO):
    pass
def urlopen(request, **kwargs):
    url = urllib.parse.urlparse(request.full_url)
    query = urllib.parse.parse_qs(url.query)
    if url.path == '/v1/status':
        payload = dict(ok=True, updatedAtMs=device_now, app=dict(packageName=sample.PACKAGE),
            debugBridge=dict(runtimeEpoch='device-epoch'), capturePersistence=dict(persistent=True))
    else:
        queries.append(query)
        payload = dict(ok=True, coverage=dict(status='complete', gap=False, committed=True), hasMore=False,
            watermarkCursor='opaque-device-cursor', runtimeEpoch='device-epoch', items=[])
    return Response(json.dumps(payload).encode())
with tempfile.TemporaryDirectory() as root, patch.object(sys, 'argv', ['sample', '--serial', 'device-a', '--port', '12345',
        '--apk-sha256', 'expected-sha', '--out', str(pathlib.Path(root) / 'output'), '--rounds', '1']), \
        patch.object(sample.subprocess, 'check_output', side_effect=adb), \
        patch.object(sample.urllib.request, 'urlopen', side_effect=urlopen), \
        patch.object(sample.time, 'time', return_value=9999999), contextlib.redirect_stdout(io.StringIO()):
    result = sample.main()
assert result == 0, result
timed = [int(query['sinceMs'][0]) for query in queries if 'sinceMs' in query]
assert timed == [device_now - 1000] * 3, timed
assert all(query.get('runtimeEpoch') == ['device-epoch'] for query in queries if 'factCursor' in query)
print('device-time filters and original cursor epoch retained')
`;
  const result = spawnSync(python.executable, ['-B', '-c', program, script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('LocalSend manifests bind the current sample bytes without relabelling historical device acceptance', () => {
  const directory = path.resolve(__dirname, '../../../examples/localsend-sample/scripts');
  const sha256 = createHash('sha256').update(fs.readFileSync(path.join(directory, 'localsend-flow.v1.js'))).digest('hex');
  for (const scenario of ['core', 'acceptance']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, `${scenario}.scenario.v1.json`)));
    assert.equal(manifest.source.sha256, sha256);
    assert.match(manifest.latestObservedAcceptance.sourceSha256, /^[a-f0-9]{64}$/);
  }
});
