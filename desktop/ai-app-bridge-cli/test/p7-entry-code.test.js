'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../bin/script/script-entry-code');

test('P7 code entry starts a JS script and rejects old steps', async () => {
  const started = await handle({
    operation: 'start',
    actions: async () => { throw new Error('unexpected_device_call'); },
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p7-entry-code',
      language: 'javascript',
      source: 'function main() { return { ok: true }; }\nmodule.exports = { main };',
    },
  });
  assert.equal(started.ok, true);
  const done = await handle({
    operation: 'wait',
    operationId: started.operationId,
    waitMs: 3000,
    afterSequence: 0,
  });
  assert.equal(done.status === 'completed' || done.status === 'running', true);
  if (done.status !== 'completed') {
    await handle({ operation: 'cancel', operationId: started.operationId });
  }
  const removed = await handle({
    operation: 'start',
    script: { name: 'old', steps: [{ id: 'o1', type: 'observe' }] },
  });
  assert.equal(removed.error, 'script_format_removed');
  const jsonRemoved = await handle({
    operation: 'start',
    operationId: started.operationId,
    script: JSON.stringify({ name: 'old', steps: [{ id: 'o1', type: 'observe' }] }),
  });
  assert.equal(jsonRemoved.error, 'script_format_removed');
  const yamlRemoved = await handle({
    operation: 'start',
    yaml: 'name: old\nsteps:\n  - id: o1\n    type: observe\n',
  });
  assert.equal(yamlRemoved.error, 'script_format_removed');
});
