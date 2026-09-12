'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createCommandRouter } = require('../bin/command-router');
const { handle, resetScriptOperations } = require('../bin/script/script-entry');
const { capabilityPayload } = require('../bin/mcp-server');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('P0 Script start of old steps returns script_format_removed immediately', async () => {
  resetScriptOperations();
  let startReturned = false;
  const pending = handle({
    operation: 'start',
    script: {
      name: 'p0-script',
      target: { platform: 'android', serial: 'serial-1', packageName: 'com.example.app' },
      steps: [{ id: 'o1', type: 'observe', provider: 'native' }],
    },
  }).then((result) => {
    startReturned = true;
    return result;
  });
  await delay(15);
  assert.equal(startReturned, true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'script_format_removed');
});

test('stateful routing waits for the runtime result without an outer timeout race', async () => {
  let handleFinished = false;
  const router = createCommandRouter({
    loadScript: () => ({
      async handle() {
        await delay(80);
        handleFinished = true;
        return { ok: true, status: 'completed' };
      },
    }),
    loadIntent: () => ({ handle: async () => ({ ok: true }) }),
    dispatchCommon: async () => ({ value: { ok: true } }),
  });
  let returned = false;
  const pending = router.route('script', {}).then(result => { returned = true; return result; });
  await delay(20);
  assert.equal(returned, false);
  assert.equal(handleFinished, false);
  const result = (await pending).value;
  assert.equal(result.status, 'completed');
  assert.equal(handleFinished, true);
});

test('P0 Script discovery exposes trusted local code through both CLI and MCP', () => {
  const payload = capabilityPayload({ command: 'script', includeOptions: true });
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'script');
  assert.equal(payload.runtime, 'trusted-local-code');
  assert.match(payload.warning, /trusted-local-code/);
  assert.equal(payload.catalog.internalOnly.includes('page-summary'), true);
  assert.equal(payload.options.includes('operation'), true);
  assert.equal(payload.options.includes('waitMs'), true);

  assert.equal(payload.entrypoints.cli, true);
  assert.match(require('../bin/ai-app-bridge').helpText, /script\s/);
});
