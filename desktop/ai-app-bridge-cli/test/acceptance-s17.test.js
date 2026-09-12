'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { handle, resetScriptOperations } = require('../bin/script/script-entry');

function scriptDoc() {
  return {
    name: 's17',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    steps: [
      { id: 'o1', type: 'observe', provider: 'native' },
      { id: 'a1', type: 'action', action: 'tap', text: 'About' },
      { id: 'k1', type: 'checkpoint' },
      { id: 's1', type: 'assert', text: 'About' },
    ],
  };
}

test('S17 production entry rejects old steps instead of compiling them', async () => {
  resetScriptOperations();
  const result = await handle({
    operation: 'start',
    operationId: 's17-progress',
    script: scriptDoc(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'script_format_removed');
});

test('S17 a persisted steps checkpoint is not restored', async () => {
  resetScriptOperations();
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    operationId: 's17-restore',
    revision: 1,
    stepId: 'start',
    status: 'paused_manual',
    script: scriptDoc(),
  });
  const missing = await handle({ operation: 'status', operationId: 's17-restore' });
  assert.equal(missing.error, 'unknown_operation');
  const restored = await handle({
    operation: 'resume',
    operationId: 's17-restore',
    store,
  });
  assert.equal(restored.error, 'script_format_removed');
});
