'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { getProcessDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { createFakeIntentDeviceAdapter } = require('../bin/intent/intent-device-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { handle: intentHandle, resetIntentOperations } = require('./helpers/intent-entry');
const { handle: scriptHandle, createProductionHost } = require('../bin/script/script-entry');
const { createScriptHostPort } = require('../bin/script/script-host-port');

function codeSpec(source, serial) {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p4-wire',
    language: 'javascript',
    source,
    target: { platform: 'android', serial, packageName: 'com.example.app' },
  };
}

async function waitDone(operationId, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  let afterSequence = 0;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await scriptHandle({
      operation: 'wait',
      operationId,
      waitMs: Math.max(1, Math.min(200, deadline - Date.now())),
      afterSequence,
    });
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    afterSequence = snapshot.eventSequence;
  }
  return scriptHandle({ operation: 'status', operationId, afterSequence: 0 });
}

test('P4 createProductionHost rejects missing production actions', () => {
  assert.throws(() => createProductionHost({ handlers: {} }), /host_actions_required/);
});

test('P4 createProductionHost uses ScriptHostPort when actions are provided', () => {
  const host = createProductionHost({
    actions: async () => ({ ok: true }),
    runner: async () => ({ ok: true, coverage: { status: 'unavailable', gap: true, committed: false }, refs: [], items: [] }),
  });
  assert.equal('actionCallCount' in host, true);
});

test('P4 script-entry routes mutations through injected actions', async () => {
  const commands = [];
  const seen = [];
  const started = await scriptHandle({
    operation: 'start',
    script: codeSpec(`
async function main(ctx) {
  await ctx.call('tap-text', { text: 'Go' });
  return { ok: true };
}
module.exports = { main };
`, 'p4-wire-serial'),
    actions: async (command, args) => {
      commands.push(command);
      seen.push(args);
      return { ok: true };
    },
    runner: async () => ({
      ok: true,
      coverage: { status: 'complete', gap: false, committed: true },
      refs: [],
      items: [],
    }),
  });
  const done = await waitDone(started.operationId);
  assert.equal(done.status, 'completed');
  assert.equal(commands.includes('tap-text'), true);
  assert.equal(seen[0].serial, 'p4-wire-serial');
  assert.equal(seen[0].packageName, 'com.example.app');
  assert.equal(seen[0].requestId, `${started.operationId}:action-1`);
});

test('P4 Intent action uses the process device-mutation lease', async () => {
  resetIntentOperations();
  const serial = 'p4-intent-lease';
  const held = getProcessDeviceMutationLease().acquire(serial);
  try {
    const adapter = createFakeIntentDeviceAdapter({
      trees: {
        native: { root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] } },
      },
    });
    const started = await intentHandle({
      operation: 'start',
      operationId: 'p4-lease',
      goal: 'tap',
      target: { platform: 'android', serial, packageName: 'com.example.app' },
      store: createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
      adapter,
    });
    const decided = await intentHandle({
      operation: 'decide',
      operationId: 'p4-lease',
      decision: {
        decisionId: 'p4-d1',
        agentDecision: 'act',
        basedOnRevision: started.revision,
        action: { action: 'tap', selector: { text: 'Home' } },
      },
    });
    assert.equal(decided.error, 'target_busy');
    assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 0);
  } finally {
    held.release();
    resetIntentOperations();
  }
});

test('P4 process lease held by Intent blocks ScriptHostPort on the same serial', async () => {
  const serial = 'p4-shared-lease';
  const held = getProcessDeviceMutationLease().acquire(serial);
  try {
    const host = createScriptHostPort({
      mutationLease: getProcessDeviceMutationLease(),
      target: { platform: 'android', serial, packageName: 'com.example.app' },
      actions: async () => ({ ok: true }),
      runner: async () => ({
        ok: true,
        coverage: { status: 'complete', gap: false, committed: true },
        refs: [],
        items: [],
      }),
    });
    const tap = await host.call('tap', { text: 'Home' });
    assert.equal(tap.error, 'target_busy');
    assert.equal(host.actionCallCount, 0);
  } finally {
    held.release();
  }
});

test('P4 production wiring files stay off Legacy Batch and MCP', () => {
  for (const file of ['script-entry.js', 'script-host-port.js', 'script-supervisor.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/script', file), 'utf8');
    assert.equal(/legacy\/|runBatch|runBridgeChecked|mcp-server|target-execution/.test(source), false, file);
  }
  const executor = fs.readFileSync(
    path.join(__dirname, '../bin/intent/intent-action-executor.js'),
    'utf8',
  );
  assert.equal(/script\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(executor), false);
});
