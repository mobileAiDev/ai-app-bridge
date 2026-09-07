'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { handle, resetScriptOperations } = require('../bin/script/script-entry');
const { runBatch, runBridgeChecked, runGeneric } = require('../bin/mcp-server');

function scriptDoc() {
  return {
    name: 'g4a',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    steps: [
      { id: 'o1', type: 'observe', provider: 'native' },
      { id: 'a1', type: 'action', action: 'tap', text: 'About' },
      { id: 'k1', type: 'checkpoint' },
      { id: 's1', type: 'assert', text: 'License Notices' },
    ],
  };
}

test('G4-A production Script modules do not import Legacy, Intent, Batch, or runBridgeChecked', () => {
  const files = [
    'script-entry.js',
    'script-entry-code.js',
    'script-entry-route.js',
    'script-supervisor.js',
    'script-host-port.js',
    'script-errors.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/script', file), 'utf8');
    assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|LegacyDispatcher|mcp-server/.test(source), false, file);
  }
});

test('G4-A production entry rejects the old steps fixture', async () => {
  resetScriptOperations();
  const result = await handle({
    operation: 'start',
    script: scriptDoc(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'script_format_removed');
});

test('G4-A rejected steps leave Legacy and Intent usable', async () => {
  resetScriptOperations();
  const result = await handle({
    operation: 'start',
    script: scriptDoc(),
  });
  assert.equal(result.error, 'script_format_removed');

  const status = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => {
      throw new Error('status must not reach the runner without packageName or port');
    },
  });
  assert.match(status.content[0].text, /packageName or explicit port is required/);
  const intent = JSON.parse((await runGeneric({ command: 'intent', arguments: { operation: 'status' } })).content[0].text);
  assert.equal(intent.command, 'intent');
  const batch = JSON.parse((await runBatch({ steps: [{ id: 's1', command: 'script' }] })).content[0].text);
  assert.equal(batch.error, 'unknown_batch_step_command');
});
