'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { validateCommandArguments } = require('../bin/command-registry');
const { createIOSRuntimeFixture } = require('../test-support/ios-runtime-fixture');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { runCli } = require('../test-support/cli-client');
const schema = 'aab.ios-h5-target/v1';

test('Intent observation selection is explicit and separate from the frozen execution target', () => {
  const target = { platform: 'ios', deviceId: 'phone', bundleId: 'example.reader' };
  for (const observationTarget of [null, { webViewId: 'reader' }]) {
    assert.deepEqual(validateCommandArguments('intent', { operation: 'start', target, provider: 'h5',
      goal: 'edit the selected view', observationTarget }).observationTarget, observationTarget);
    assert.deepEqual(validateCommandArguments('intent', { operation: 'observe', operationId: 'one',
      basedOnRevision: 1, observationTarget }).observationTarget, observationTarget);
  }
  assert.throws(() => validateCommandArguments('intent', { operation: 'start', goal: 'read', provider: 'h5',
    target: { ...target, webViewId: 'old-location' } }), error => error.field === 'target.webViewId');
  for (const observationTarget of [{}, { webViewId: '' }, { webViewId: 'reader', bundleId: 'other.app' }]) {
    assert.throws(() => validateCommandArguments('intent', { operation: 'observe', operationId: 'one', observationTarget }));
  }
  assert.throws(() => validateCommandArguments('intent', { operation: 'observe', operationId: 'one',
    observationTarget: 'null' }), error => error.field === 'observationTarget');
});

