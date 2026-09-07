'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedScriptActions } = require('../bin/script/script-mcp-actions');
const { createScriptHostPort } = require('../bin/script/script-host-port');

test('P4 MCP dispatch keeps the Host-forced requestId when options.requestId is set', async () => {
  let seen = null;
  const actions = createIsolatedScriptActions(async (_command, args) => {
    seen = args;
    return { content: [{ text: JSON.stringify({ ok: true }) }] };
  }, { serial: 'phone-1', packageName: 'pkg' });
  const host = createScriptHostPort({
    executionId: 'script-force',
    target: { serial: 'phone-1', packageName: 'pkg' },
    actions,
  });
  const tap = await host.call('tap', { text: 'Go', requestId: 'caller-r1' }, { requestId: 'option-r2' });
  assert.equal(tap.execution.actionId, 'script-force:action-1');
  assert.equal(seen.requestId, 'script-force:action-1');
  assert.equal(seen.serial, 'phone-1');
  assert.equal(seen.packageName, 'pkg');
});

test('P4 MCP dispatch does not let options.requestId collapse two executions', async () => {
  const { TargetExecution } = require('../bin/target-execution');
  const execution = new TargetExecution();
  let providerRuns = 0;
  const dispatch = async (command, args) => {
    const result = await execution.execute(command, args, async () => {
      providerRuns += 1;
      return { ok: true, providerRun: providerRuns };
    });
    return { content: [{ text: JSON.stringify(result) }] };
  };
  const target = { serial: 'same', packageName: 'pkg' };
  const first = createScriptHostPort({
    executionId: 'script-A',
    target,
    actions: createIsolatedScriptActions(dispatch, target),
  });
  const second = createScriptHostPort({
    executionId: 'script-B',
    target,
    actions: createIsolatedScriptActions(dispatch, target),
  });
  const a = await first.call('tap', {}, { requestId: 'shared' });
  const b = await second.call('tap', {}, { requestId: 'shared' });
  assert.equal(providerRuns, 2);
  assert.notEqual(a.execution.actionId, b.execution.actionId);
  assert.notEqual(a.result.providerRun, b.result.providerRun);
});
