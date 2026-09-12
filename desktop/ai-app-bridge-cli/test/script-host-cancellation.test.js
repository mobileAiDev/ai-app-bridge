'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { execFileBounded } = require('../bin/shared-kernel/execution-io');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost } = require('../bin/script/script-entry');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createFileEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

for (const language of ['javascript', 'python']) {
  for (const dispatched of [false, true]) {
    test(`${language} cancel ${dispatched ? 'during dispatch' : 'during observation'} settles the Host call and its receipt before terminal`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-script-cancel-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const ready = path.join(dir, 'ready');
      const effect = path.join(dir, 'effect');
      const reopen = () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir: path.join(dir, 'store') }) });
      const supervisor = createScriptSupervisor({ createHost: createProductionHost });
      let calls = 0;
      const actions = async () => {
        calls++;
        await execFileBounded(process.execPath, ['-e', `
          const fs = require('node:fs');
          process.on('SIGTERM', () => {});
          fs.writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid));
    fs.renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});
          setInterval(() => {}, 1000);
        `], { mutation: dispatched, timeoutMs: 5000 });
        fs.writeFileSync(effect, 'unexpected continuation');
        return { ok: true };
      };
      const started = await supervisor.handle({ operation: 'start', store: reopen(), actions, script: {
        schemaVersion: 'aab.code-script/v1', language, target: { platform: 'android', serial: 'host-cancel-device', packageName: 'example.cancel' },
        policy: { timeoutMs: 10000 },
        source: language === 'javascript' ? 'module.exports.main = ctx => ctx.call("keyevent", {keyCode: 0});'
          : 'def main(ctx):\n    return ctx.call("keyevent", {"keyCode": 0})\n',
      } });
      assert.equal(started.ok, true, JSON.stringify(started));
      for (let i = 0; !fs.existsSync(ready) && i < 500; i++) await delay(10);
      assert.ok(fs.existsSync(ready));
      const pid = Number(fs.readFileSync(ready));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "ready must contain the actual child PID");
      const cancelled = await supervisor.handle({ operation: 'cancel', operationId: started.operationId });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.error, dispatched ? 'ambiguous' : null);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      const records = reopen().list(started.operationId);
      assert.equal(records.at(-1).status, 'cancelled');
      const receipt = records.find(row => row.kind === 'action-receipt');
      assert.equal(receipt.dispatched, dispatched);
      assert.equal(receipt.ambiguous, dispatched);
      assert.equal(receipt.error, 'cancelled');
      assert.equal(fs.existsSync(effect), false);
      const record = supervisor.registry.get(started.operationId);
      assert.equal(record.pendingCalls.size, 0);
      assert.equal((await record.host.call('status')).error, 'runtime_stopped');
      assert.equal(calls, 1);
    });
  }
}

test('cancel waits for an in-progress checkpoint write and prevents the next action', { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-checkpoint-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) });
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const delayed = { ...store, async persist(kind, record) {
    if (kind === 'checkpoint' && record.checkpoint?.name === 'held' && record.status === 'running') { entered(); await held; }
    return store.persist(kind, record);
  } };
  let effects = 0;
  const supervisor = createScriptSupervisor({ createHost: createProductionHost });
  const started = await supervisor.handle({ store: delayed, actions: async () => { effects++; return { ok: true }; }, script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', target: { platform: 'android', serial: 'checkpoint-device', packageName: 'example.checkpoint' },
    source: 'module.exports.main = async ctx => { await ctx.checkpoint("held", {}); return ctx.call("keyevent", {keyCode: 0}); };',
  } });
  await ready;
  const cancelling = supervisor.handle({ operation: 'cancel', operationId: started.operationId });
  await delay(30);
  assert.notEqual(store.latest(started.operationId, 'checkpoint').status, 'cancelled');
  assert.equal((await supervisor.handle({ operation: 'status', operationId: started.operationId })).status, 'cancelling');
  assert.equal((await supervisor.handle({ operation: 'resume', operationId: started.operationId })).error, 'runtime_stopped');
  release();
  assert.equal((await cancelling).status, 'cancelled');
  const checkpoints = store.list(started.operationId).filter(row => row.kind === 'checkpoint');
  assert.equal(checkpoints.at(-1).status, 'cancelled');
  assert.ok(checkpoints.at(-1).revision > checkpoints.at(-2).revision);
  assert.equal(effects, 0);
});