test('CLI starts Intent and changes selected views while MCP acts on the same operation and archives its evidence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-intent-view-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const values = { left: 'original-left', right: 'original-right' }, actions = [];
  let device;
  const candidates = Object.keys(values).map(webViewId => ({ webViewId, title: 'Same form', url: 'https://fixture.test/form' }));
  const server = http.createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : null, url = new URL(req.url, 'http://localhost');
    const send = data => res.end(JSON.stringify({ ...data, runtimeBinding: device.binding }));
    if (url.pathname === '/v1/status') return send({ ok: true, debugBridge: { runtimeEpoch: device.binding.runtimeEpoch,
      h5TargetSchema: schema, h5ExecutionSchema: 'aab.h5-execution/v1' } });
    if (url.pathname === '/v1/h5/dom') {
      const id = url.searchParams.get('webViewId');
      if (!Object.hasOwn(values, id)) {
        res.writeHead(409); return send({ ok: false, error: id === null ? 'ios_h5_webview_ambiguous' : 'ios_h5_webview_not_found',
          dispatched: false, ambiguous: false, webViews: candidates });
      }
      return send({ ok: true, h5TargetSchema: schema, pageRef: { schemaVersion: schema, runtimeEpoch: device.binding.runtimeEpoch,
        bundleId: device.binding.bundleId, processId: device.binding.processId, webViewId: id, documentId: `document-${id}`,
        url: 'https://fixture.test/form' }, dom: { documentId: `document-${id}`, url: 'https://fixture.test/form',
        title: 'Same form', readyState: 'complete', bodyText: values[id], bodyTextTruncated: false, truncated: false,
        controls: [{ elementId: 'e1', tag: 'input', id: 'name', name: '', type: 'text', text: '', ariaLabel: 'Name', href: '',
          value: values[id], editable: true, visible: true, disabled: false }] } });
    }
    if (url.pathname === '/v1/h5/action') {
      actions.push(body);
      const id = body.payload.pageRef.webViewId;
      values[id] = body.payload.text;
      const { timeoutMs, ...execution } = body.execution;
      return send({ ok: true, dispatched: true, ambiguous: false, settled: true, actionId: body.actionId,
        runtimeEpoch: execution.runtimeEpoch, execution: { ...execution, settled: true } });
    }
    res.writeHead(404); send({ ok: false, error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  device = createIOSRuntimeFixture(directory, { port: server.address().port, deviceId: path.basename(directory) });
  const clients = [];
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(directory, 'ownership') };
  const connect = async label => {
    const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'),
      transcriptPath: path.join(directory, `${label}.jsonl`), stderrPath: path.join(directory, `${label}.log`),
      env });
    clients.push(client); await client.initialize();
    return client;
  };
  t.after(async () => { for (const client of clients) await client.close({ stdinEof: true }); });
  let client = await connect('first');
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const target = { platform: 'ios', ...device.args };
  let state = (await runCli('intent', { operation: 'start', target, provider: 'h5', goal: 'Edit each visible form without switching Apps',
    recordingDir: path.join(directory, 'recording') }, { env })).value;
  assert.equal(state.status, 'waiting_for_observation', JSON.stringify(state));
  assert.deepEqual(state.observationFailure.response.webViews, candidates);
  assert.ok(state.observationFailure.evidenceId);
  const operationId = state.operationId;
  const observe = async args => (await runCli('intent', { operation: 'observe', operationId, ...args }, { env })).value;
  const input = (revision, decisionId, value) => run('intent', { operation: 'decide', operationId,
    decision: { decisionId, basedOnRevision: revision, agentDecision: 'act', action: { action: 'inputText', selector: { elementId: 'e1' }, value } } });
  state = await observe({ observationTarget: { webViewId: 'left' } });
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.summary.page.webViewId, 'left');
  assert.deepEqual(state.observationTarget, { webViewId: 'left' });
  state = await input(state.revision, 'edit-left', 'left-edited');
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.summary.page.webViewId, 'left', 'post-action observation keeps the committed view');
  const leftRevision = state.revision;
  state = await observe({ basedOnRevision: leftRevision, observationTarget: { webViewId: 'right' } });
  assert.equal(state.summary.page.webViewId, 'right');
  const stale = await input(leftRevision, 'stale-left', 'never-write');
  assert.equal(stale.error, 'reobserve_required'); assert.equal(stale.dispatched, false); assert.equal(actions.length, 1);
  state = await input(state.revision, 'edit-right', 'right-edited');
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.deepEqual(values, { left: 'left-edited', right: 'right-edited' });
  const failed = await observe({ observationTarget: { webViewId: 'missing' } });
  assert.equal(failed.status, 'waiting_for_observation'); assert.equal(failed.error, 'ios_h5_webview_not_found');
  assert.deepEqual(failed.observationTarget, { webViewId: 'right' }, 'failed selection is not committed');
  assert.deepEqual(failed.observationFailure.observationTarget, { webViewId: 'missing' });
  assert.deepEqual(failed.observationFailure.response.webViews, candidates);
  assert.equal((await input(state.revision, 'blocked-old', 'never-write')).error, 'not_waiting_for_decision');
  state = await observe({});
  assert.equal(state.summary.page.webViewId, 'right'); assert.equal(state.observationFailure, null);
  const ambiguous = await observe({ observationTarget: null });
  assert.equal(ambiguous.error, 'ios_h5_webview_ambiguous');
  state = await observe({ observationTarget: { webViewId: 'right' } });
  const done = await run('intent', { operation: 'decide', operationId,
    decision: { decisionId: 'done', basedOnRevision: state.revision, agentDecision: 'complete' } });
  assert.equal(done.status, 'completed');
  const exported = await run('evidence', { operation: 'export', namespace: 'intent', operationId,
    outputDir: path.join(directory, 'archive'), includeRecordedPayloads: true });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const verified = await run('evidence', { operation: 'verify', archiveDir: exported.archiveDir, manifestSha256: exported.manifestSha256 });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  await client.close({ stdinEof: true }); client = await connect('restarted');
  const recovered = await run('intent', { operation: 'status', operationId });
  assert.equal(recovered.recovered, true, JSON.stringify(recovered));
  assert.equal(recovered.status, 'completed');
  assert.deepEqual(recovered.observationTarget, { webViewId: 'right' });
  assert.equal(actions.length, 2);
});
