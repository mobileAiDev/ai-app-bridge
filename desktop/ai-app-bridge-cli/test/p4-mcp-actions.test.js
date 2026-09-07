'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedScriptActions } = require('../bin/script/script-mcp-actions');

test('P4 MCP actions parse JSON tool payloads', async () => {
  const actions = createIsolatedScriptActions(async () => ({
    content: [{ text: JSON.stringify({ ok: true, command: 'tree' }) }],
  }));
  const result = await actions('tree', { text: 'About' });
  assert.equal(result.ok, true);
  assert.equal(result.command, 'tree');
});

test('P4 MCP actions return toolText as a one-shot ok false', async () => {
  const text = 'tap-text: packageName or explicit port is required in MCP mode so the command cannot fall back to a default package.';
  const actions = createIsolatedScriptActions(async () => ({
    content: [{ text }],
  }));
  const result = await actions('tap-text', { text: 'About' });
  assert.equal(result.ok, false);
  assert.equal(result.error, text);
  assert.equal(result.command, 'tap-text');
});

test('Script preserves the documented raw Android UIA XML response without accepting tool errors', async () => {
  const xml = '<?xml version="1.0"?><hierarchy><node text="Hello" /></hierarchy>';
  const actions = createIsolatedScriptActions(async () => ({ content: [{ text: xml }] }));
  assert.equal(await actions('uia-tree'), xml);
  const rejected = createIsolatedScriptActions(async () => ({ isError: true, content: [{ text: xml }] }));
  assert.equal((await rejected('uia-tree')).ok, false);
  assert.equal((await actions('tap')).ok, false);
});

test('P4 MCP actions stamp the Script target when a call omits it', async () => {
  let seen = null;
  const actions = createIsolatedScriptActions(async (command, args) => {
    seen = { command, args };
    return { content: [{ text: JSON.stringify({ ok: true }) }] };
  }, { serial: 'b46093e6', packageName: 'com.example.app' });
  await actions('tap-text', { text: 'About' });
  assert.equal(seen.command, 'tap-text');
  assert.equal(seen.args.text, 'About');
  assert.equal(seen.args.serial, 'b46093e6');
  assert.equal(seen.args.packageName, 'com.example.app');
});

test('P4 MCP actions keep an explicit call target', async () => {
  let seen = null;
  const actions = createIsolatedScriptActions(async (_command, args) => {
    seen = args;
    return { content: [{ text: JSON.stringify({ ok: true }) }] };
  }, { serial: 'other', packageName: 'com.other.app' });
  await actions('tap-text', { text: 'About', serial: 'b46093e6', packageName: 'com.example.app' });
  assert.equal(seen.serial, 'b46093e6');
  assert.equal(seen.packageName, 'com.example.app');
});
