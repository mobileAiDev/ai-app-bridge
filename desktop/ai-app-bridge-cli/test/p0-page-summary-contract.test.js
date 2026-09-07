'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { isolatedCommandDefinitions } = require('../bin/command-router');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const { capabilityPayload, runGeneric } = require('../bin/mcp-server');
const { executeCommand } = require('../bin/ai-app-bridge');
const snapshot = require('./fixtures/legacy-surface-g0.json');
const nativeFixture = require('./fixtures/summary-native.json');

test('P0 page-summary is not a top-level MCP, CLI, or isolated command', async () => {
  assert.equal(snapshot.commands.includes('page-summary'), false);
  assert.equal(isolatedCommandDefinitions.some((item) => item.command === 'page-summary'), false);

  const capability = capabilityPayload({ command: 'page-summary' });
  assert.equal(capability.ok, false);
  assert.equal(capability.command, 'page-summary');
  assert.equal(capability.error, 'unknown_command');

  const routed = await runGeneric({ command: 'page-summary' });
  assert.equal(routed.isError, true);
  assert.match(routed.content[0].text, /unknown command: page-summary/);

  await assert.rejects(
    executeCommand('page-summary', {}),
    /unknown command: page-summary/,
  );
});

test('P0 page-summary remains an internal summarizeTree transformer', () => {
  const transformer = fs.readFileSync(
    path.join(__dirname, '../bin/shared-kernel/summary-transformer.js'),
    'utf8',
  );
  assert.match(transformer, /function summarizeTree/);
  assert.equal(/child_process|adb |runBridgeChecked|mcp-server/.test(transformer), false);

  const summary = summarizeTree(nativeFixture);
  assert.equal(summary.ok, true);
  assert.equal(summary.nodes.length > 0, true);
  assert.equal(summary.nodes.every((node) => node.rawTreeId === 'native-tree-1'), true);
});
