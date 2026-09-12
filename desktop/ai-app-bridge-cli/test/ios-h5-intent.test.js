'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), http = require('node:http');
const { createIOSRuntimeFixture } = require('../test-support/ios-runtime-fixture');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { schema, selectH5Node } = require('../bin/shared-kernel/ios-h5-target');
const { validateCommandArguments, commandSchema } = require('../bin/command-registry');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const renderer = fs.readFileSync(path.resolve(__dirname, '../../../ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS/IOSH5Bridge.swift'), 'utf8')
  .match(/static let renderer = #"""\n([\s\S]*?)\n    """#/)[1];

const { createH5Page } = require('../test-support/h5-renderer-fixture');
const page = () => createH5Page(renderer);
const pageRef = dom => ({ schemaVersion: schema, runtimeEpoch: 'epoch-1', bundleId: 'pkg', processId: 42,
  webViewId: 'webview-1', documentId: dom.documentId, url: dom.url });
const tree = p => { const dom = p.snapshot(); return { h5TargetSchema: schema, pageRef: pageRef(dom), dom }; };
const requestFor = (p, selector, action = 'click', extra = {}) => {
  const observed = selectH5Node(tree(p), selector); assert.equal(observed.ok, true, JSON.stringify(observed));
  const request = { operation: 'action', action, ...observed.targetRef, ...extra };
  const prepared = p.run({ ...request, operation: 'prepare' });
  return { ...request, geometry: prepared.geometry };
};

test('H5 observations retain empty editors and distinguish rendered controls from viewport reachability', () => {
  const p = page(), editor = new p.Element('editor', '', 'DIV'), run = new p.Element('run', 'Run', 'BUTTON');
  editor.isContentEditable = true;
  run.rect = { left: 264, top: 914, right: 440, bottom: 956, width: 176, height: 42 };
  const rawTree = tree(p);
  assert.equal(rawTree.dom.controls[0].editable, true);
  assert.equal(rawTree.dom.controls[1].visible, true, 'rendered CSS is distinct from being inside the viewport');
  assert.equal(rawTree.dom.controls[1].interaction.status, 'outside-viewport');
  assert.deepEqual(rawTree.dom.viewport, { width: 400, height: 800, scrollX: 0, scrollY: 0 });
  const summary = summarizeTree({ provider: 'h5', rawTree, rawTreeId: 'real-layout' });
  assert.equal(summary.nodes.find(n => n.elementId === 'e1').role, 'input');
  assert.equal(summary.nodes.find(n => n.elementId === 'e1').editable, true);
  assert.equal(summary.nodes.find(n => n.elementId === 'e2').interaction.status, 'outside-viewport');
  assert.deepEqual(summary.page.viewport, rawTree.dom.viewport);
  const observed = selectH5Node(rawTree, { text: 'Run' });
  const request = { operation: 'prepare', action: 'click', ...observed.targetRef };
  assert.equal(p.run(request).error, 'ios_h5_target_outside_viewport');
  p.hit = run;
  const scrolled = p.run({ ...request, operation: 'action', action: 'scroll' });
  assert.equal(scrolled.interaction.status, 'ready');
  assert.deepEqual(p.events, ['scroll:run']);
});

test('H5 observation and action agree on DOM occlusion and text editing eligibility', () => {
  const p = page(), input = new p.Element('field', '', 'INPUT');
  p.hit = input;
  assert.equal(p.snapshot().controls[0].interaction.status, 'ready');
  for (const type of ['checkbox', 'radio', 'date', 'color', 'file', 'range']) {
    input.type = type;
    const request = requestFor(p, { elementId: 'e1' }, 'input', { text: 'invalid' });
    assert.equal(p.snapshot().controls[0].editable, false, type);
    assert.equal(p.run(request).error, 'ios_h5_target_not_editable', type);
  }
  input.type = 'text'; input.readOnly = true;
  assert.equal(p.snapshot().controls[0].editable, false);
  input.readOnly = false; p.hit = { tagName: 'DIV', id: 'overlay', className: 'modal' };
  const raw = tree(p), selected = selectH5Node(raw, { elementId: 'e1' });
  assert.equal(raw.dom.controls[0].interaction.status, 'obscured');
  assert.equal(p.run({ operation: 'prepare', action: 'input', ...selected.targetRef }).error, 'ios_h5_target_obscured');
  input.disabled = true;
  assert.equal(p.snapshot().controls[0].interaction.status, 'disabled');
  input.disabled = false; input.style.display = 'none';
  assert.equal(p.snapshot().controls[0].interaction.status, 'hidden');
  assert.deepEqual(p.events, []);
});

test('an editor that stops being editable during focus cannot receive replacement text', () => {
  const p = page(), editor = new p.Element('editor', 'original', 'DIV');
  editor.isContentEditable = true;
  const request = requestFor(p, { elementId: 'e1' }, 'input', { text: 'replacement' });
  editor.onfocus = () => { editor.isContentEditable = false; };
  assert.equal(p.run(request).error, 'ios_h5_target_changed');
  assert.equal(editor.innerText, 'original');
  assert.deepEqual(p.events, []);
});

test('exact embedded renderer rejects replaced elements, changed routes including return to the same URL, and BFCache restores', () => {
  for (const change of ['replace', 'route', 'bfcache']) {
    const p = page(), original = new p.Element('article', 'Climate change');
    const request = requestFor(p, { text: 'Climate change' });
    if (change === 'replace') { original.connected = false; new p.Element('article', 'Climate change'); }
    if (change === 'route') { p.history.pushState({}, '', 'kiwix://fixture/other'); p.history.replaceState({}, '', request.pageRef.url); }
    if (change === 'bfcache') { p.emit('pagehide'); p.emit('pageshow'); }
    assert.equal(p.run(request).error, 'reobserve_required', change);
    assert.deepEqual(p.events, []);
  }
});

test('H5 selectors preserve ambiguity and truncation, while explicit original IDs do not match replacements', () => {
  const p = page(); new p.Element('a', 'Same'); new p.Element('b', 'Same');
  assert.equal(selectH5Node(tree(p), { text: 'Same' }).error, 'ios_h5_selector_ambiguous');
  p.nodes[1].style.display = 'none';
  assert.equal(selectH5Node(tree(p), { text: 'Same' }).ok, true);
  for (let i = 0; i < 1000; i++) new p.Element(String(i), 'offscreen');
  assert.equal(selectH5Node(tree(p), { text: 'Same' }).error, 'ios_h5_snapshot_truncated');
  assert.equal(selectH5Node(tree(p), { elementId: 'e1' }).ok, true);
});

test('H5 actions check viewport, DOM occlusion, focus callbacks and secret values before reporting a result', () => {
  const p = page(), input = new p.Element('editor', '', 'INPUT');
  input.type = 'password'; input.value = 'secret';
  const request = requestFor(p, { elementId: 'e1' }, 'input', { text: '' });
  assert.equal(tree(p).dom.controls[0].value, '[REDACTED]');
  input.onfocus = () => { input.value = 'callback-change'; };
  assert.equal(p.run(request).error, 'ios_h5_target_changed');
  assert.equal(input.value, 'callback-change'); assert.deepEqual(p.events, []);
  delete input.onfocus;
  assert.equal(p.run(request).ok, true); assert.equal(input.value, '');
  assert.deepEqual(p.events, ['input:editor', 'change:editor']);
  p.hit = {};
  assert.equal(p.run(request).error, 'ios_h5_target_obscured');
  p.hit = input; input.rect = { left: 10, top: 1000, right: 150, bottom: 1035, width: 140, height: 35 };
  assert.equal(p.run(request).error, 'ios_h5_target_outside_viewport');
  assert.equal(p.run({ ...request, action: 'scroll' }).ok, true);
});

test('a layout change after native hit testing prevents the renderer click', () => {
  const p = page(), link = new p.Element('article', 'Open');
  const request = requestFor(p, { text: 'Open' });
  link.rect = { left: 20, top: 20, right: 160, bottom: 55, width: 140, height: 35 };
  assert.equal(p.run(request).error, 'reobserve_required');
  assert.deepEqual(p.events, []);
});

test('document scrolling after native hit testing invalidates even an unchanged fixed-position element', () => {
  const p = page(); new p.Element('article', 'Open');
  const request = requestFor(p, { text: 'Open' });
  p.setScroll(0, 126);
  assert.equal(p.run(request).error, 'reobserve_required');
  assert.deepEqual(p.events, []);
  const fresh = requestFor(p, { text: 'Open' });
  assert.equal(fresh.geometry.scrollY, 126);
  assert.equal(p.run(fresh).ok, true);
  assert.deepEqual(p.events, ['click:article']);
});

test('public H5 contracts require an observed page for expert eval and expose typed Script commands', () => {
  assert.throws(() => validateCommandArguments('ios-h5-eval', { deviceId: 'phone', bundleId: 'pkg', script: '1' }));
  for (const name of ['ios-h5-click', 'ios-h5-input', 'ios-h5-scroll']) {
    assert.throws(() => validateCommandArguments(name, { deviceId: 'phone', bundleId: 'pkg', selector: { text: 'x', elementId: 'e1' } }));
    assert.ok(commandSchema(name).properties.expectedTarget);
  }
});

test('public MCP Intent and continuous Script execute the exact H5 renderer and preserve original target/action identities', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-h5-intent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const p = page(), link = new p.Element('article', 'Climate change');
  link.onclick = () => { link.innerText = 'Article opened'; };
  const actions = [];
  let device, advertisedSchema = schema;
  const server = http.createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : null, url = new URL(req.url, 'http://localhost');
    const send = data => res.end(JSON.stringify({ ...data, runtimeBinding: device.binding }));
    if (url.pathname === '/v1/status') return send({ ok: true, debugBridge: { runtimeEpoch: device.binding.runtimeEpoch,
      h5TargetSchema: advertisedSchema, h5ExecutionSchema: 'aab.h5-execution/v1' } });
    if (url.pathname === '/v1/h5/dom') return send({ ok: true, ...tree(p) });
    if (url.pathname === '/v1/h5/action') {
      actions.push(body);
      const prepared = p.run({ ...body.payload, operation: 'prepare' });
      const outcome = prepared.ok ? p.run({ ...body.payload, operation: 'action', geometry: prepared.geometry }) : prepared;
      const { timeoutMs, ...identity } = body.execution;
      return send({ ...outcome, actionId: body.actionId, runtimeEpoch: identity.runtimeEpoch, settled: true,
        execution: { ...identity, settled: true } });
    }
    res.writeHead(404); send({ ok: false, error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  device = createIOSRuntimeFixture(directory, { port: server.address().port, deviceId: path.basename(directory) });
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'),
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(directory, 'ownership') } });
  t.after(() => client.close({ stdinEof: true }));
  await client.initialize();
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const target = { platform: 'ios', ...device.args };
  let result = await run('intent', { operation: 'start', goal: 'Open an offline article', target, provider: 'h5' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.summary.nodes.some(node => node.text === 'Climate change' && node.elementId === 'e1'));
  const operationId = result.operationId;
  result = await run('intent', { operation: 'decide', operationId, decision: { decisionId: 'article', basedOnRevision: result.revision,
    agentDecision: 'act', action: { action: 'tap', selector: { text: 'Climate change' } } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.summary.nodes.some(node => node.text === 'Article opened'));
  assert.equal(actions[0].actionId, operationId + ':article');
  assert.equal(actions[0].payload.pageRef.webViewId, 'webview-1');
  result = await run('intent', { operation: 'decide', operationId, decision: { decisionId: 'done', basedOnRevision: result.revision, agentDecision: 'complete' } });
  assert.equal(result.status, 'completed');
  advertisedSchema = undefined;
  const unsupported = await run('ios-h5-eval', { ...device.args, script: 'throw new Error("must not run")', expectedPage: tree(p).pageRef });
  assert.equal(unsupported.error, 'ios_h5_target_schema_required');
  assert.equal(unsupported.dispatched, false); assert.equal(actions.length, 1);
  advertisedSchema = schema;
  result = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', target,
    source: `module.exports.main = async ctx => {
      const action=await ctx.call('ios-h5-click',{selector:{text:'Article opened'},feedback:'off'});
      if (!action.ok) throw new Error(JSON.stringify(action));
      const observed=await ctx.call('ios-h5-dom',{feedback:'off'});
      await ctx.assert({name:'article content',condition:observed.result.dom.bodyText==='Independent article body',requiredEvidence:['tree'],evidence:observed.evidence});
    };` } });
  const scriptId = result.operationId, deadline = Date.now() + 30000;
  while (['running','starting','created'].includes(result.status)) {
    assert.ok(Date.now() < deadline, JSON.stringify(result));
    result = await run('script', { operation: 'wait', operationId: scriptId, waitMs: 1000 });
  }
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.rollingSummary.assertions, { passed: 1, failed: 0, inconclusive: 0 });
  assert.deepEqual(p.events, ['click:article', 'click:article']);
});
