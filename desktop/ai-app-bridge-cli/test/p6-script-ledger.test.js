'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScriptLedger } = require('../bin/script/script-ledger');

test('Script call and receipt facts retain explicit system-app targets while lifecycle facts retain the owning App', () => {
  const port = createScriptLedger(), record = { operationId: 'cross-app', spec: { target: { platform: 'android', serial: 'phone', packageName: 'sample' } } };
  const args = { packageName: 'picker' };
  const target = { ...record.spec.target, packageName: 'picker', port: 23456 };
  for (const kind of ['call_started', 'call_completed', 'call_failed']) port.append(record, kind, { command: 'uia-tree', args, target }, 1000);
  port.append(record, 'action_receipt', { actionId: 'a1', target, payloadSummary: { args } }, 1001);
  port.append(record, 'script_completed', {}, 1002);
  const rows = port.ledger.query('cross-app', 0, 20).items;
  for (const row of rows.slice(0, 4)) assert.deepEqual(row.target, target);
  assert.deepEqual(rows[4].target, { platform: 'android', serial: 'phone', packageName: 'sample' });
  assert.deepEqual(record.spec.target, { platform: 'android', serial: 'phone', packageName: 'sample' });
});

test('P6 Script ledger records Host facts without mobile four-stream bodies', () => {
  const port = createScriptLedger();
  const record = {
    operationId: 'script-1',
    spec: { target: { platform: 'android', serial: 's', packageName: 'p' } },
  };
  port.append(record, 'call_started', { command: 'tap', target: record.spec.target }, 1000);
  port.append(record, 'action-receipt', {
    actionId: 'a1',
    payloadSummary: 'ok',
    evidenceRefs: ['mf1:1:1:abcd'],
    logs: [{ message: 'must-not-store' }],
  }, 1001);
  const page = port.ledger.query('script-1', 0, 10);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].kind, 'call_started');
  assert.equal(page.items[1].kind, 'action-receipt');
  assert.equal(page.items[1].evidenceRefs[0], 'mf1:1:1:abcd');
  assert.equal(page.items[1].schemaVersion, 'aab.execution-fact/v1');
  assert.equal(Object.hasOwn(page.items[1], 'logs'), false);
});

test('P6 Script ledger omits script result bodies from payloadSummary', () => {
  const port = createScriptLedger();
  const record = {
    operationId: 'script-2',
    spec: { target: { platform: 'android', serial: 's', packageName: 'p' } },
  };
  port.append(record, 'script_completed', {
    result: { items: [{ message: 'MOBILE_BODY' }] },
  }, 1002);
  const page = port.ledger.query('script-2', 0, 10);
  assert.equal(page.items[0].kind, 'script_completed');
  assert.equal(Object.hasOwn(page.items[0].payloadSummary, 'result'), false);
});

test('P6 Script ledger stays off Intent and Legacy modules', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/script-ledger.js'), 'utf8');
  assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false);
});
