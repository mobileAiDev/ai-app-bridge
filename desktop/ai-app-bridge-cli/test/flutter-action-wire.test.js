'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { executeCommand } = require('../bin/ai-app-bridge');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');

test('public Flutter actions carry the Host action ID through the real HTTP boundary', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-flutter-action-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = server.address().port;
  const adb = createAdbHttpFixture({ directory, serial: 'flutter-wire', port });
  const options = { adb, port, serial: 'flutter-wire', packageName: 'sample' };
  for (const [command, args, action] of [
    ['tap-flutter', { tapX: '0', tapY: 25.5 }, 'tapAt'],
    ['tap-flutter-text', { targetText: 'Settings' }, 'tapText'],
    ['input-flutter-text', { text: 'typed' }, 'inputText'],
    ['scroll-flutter', { delta: 300 }, 'scrollBy'],
    ['scroll-flutter', { targetText: 'About' }, 'scrollUntilText'],
    ['flutter-action', { payload: JSON.stringify({ action: 'back', actionId: 'untrusted-payload' }) }, 'back'],
  ]) {
    const result = await executeCommand(command, { ...options, ...args, runtimeActionId: 'host-owned' });
    assert.equal(result.ok, true);
    assert.deepEqual(requests.at(-1), { path: '/v1/flutter/action', body: {
      ...result.request, action, actionId: 'host-owned',
    } });
  }
  await executeCommand('flutter-action', { ...options, payload: '{"action":"back","actionId":"explicit-direct"}' });
  assert.equal(requests.at(-1).body.actionId, 'explicit-direct');
  await executeCommand('tap-flutter-text', { ...options, targetText: 'Settings' });
  assert.equal(Object.hasOwn(requests.at(-1).body, 'actionId'), false);
});

test('typed Flutter tap is discoverable, permission gated, and rejects bad coordinates before dispatch', async () => {
  const { authorizeCommand } = require('../bin/script/script-catalog');
  const { runBridgeChecked, buildBridgeCliArgs, capabilityPayload } = require('../bin/mcp-server');
  const capability = capabilityPayload({ command: 'tap-flutter', includeOptions: true });
  assert.equal(capability.ok, true);
  assert.deepEqual(capability.options, ['serial', 'packageName', 'tapX', 'tapY']);
  assert.match(capability.summary, /logical coordinates/);
  assert.equal(authorizeCommand('tap-flutter', ['app.interact']).ok, true);
  assert.equal(authorizeCommand('tap-flutter', ['app.read']).error, 'permission_not_granted');
  assert.equal(authorizeCommand('flutter-action').error, 'command_not_in_catalog');
  let dispatched = 0;
  for (const coordinates of [{}, { tapX: 1 }, { tapX: null, tapY: 1 }, { tapX: '', tapY: 1 },
    { tapX: false, tapY: 1 }, { tapX: -1, tapY: 2 }, { tapX: Infinity, tapY: 2 }]) {
    assert.throws(() => buildBridgeCliArgs('tap-flutter', coordinates), /invalid_flutter_coordinates/);
    const r = await runBridgeChecked('tap-flutter', { packageName: 'pkg', ...coordinates }, {
      targetExecution: { execute() { dispatched++; } }, rawRunner: async () => { dispatched++; },
    });
    assert.equal(JSON.parse(r.content[0].text).error, 'invalid_flutter_coordinates');
  }
  assert.equal(dispatched, 0);
  const valid = buildBridgeCliArgs('tap-flutter', { tapX: 0, tapY: 2.5 });
  assert.equal(valid[valid.indexOf('--tap-y') + 1], '2.5');
});
