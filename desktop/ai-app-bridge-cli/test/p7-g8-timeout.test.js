'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');

const HANGING = `
async function main() {
  await new Promise(() => {});
}
module.exports = { main };
`;

async function waitDone(supervisor, operationId, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  let afterSequence = 0;
  while (Date.now() < deadline) {
    const snapshot = await supervisor.handle({
      operation: 'wait',
      operationId,
      waitMs: Math.max(1, Math.min(100, deadline - Date.now())),
      afterSequence,
    });
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    afterSequence = snapshot.eventSequence;
  }
  return supervisor.handle({ operation: 'status', operationId, afterSequence: 0 });
}

test('P7 G8 code timeout stops hanging JavaScript scripts', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  for (let i = 0; i < 10; i += 1) {
    const started = await supervisor.handle({
      operation: 'start',
      script: {
        schemaVersion: 'aab.code-script/v1',
        name: `p7-g8-timeout-${i}`,
        language: 'javascript',
        source: HANGING,
        target: { platform: 'android', serial: 'p7', packageName: 'com.example.app' },
        policy: { timeoutMs: 80 },
      },
    });
    assert.equal(started.ok, true);
    const done = await waitDone(supervisor, started.operationId, 2000);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'timeout');
  }
});
