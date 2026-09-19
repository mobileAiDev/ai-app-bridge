'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNodeRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { createPythonRuntimeAdapter, inspectPython } = require('../bin/script/python-runtime-adapter');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { handle } = require('../bin/script/script-entry');
const { requireCompatible } = require('../bin/runtime-directory');
function run(runtime, source, sourcePath, timeoutMs = 5000) {
  return runtime.start({ spec: { source, sourcePath, inputs: {}, entrypoint: 'main', policy: { timeoutMs, maxOutputBytes: 65536, maxProgressBytes: 4096 } },
    host: { call() { assert.fail('unexpected action'); } }, agent: {}, emit() {}, control: () => ({ status: 'running' }) });
}
for (const language of ['javascript', 'python']) {
  test(`${language} Script diagnostics expose the stderr tail and source location with bounded stack`, async () => {
    const make = language === 'javascript' ? createNodeRuntimeAdapter : createPythonRuntimeAdapter;
    const sourcePath = path.join(os.tmpdir(), `original-source.${language === 'javascript' ? 'js' : 'py'}`);
    const source = language === 'javascript'
      ? 'Error.stackTraceLimit = 100; console.log("x".repeat(20000)+"LATEST-MARKER");\nfunction fail(n) { if (n) return fail(n-1); throw new TypeError("boom"); }\nmodule.exports.main = () => fail(40);'
      : 'print("x"*20000+"LATEST-MARKER", flush=True)\ndef fail(n):\n    if n: return fail(n-1)\n    raise TypeError("boom")\ndef main(ctx): return fail(40)\n';
    const result = await run(make(), source, sourcePath);
    assert.equal(result.ok, false);
    assert.match(result.diagnostics.stderr, /LATEST-MARKER\n$/);
    assert.ok(Buffer.byteLength(result.diagnostics.stderr) <= 8192);
    assert.equal(result.diagnostics.stderrTruncated, true);
    const error = result.diagnostics.error;
    assert.equal(error.type, 'TypeError'); assert.equal(error.message, 'boom');
    assert.equal(error.location.file, sourcePath);
    assert.equal(error.location.line, language === 'javascript' ? 2 : 4);
    assert.ok(Buffer.byteLength(error.stack) <= 8192);
    assert.equal(error.stackTruncated, true);
    assert.ok((error.stack.match(language === 'javascript' ? /^\s*at /gm : /^\s*File /gm) || []).length <= 20);
    const syntax = await run(make(), language === 'javascript' ? 'module.exports.main = () => {' : 'def main(ctx):\n  (', sourcePath);
    assert.equal(syntax.diagnostics.error.type, 'SyntaxError');
    assert.equal(syntax.diagnostics.error.location.file, sourcePath);
    const success = await run(make(), language === 'javascript' ? 'module.exports.main = () => { console.log("noise"); return true; };'
      : 'def main(ctx):\n    print("noise")\n    return True\n', sourcePath);
    assert.deepEqual(success, { ok: true, result: true });
    const timeout = await run(make(), language === 'javascript' ? 'module.exports.main = () => { console.log("before-timeout"); while(true) {} };'
      : 'def main(ctx):\n    print("before-timeout", flush=True)\n    while True: pass\n', sourcePath, 500);
    assert.equal(timeout.error, 'timeout');
    assert.match(timeout.diagnostics.stderr, /before-timeout/);
    const binary = await run(make(), language === 'javascript' ?
      'module.exports.main = () => { require("node:fs").writeSync(2, Buffer.from(Array(5000).fill([97,255]).flat())); throw Error("binary"); };' :
      'import os\ndef main(ctx):\n    os.write(2, bytes([97,255])*5000)\n    raise ValueError("binary")\n', sourcePath);
    assert.ok(Buffer.byteLength(binary.diagnostics.stderr) <= 8192);
    assert.equal(binary.diagnostics.stderrTruncated, true);
  });
}

