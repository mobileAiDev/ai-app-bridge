'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUiaRuntimeFixture } = require('../test-support/uia-runtime-fixture');
const { createUiaRuntimePort } = require('../bin/shared-kernel/uia-runtime-port');
const { executeUiaAction } = require('../bin/shared-kernel/uia-execution');
const { getProcessDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const protocol = require('../bin/shared-kernel/uia-protocol');

// A real authenticated HTTP peer, with a controlled process-lock / ADB backend.
// Filesystem reclamation and actual app_process ownership have separate JVM/device proof.
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-uia-lifecycle-'));
  const peer = await createUiaRuntimeFixture({ directory, capacity: 1, ...options });
  t.after(async () => { await peer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const root = protocol.rootDirectory, calls = [];
  const state = { owned: true, launches: 0, probes: 0, launchError: null, afterProbe: null };
  const write = (remote, value) => { const file = peer.phoneFile(remote); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const read = remote => fs.existsSync(peer.phoneFile(remote)) ? fs.readFileSync(peer.phoneFile(remote), 'utf8') : 'null';
  const run = async (adb, args) => {
    assert.equal(adb, peer.adb); assert.deepEqual(args.slice(0, 2), ['-s', peer.serial]); calls.push(args);
    const stdout = value => ({ stdout: String(value), stderr: '' });
    if (args[2] === 'push') { write(args[4], fs.readFileSync(args[3])); return stdout(''); }
    if (args[2] === 'forward') {
      const file = path.join(directory, 'forwards.txt');
      if (args[3] === '--list') return stdout(fs.readFileSync(file, 'utf8'));
      if (args[3] === '--remove') {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(line => line && line.split(' ')[1] !== args[4]).join('\n'));
        return stdout('');
      }
      assert.equal(args[3], 'tcp:0');
      fs.writeFileSync(file, `${peer.serial} tcp:${peer.port} ${args[4]}\n`); return stdout(peer.port);
    }
    assert.deepEqual(args.slice(2, 5), ['shell', 'sh', '-c']);
    const script = args[5].slice(1, -1).replaceAll("'\\''", "'");
    let match;
    if (script === 'getprop ro.build.version.sdk') return stdout('36');
    if (script.startsWith('umask 077\nmkdir -p ')) return stdout('');
    if ((match = script.match(/^if \[ -f '([^']+)' \]; then cat '\1'; else printf '%s' null; fi$/))) return stdout(read(match[1]));
    if ((match = script.match(/^if \[ -f '([^']+)' \]; then sha256sum '\1'; else printf '%s' null; fi$/))) {
      const file = peer.phoneFile(match[1]); return stdout(fs.existsSync(file) ? protocol.digest(fs.readFileSync(file)) + '  ' + match[1] : 'null');
    }
    if ((match = script.match(/^sha256sum '([^']+)'$/))) return stdout(protocol.digest(fs.readFileSync(peer.phoneFile(match[1]))) + '  ' + match[1]);
    if ((match = script.match(/^mv -n '([^']+)' '([^']+)'$/))) {
      if (!fs.existsSync(peer.phoneFile(match[2]))) fs.renameSync(peer.phoneFile(match[1]), peer.phoneFile(match[2]));
      return stdout('');
    }
    if ((match = script.match(/^rm -f '([^']+)'$/))) { fs.rmSync(peer.phoneFile(match[1]), { force: true }); return stdout(''); }
    if (script.endsWith(' owner-status')) {
      state.probes++;
      const owned = state.owned; state.afterProbe?.();
      return stdout(JSON.stringify({ ok: true, schemaVersion: 'aab.uia.owner.v1', root, dexSha256: peer.peer.dexSha256, owned }));
    }
    if (script.includes('setsid nohup app_process')) {
      state.launches++;
      try {
        if (state.launchError) throw new Error(state.launchError);
        if (state.owned && peer.peer.running) throw new Error('uia_runtime_already_running');
        peer.rotate(); state.owned = true;
      } catch (error) { write(`${root}/startup.log`, JSON.stringify({ ok: false, error: error.message }) + '\n'); }
      return stdout('');
    }
    if (script === `tail -c 4096 '${root}/startup.log'`) return stdout(read(`${root}/startup.log`));
    throw new Error(`Unsupported lifecycle fixture call: ${script}`);
  };
  const port = createUiaRuntimePort({ adb: peer.adb, serial: peer.serial, run, timeoutMs: 350 });
  const observe = async () => {
    const snapshot = await port.observe();
    return protocol.observedTarget(snapshot.xml, { 'aab-ref': snapshot.xml.match(/aab-ref="([^"]+)/)[1] }, { text: 'Button' }, 'example.uia');
  };
  const click = (binding, actionId) => getProcessDeviceMutationLease().run(peer.serial,
    () => executeUiaAction({ adb: peer.adb, serial: peer.serial, binding, actionId, port }));
  return { peer, port, state, calls, observe, click, write, run };
}

test('new observation rotates a full acknowledged epoch; an already bound old node never rotates or dispatches', async t => {
  const f = await fixture(t), before = await f.observe();
  const first = await f.click(before, 'epoch-one'); assert.equal(first.ok, true);
  const full = await f.click(before, 'full-old-binding');
  assert.equal(full.error, 'uia_action_capacity_exhausted'); assert.equal(full.dispatched, false); assert.equal(f.state.launches, 0);
  const after = await f.observe(); assert.notEqual(before.runtimeEpoch, after.runtimeEpoch); assert.equal(f.state.launches, 1);
  const stale = await f.click(before, 'stale-node'); assert.equal(stale.error, 'uia_stale_runtime'); assert.equal(stale.dispatched, false);
  assert.equal((await f.click(after, 'epoch-two')).ok, true);
  assert.deepEqual(f.peer.dispatches, ['epoch-one', 'epoch-two']);
  assert.equal(f.peer.requests.filter(body => body.op === 'stop').length, 1);
  assert.equal(getProcessDeviceMutationLease().status(f.peer.serial).active, 0);
});

test('concurrent Hosts share one rotation and one forward for the new epoch', async t => {
  const f = await fixture(t); await f.click(await f.observe(), 'last-in-epoch');
  const another = createUiaRuntimePort({ adb: f.peer.adb, serial: f.peer.serial, run: f.run, timeoutMs: 1000 });
  const snapshots = await Promise.all([f.port.observe(), another.observe()]);
  assert.equal(snapshots[0].runtimeEpoch, snapshots[1].runtimeEpoch); assert.equal(f.state.launches, 1);
  assert.equal(f.calls.filter(args => args[2] === 'forward' && args[3] === 'tcp:0').length, 1);
});

test('a full unacknowledged session stays available for original receipt recovery and does not rotate', async t => {
  const f = await fixture(t, { onRequest: body => body.op === 'acknowledge'
    ? { httpStatus: 503, ok: false, error: 'uia_journal_write_failed' } : undefined });
  const binding = await f.observe(); const result = await f.click(binding, 'unacknowledged');
  assert.equal(result.ok, true); assert.equal(result.cleanupError, 'uia_journal_write_failed');
  assert.equal((await f.observe()).runtimeEpoch, binding.runtimeEpoch); assert.equal(f.state.launches, 0);
  assert.equal(f.peer.records.get('unacknowledged').acknowledged, false);
  assert.equal(f.peer.requests.some(body => body.op === 'stop'), false);
});

test('pending work prevents rotation even when the action journal is full', async t => {
  const f = await fixture(t, { autoComplete: false }); const binding = await f.observe();
  const request = protocol.actionRequest(binding, { actionId: 'pending', timeoutMs: 1000 });
  const connection = await f.port.ensure();
  await f.port.action(connection, 'prepare', request); await f.port.action(connection, 'start', request);
  assert.equal((await f.observe()).runtimeEpoch, binding.runtimeEpoch); assert.equal(f.state.launches, 0);
  assert.equal(f.peer.requests.some(body => body.op === 'stop'), false);
  f.peer.complete('pending');
});

test('an unreachable observation never infers process death or launches a replacement', async t => {
  const f = await fixture(t, { onRequest: body => body.op === 'status' ? { close: true } : undefined });
  await assert.rejects(f.port.observe(), { code: 'uia_runtime_unreachable' }); assert.equal(f.state.launches, 0); assert.equal(f.state.probes, 0);
});

test('explicit start uses the OS-lock observation, preserves live ownership and never overwrites the loaded artifact', async t => {
  const f = await fixture(t); const epoch = f.peer.peer.runtimeEpoch;
  const first = await f.port.control('start'), second = await f.port.control('start');
  assert.equal(first.runtimeEpoch, epoch); assert.equal(second.runtimeEpoch, epoch); assert.equal(first.running, true);
  assert.equal(first.serial, f.peer.serial); assert.equal(f.state.probes, 2); assert.equal(f.state.launches, 0);
  assert.equal(f.calls.filter(args => args[2] === 'push').length, 1);
  assert.equal(JSON.stringify(first).includes(f.peer.peer.token), false);
});

test('explicit start can reopen a dead owner with terminal history, without replaying its action', async t => {
  const f = await fixture(t); const binding = await f.observe(); await f.click(binding, 'before-death');
  f.state.owned = false; // The descriptor deliberately still says running:true.
  const opened = await f.port.control('start');
  assert.notEqual(opened.runtimeEpoch, binding.runtimeEpoch); assert.equal(f.state.launches, 1);
  assert.deepEqual(f.peer.dispatches, ['before-death']); assert.equal(opened.count, 0);
});

test('a new owner winning after the probe still blocks launch at the process lock', async t => {
  const f = await fixture(t); f.state.owned = false; f.state.afterProbe = () => { f.state.owned = true; };
  const original = f.peer.peer.runtimeEpoch;
  await assert.rejects(f.port.control('start'), { code: 'uia_runtime_already_running' });
  assert.equal(f.peer.peer.runtimeEpoch, original); assert.equal(f.peer.dispatches.length, 0);
});

test('explicit start surfaces unresolved original history and leaves its files intact', async t => {
  const f = await fixture(t, { autoComplete: false }); const binding = await f.observe();
  const request = protocol.actionRequest(binding, { actionId: 'lost-callback', timeoutMs: 1000 });
  const connection = await f.port.ensure();
  await f.port.action(connection, 'prepare', request); await f.port.action(connection, 'start', request);
  const file = f.peer.phoneFile(`${connection.peer.sessionPath}/actions/${protocol.digest('lost-callback')}.json`);
  const original = fs.readFileSync(file); f.state.owned = false;
  await assert.rejects(f.port.control('start'), { code: 'uia_previous_action_unresolved' });
  assert.deepEqual(fs.readFileSync(file), original); assert.equal(f.peer.peer.runtimeEpoch, binding.runtimeEpoch);
  f.peer.complete('lost-callback');
});

test('a corrupt content-addressed executable is exposed without overwrite or process launch', async t => {
  const f = await fixture(t); f.write(`${protocol.rootDirectory}/runtime-${f.peer.peer.dexSha256}.jar`, 'corrupted');
  await assert.rejects(f.port.control('start'), { code: 'uia_runtime_artifact_mismatch' });
  assert.equal(f.state.probes, 0); assert.equal(f.state.launches, 0); assert.equal(f.calls.some(args => args[2] === 'push'), false);
});
