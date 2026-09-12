'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uiaTree, uiaTreeOnce } = require('../bin/device-provider');
const { createUiaRuntimeFixture } = require('../test-support/uia-runtime-fixture');
const { runExecution } = require('../bin/shared-kernel/execution-scope');
const { runCli } = require('../test-support/cli-client');
const { stopRuntime } = require('../test-support/runtime-control');

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-uia-observe-'));
  const peer = await createUiaRuntimeFixture({ directory, ...options });
  peer.runtimeEnvs = [];
  t.after(async () => {
    for (const env of peer.runtimeEnvs) await stopRuntime({ env });
    await peer.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'window.xml'), '<hierarchy><node text="OLD_OPEN_PAGE"/></hierarchy>');
  return peer;
}

for (const [name, read] of [['uiaTree', uiaTree], ['uiaTreeOnce', uiaTreeOnce]]) {
  test(`${name} reads a fresh bound runtime snapshot each time without legacy dump or XML files`, async t => {
    let index = 0;
    const peer = await fixture(t, { xml: () => `<hierarchy><node text="PAGE_${++index}"/></hierarchy>` });
    const first = await read(peer), second = await read(peer);
    assert.match(first, /PAGE_1/); assert.match(second, /PAGE_2/);
    assert.match(second, /aab-snapshot-id=/); assert.match(second, /aab-ref=/);
    assert.notEqual(first.match(/aab-snapshot-id="([^"]+)/)[1], second.match(/aab-snapshot-id="([^"]+)/)[1]);
    const calls = fs.readFileSync(path.join(peer.directory, 'adb.jsonl'), 'utf8');
    assert.doesNotMatch(calls, /uiautomator|window.xml/);
    assert.equal(peer.requests.filter(r => r.op === 'observe').length, 2);
  });

  test(`${name} surfaces the runtime observation error once and never returns an old XML`, async t => {
    const peer = await fixture(t, { onRequest: body => body.op === 'observe'
      ? { httpStatus: 409, ok: false, error: 'uia_focused_window_unavailable', message: 'No focused window' } : undefined });
    await assert.rejects(read(peer), { code: 'uia_focused_window_unavailable' });
    assert.equal(peer.requests.filter(r => r.op === 'observe').length, 1);
    assert.doesNotMatch(fs.readFileSync(path.join(peer.directory, 'adb.jsonl'), 'utf8'), /uiautomator|window.xml/);
  });
}

test('an endpoint with a different runtime identity cannot provide observations', async t => {
  const peer = await fixture(t, { onRequest: (body, fixture) => body.op === 'status'
    ? { ...fixture.respond(body), runtimeEpoch: 'cccccccc-cccc-4ccc-cccc-cccccccccccc' } : undefined });
  await assert.rejects(uiaTree(peer), { code: 'uia_runtime_identity_mismatch' });
  assert.equal(peer.requests.some(r => r.op === 'observe'), false);
});

test('two independent Host processes allocate one verified forward under the shared OS connection lock', async t => {
  const peer = await fixture(t);
  fs.writeFileSync(path.join(peer.directory, 'forwards.txt'), '');
  peer.runtimeEnvs = [1, 2].map(index => ({ AI_APP_BRIDGE_FACT_STORE_DIR: path.join(peer.directory, `facts-${index}`) }));
  const reads = await Promise.all(peer.runtimeEnvs.map(env => runCli('uia-tree', { adb: peer.adb, serial: peer.serial }, { env })));
  for (const result of reads) assert.equal(result.code, 0, JSON.stringify(result));
  const owners = await Promise.all(peer.runtimeEnvs.map(env => runCli('runtime', { operation: 'status' }, { env })));
  assert.equal(new Set(owners.map(owner => owner.value.runtimeId)).size, 2);
  assert.equal(new Set(owners.map(owner => owner.value.pid)).size, 2);
  const calls = fs.readFileSync(path.join(peer.directory, 'adb.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[2] === 'forward' && args[3] === 'tcp:0').length, 1);
  assert.equal(peer.requests.filter(r => r.op === 'observe').length, 2);
});

test('cancelling a submitted HTTP observation closes the request without restarting the phone runtime', { timeout: 10000 }, async t => {
  let entered, closed;
  const ready = new Promise(resolve => { entered = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const peer = await fixture(t, { onRequest: async (body, fixture, req, res) => {
    if (body.op !== 'observe') return;
    res.on('close', closed); entered();
    await disconnected;
  } });
  const controller = new AbortController();
  const reading = runExecution({ timeoutMs: 5000, signal: controller.signal, mutation: false }, () => uiaTree(peer));
  const rejected = assert.rejects(reading, { code: 'cancelled', dispatched: false, ambiguous: false });
  await ready; controller.abort({ code: 'cancelled' });
  await rejected; await disconnected;
  assert.equal(peer.requests.filter(r => r.op === 'observe').length, 1);
  assert.equal(peer.peer.running, true);
  assert.doesNotMatch(fs.readFileSync(path.join(peer.directory, 'adb.jsonl'), 'utf8'), /app_process|push|uiautomator/);
});