test('terminal Script diagnostics survive a fresh supervisor reading the existing checkpoint', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const supervisor = createScriptSupervisor();
  const start = await handle({ supervisor, store, operation: 'start', actions: async () => assert.fail('device call'),
    script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', permissions: [],
      source: 'module.exports.main = () => { console.log("diagnostic-marker"); throw new TypeError("failed"); };' } });
  await supervisor.registry.get(start.operationId).running;
  const live = await handle({ supervisor, store, operation: 'status', operationId: start.operationId });
  const cold = await handle({ supervisor: createScriptSupervisor(), store, operation: 'status', operationId: start.operationId });
  assert.equal(live.status, 'failed');
  assert.equal(live.diagnostics.error.type, 'TypeError');
  assert.match(live.diagnostics.stderr, /diagnostic-marker/);
  assert.deepEqual(cold.diagnostics, live.diagnostics);
});

test('a failed worker spawn cleans its temporary source directory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-spawn-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = `const { createChildRuntimeAdapter } = require(${JSON.stringify(require.resolve('../bin/script/node-runtime-adapter'))});
    const assert = require('node:assert/strict');
    (${run.toString()})(createChildRuntimeAdapter({ kind: 'javascript', executable: '/not-installed/aab-node', sdkFile: 'script-sdk.js', extension: '.js' }),
      'module.exports.main = () => true;').then(result => { assert.equal(result.ok, false); });`;
  const child = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TMPDIR: directory }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('Python version probing has a deadline even if an executable ignores TERM', { timeout: 8000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-python-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'python');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const start = Date.now();
  assert.equal(inspectPython({ resolvePython: () => executable }).available, false);
  assert.ok(Date.now() - start < 6500);
});

test('identity mismatch names both sides and only directs stopping an actually older Runtime', () => {
  const identity = (version, code, node = '26.3.0') => ({ version, code, config: 'configuration', node: { version: node, modules: '148' } });
  for (const [client, runtime, side, instruction] of [
    [identity('0.3.8', 'old'), identity('0.4.0', 'new'), 'client', /do not stop the newer Runtime/],
    [identity('0.4.0', 'new'), identity('0.3.8', 'old'), 'runtime', /runtime --operation stop --extract null/],
    [identity('0.4.0', 'a'), identity('0.4.0', 'b'), 'undetermined', /fingerprints alone cannot identify/],
    [identity('0.4.0', 'a', '26.3.0'), identity('0.4.0', 'b', '26.4.0'), 'undetermined', /fingerprints alone cannot identify/],
  ]) assert.throws(() => requireCompatible({ identity: runtime, runtimeId: 'test', pid: 1 }, client), error => {
    assert.equal(error.details.outdatedSide, side); assert.deepEqual(error.details.client, client); assert.deepEqual(error.details.runtime, runtime);
    assert.match(error.message, instruction); return true;
  });
});

test('a loaded client pins its fingerprint before its first request even if installed files change', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-startup-fingerprint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  for (const name of ['bin', 'runtime']) fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  const modulePath = path.join(directory, 'bin/runtime-directory.js');
  const script = `const fs = require('node:fs'); const {spawnSync} = require('node:child_process');
    const runtime = require(${JSON.stringify(modulePath)}); const before = runtime.runtimeIdentity().code;
    fs.writeFileSync(${JSON.stringify(path.join(directory, 'bin/build-marker.txt'))}, 'new installation');
    const after = runtime.runtimeIdentity().code;
    const next = spawnSync(process.execPath, ['-e', ${JSON.stringify('process.stdout.write(require(' + JSON.stringify(modulePath) + ').runtimeIdentity().code)')}], {encoding:'utf8'});
    process.stdout.write(JSON.stringify({before, after, next:next.stdout, status:next.status}));`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 0); assert.equal(result.before, result.after); assert.notEqual(result.before, result.next);
});
