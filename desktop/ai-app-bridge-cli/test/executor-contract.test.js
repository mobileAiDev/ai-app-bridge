'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReceiptJournal } = require('../bin/executors/receipt-journal');
const { validateCommandArguments, commandContract, isMutationCommand } = require('../bin/command-registry');
const { capabilities } = require('../bin/command-discovery');
const net = require('node:net');
const { AndroidExecutorPort, protocol } = require('../bin/executors/android-port');

test('executor operation discovery and validation expose the same strict contract', () => {
  const identity = { sessionId: 'session', runtimeEpoch: 'epoch', targetId: 'page', frameId: 'frame', documentId: 'document' };
  const act = { operation: 'act', ...identity, action: { type: 'click', selector: { by: 'testId', value: 'submit' } } };
  assert.doesNotThrow(() => validateCommandArguments('web-executor', act));
  for (const field of Object.keys(identity)) {
    const invalid = { ...act }; delete invalid[field];
    assert.throws(() => validateCommandArguments('web-executor', invalid));
  }
  assert.throws(() => validateCommandArguments('web-executor', { ...act, action: { ...act.action, businessField: 'changed' } }));
  assert.throws(() => validateCommandArguments('web-executor', { operation: 'status', actionId: 'ignored' }));
  assert.throws(() => validateCommandArguments('web-executor', { ...act,
    action: { type: 'wheel', selector: act.action.selector, deltaX: 0, deltaY: 200 } }));
  assert.equal(commandContract('web-executor').script.permission, 'app.test');
  assert.equal(isMutationCommand('web-executor', { operation: 'observe' }), false);
  assert.equal(isMutationCommand('web-executor', act), true);
  assert.deepEqual(capabilities({ command: 'web-executor', operation: 'act' }).inputSchema.required,
    ['operation', 'sessionId', 'runtimeEpoch', 'targetId', 'frameId', 'documentId', 'action']);
});

test('receipts survive restart, never re-dispatch unresolved actions, and reject conflicting reuse', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-executor-receipts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = { sessionId: 'session', runtimeEpoch: 'epoch', targetId: 'target' };
  const request = { type: 'click', selector: { by: 'testId', value: 'pay' } };
  const journal = new ReceiptJournal(directory, identity, { maxActions: 2 });
  const begun = journal.begin('payment-1', request);
  assert.equal(begun.fresh, true);
  assert.equal(begun.receipt.settled, false);
  const restarted = new ReceiptJournal(directory, identity, { maxActions: 2 });
  assert.equal(restarted.begin('payment-1', request).fresh, false);
  assert.throws(() => restarted.begin('payment-1', { ...request, type: 'doubleClick' }), { code: 'idempotency_conflict' });
  const result = { ok: true, dispatched: true, ambiguous: false };
  restarted.finish(begun.receipt, result);
  assert.deepEqual(journal.receipt('payment-1').result, result);
  assert.equal(journal.begin('payment-1', { selector: request.selector, type: request.type }).fresh, false);
  journal.begin('payment-2', request);
  assert.throws(() => journal.begin('payment-3', request), { code: 'executor_receipt_capacity' });
  assert.equal(journal.receipt('payment-1').phase, 'completed');
  assert.throws(() => new ReceiptJournal(directory, { ...identity, runtimeEpoch: 'other' }).receipt('payment-1'),
    { code: 'executor_receipt_identity_mismatch' });
  const secondPage = new ReceiptJournal(directory, { ...identity, targetId: 'popup' }, { maxActions: 2 });
  assert.throws(() => secondPage.begin('payment-1', request), { code: 'executor_receipt_identity_mismatch' });
  assert.throws(() => secondPage.begin('payment-3', request), { code: 'executor_receipt_capacity' });
});

test('Android executor forward keeps the request channel open until the authenticated reply', async t => {
  let endedBeforeReply = false;
  const descriptor = { adb: '/fixture/adb', serial: 'device', sessionId: 'session', runtimeEpoch: 'epoch', token: 'private-token' };
  const server = net.createServer(socket => {
    let request = '', replied = false;
    socket.on('end', () => { if (!replied) endedBeforeReply = true; });
    socket.on('data', data => {
      request += data;
      if (!request.endsWith('\n')) return;
      const parsed = JSON.parse(request);
      assert.equal(parsed.token, descriptor.token);
      setTimeout(() => {
        replied = true;
        socket.end(JSON.stringify({ protocol, sessionId: 'session', runtimeEpoch: 'epoch', ok: true }) + '\n');
      }, 20);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const forward = server.address().port;
  const port = new AndroidExecutorPort(descriptor, { run: async (adb, args) => {
    assert.equal(adb, descriptor.adb);
    assert.deepEqual(args.slice(0, 2), ['-s', descriptor.serial]);
    return { stdout: `device tcp:${forward} localabstract:aab-test-session\n` };
  } });
  assert.equal((await port.request({ operation: 'status', timeoutMs: 1000 })).ok, true);
  assert.equal(endedBeforeReply, false);
});

test('Android operation schemas require observed session and node identity', () => {
  const target = { serial: 'serial', packageName: 'fixture.app', sessionId: 'session', runtimeEpoch: 'epoch' };
  assert.doesNotThrow(() => validateCommandArguments('android-executor', { operation: 'observe', ...target, engine: 'espresso' }));
  assert.throws(() => validateCommandArguments('android-executor', { operation: 'observe', ...target }));
  assert.throws(() => validateCommandArguments('android-executor', { operation: 'act', ...target, action: { type: 'click', nodeId: '0' } }));
  assert.equal(isMutationCommand('android-executor', { operation: 'open' }), true);
  assert.equal(commandContract('android-executor').script.permission, 'app.test');
});

test('Android ownership distinguishes reboot, PID reuse, and a missing original identity', async () => {
  const original = '11111111-1111-4111-8111-111111111111';
  let bootId = original, stat = 'gone';
  const descriptor = { adb: '/fixture/adb', serial: 'device', targetPackage: 'fixture.app', bootId: original, pid: 42, processStartTicks: '900' };
  const port = new AndroidExecutorPort(descriptor, { run: async (adb, args) => ({ stdout: args.includes('/proc/sys/kernel/random/boot_id') ? bootId : stat }) });
  assert.equal(await port.processEnded(), true);
  const fields = ['S', ...Array(18).fill('0'), '900'];
  stat = `42 (app worker) ${fields.join(' ')}`;
  assert.equal(await port.processEnded(), false);
  fields[19] = '950'; stat = `42 (new app) ${fields.join(' ')}`;
  assert.equal(await port.processEnded(), true);
  bootId = '22222222-2222-4222-8222-222222222222';
  stat = 'unreadable after reboot';
  assert.equal(await port.processEnded(), true);
  delete descriptor.bootId;
  await assert.rejects(port.processEnded(), { code: 'executor_boot_identity_missing' });
});
