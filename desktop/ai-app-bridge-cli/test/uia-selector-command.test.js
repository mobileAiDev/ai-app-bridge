'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stopRuntime } = require('../test-support/runtime-control');
const { createUiaRuntimeFixture } = require('../test-support/uia-runtime-fixture');
const { runCli } = require('../test-support/cli-client');
const { executeCommand } = require('../test-support/host-client');
const { commandContract } = require('../bin/command-registry');

const node = (extra, children = '') => `<node package="example.uia" class="android.widget.LinearLayout"
  enabled="true" visible-to-user="true" clickable="true" bounds="[0,0][100,100]" ${extra}>${children}</node>`;
const xml = `<hierarchy>${node('content-desc="全部文件" resource-id="example.uia:id/row"',
  node('text="全部文件" resource-id="example.uia:id/title"'))}</hierarchy>`;

async function fixture(t, content = xml) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-uia-selector-'));
  const peer = await createUiaRuntimeFixture({ directory, xml: content });
  t.after(async () => { await stopRuntime(); await peer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const args = { serial: peer.serial, adb: peer.adb, packageName: 'example.uia', feedback: 'off' };
  return { peer, args };
}

test('explicit UIA fields distinguish a parent accessibility label from its child text through the public CLI', async t => {
  const { peer, args } = await fixture(t);
  for (const [index, selector] of [{ text: '全部文件' }, { contentDescription: '全部文件' },
    { resourceName: 'example.uia:id/title' }].entries()) {
    const id = `precise-uia:${index}`;
    const result = (await runCli('tap-uia', { ...args, selector, requestId: id })).value;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.executionReceipt.actionId, id);
    assert.deepEqual(result.selector, selector);
    assert.deepEqual(result.request.target.selector, { kind: Object.keys(selector)[0], value: Object.values(selector)[0],
      exact: true, packageName: args.packageName });
  }
  assert.deepEqual(peer.dispatches, ['precise-uia:0', 'precise-uia:1', 'precise-uia:2']);
});

test('a precise text selector neither falls back to a description nor picks between duplicate text nodes', async t => {
  const duplicate = `<hierarchy>${node('text="Duplicate"')}${node('text="Duplicate"')}${node('content-desc="Description only"')}</hierarchy>`;
  const { peer, args } = await fixture(t, duplicate);
  for (const [text, error] of [['Duplicate', 'uia_selector_not_unique'], ['Description only', 'uia_selector_not_found']]) {
    const value = await executeCommand('tap-uia', { ...args, selector: { text } });
    assert.equal(value.error, error, JSON.stringify(value));
    assert.equal(value.dispatched, false); assert.equal(value.ambiguous, false);
  }
  assert.deepEqual(peer.dispatches, []);
});

test('precise UIA selection preserves foreground binding and rejects mixed fields before dispatch', async t => {
  const { peer, args } = await fixture(t);
  const foreground = await executeCommand('tap-uia', { ...args, packageName: 'another.app', selector: { text: '全部文件' } });
  assert.equal(foreground.error, 'foreground_package_mismatch'); assert.equal(foreground.dispatched, false);
  const invalid = await executeCommand('tap-uia', { ...args, selector: { text: '全部文件', contentDescription: '全部文件' } });
  assert.equal(invalid.ok, false); assert.equal(invalid.dispatched, false);
  assert.deepEqual(peer.dispatches, []);
});

test('precise UIA command is a shared CLI, MCP and Script interaction capability', () => {
  const contract = commandContract('tap-uia');
  assert.deepEqual(contract.entrypoints, { cli: true, mcp: true, script: true });
  assert.equal(contract.script.permission, 'app.interact');
  assert.equal(contract.targetKind, 'android-app');
  assert.equal(contract.execution.mutation, true);
});
