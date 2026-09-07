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
      target: { serial: 'serial-1', packageName: 'com.example.app' },
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

test('P0 isolated timeout defaults to 120s and does not cancel the in-flight handle', async () => {
  const mcpSource = fs.readFileSync(path.join(__dirname, '../bin/mcp-server.js'), 'utf8');
  assert.match(mcpSource, /else if \(args\.isolatedTimeoutMs == null\) \{\n        args\.isolatedTimeoutMs = 120000;/);

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
    legacyDispatch: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    }),
  });
  const timedOut = JSON.parse((await router.route('script', { isolatedTimeoutMs: 20 })).content[0].text);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, 'isolated_timeout');
  assert.equal(handleFinished, false);
  await delay(80);
  assert.equal(handleFinished, true);
});

test('P0 capabilities(command=script) exposes trusted-local-code catalog; CLI has no Script surface', () => {
  const payload = capabilityPayload({ command: 'script', includeOptions: true });
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'script');
  assert.equal(payload.runtime, 'trusted-local-code');
  assert.match(payload.warning, /trusted-local-code/);
  assert.equal(payload.catalog.internalOnly.includes('page-summary'), true);
  assert.equal(payload.options.includes('operation'), true);
  assert.equal(payload.options.includes('waitMs'), true);

  const cli = fs.readFileSync(path.join(__dirname, '../bin/ai-app-bridge.js'), 'utf8');
  assert.equal(/^ {2}script\s/m.test(cli), false);
});
