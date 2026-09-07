'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handle, resetScriptOperations } = require('../bin/script/script-entry');
const { createFakeHostPort } = require('../bin/script/fake-host-port');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');

const JS_SOURCE = fs.readFileSync(path.join(__dirname, 'fixtures/p7-g4a.js'), 'utf8');

const TREE = {
  root: {
    id: 'root',
    className: 'FrameLayout',
    children: [
      { id: 'about', className: 'Button', text: 'About', clickable: true },
      { id: 'license', className: 'TextView', text: 'License Notices' },
    ],
  },
};

function stepsDoc() {
  return {
    name: 'p7-dual',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    steps: [
      { id: 'o1', type: 'observe', provider: 'native' },
      { id: 'a1', type: 'action', action: 'tap', text: 'About' },
      { id: 'k1', type: 'checkpoint' },
      { id: 's1', type: 'assert', text: 'License Notices' },
    ],
  };
}

async function waitDone(supervisor, operationId, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  let afterSequence = 0;
  while (Date.now() < deadline) {
    const snapshot = await supervisor.handle({
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
  return supervisor.handle({ operation: 'status', operationId, afterSequence: 0 });
}

test('P7 G8 device speed no longer requires the old production adapter', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/g8-device-speed.js'), 'utf8');
  assert.equal(/script-production-adapter/.test(source), false);
  assert.equal(/mcp-server\.js/.test(source), true);
});

test('P7 production entry rejects old steps and completes the code runtime', async () => {
  resetScriptOperations();
  const steps = await handle({
    operation: 'start',
    operationId: 'p7-dual-steps',
    script: stepsDoc(),
  });
  assert.equal(steps.error, 'script_format_removed');

  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p7-dual-code',
      language: 'javascript',
      source: JS_SOURCE,
      target: { serial: 'b46093e6', packageName: 'com.example.app' },
    },
    host: createFakeHostPort({
      handlers: {
        tree: async () => ({
          ok: true,
          result: TREE,
          refs: [{ stream: 'tree', rawTreeId: 'g4a' }],
        }),
      },
    }),
  });
  const code = await waitDone(supervisor, started.operationId);
  assert.equal(code.status, 'completed');
});
