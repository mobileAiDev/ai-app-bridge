#!/usr/bin/env node
'use strict';

// Fixed NotallyX fixture: caller supplies an independently read note title and
// its observed top position. This validates Bridge, without editing note data.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

function nodes(tree) {
  const result = [];
  function walk(n) { if (!n.visible) return; result.push(n); for (const child of n.children || []) walk(child); }
  walk(tree.windows.at(-1).root); return result;
}
function selected(tree) { return nodes(tree).some(n => n.text === '1' && n.bounds.top >= 120 && n.bounds.bottom <= 330); }
function positions(tree, titleId) { return nodes(tree).filter(n => n.resourceName === titleId).map(n => [n.text, n.bounds.top]); }
function swipeSelector(tree, titleId) {
  const eligible = nodes(tree).filter(n => n.resourceName === titleId && n.bounds.top >= 400 && n.bounds.bottom < 1500);
  if (!eligible.length) throw Error('No observed note title fits the swipe fixture');
  return { text: eligible[0].text };
}
function gestureEvents(items, actionId) {
  const events = items.filter(item => item.name === 'ui.interaction' && item.actionId === actionId);
  return events.some(e => e.data.completion === 'started') && events.some(e => e.data.completion === 'completed');
}

async function javascriptFlow(ctx) {
  const { query, titleId, listId, titleTop } = ctx.inputs;
  const assertions = [], actionIds = [];
  let cursor;
  async function checked(name, condition, read, stream) {
    const result = await ctx.assert({ name, condition, requiredEvidence: [stream], ...(stream === 'events' ? { requireCoverage: 'complete' } : {}), evidence: read.evidence });
    assertions.push(result); if (result.verdict !== 'passed') throw Error(`${name}:${result.verdict}`);
  }
  async function tree() { const result = await ctx.call('tree', { compact: false }); if (!result.ok) throw Error(result.error); return result; }
  async function stable() {
    let prior = null; const deadline = Date.now() + 5000;
    for (;;) {
      const read = await tree(), current = JSON.stringify(positions(read.result, titleId));
      if (current === prior) return read;
      if (Date.now() >= deadline) throw Error('List never settled'); prior = current;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  async function beforeEvents() {
    let read = await ctx.call('events', { view: 'decision-window', limit: 100, ...cursor });
    if (!read.ok || !read.evidence.capture.watermarkCursor || !read.evidence.capture.runtimeEpoch) throw Error('Missing issued event watermark');
    // The first history page may retain an old gap. Establish a new empty suffix
    // explicitly; that does not change the first page's recorded coverage.
    if (read.evidence.coverage.status !== 'complete') {
      read = await ctx.call('events', { view: 'decision-window', limit: 100,
        factCursor: read.evidence.capture.watermarkCursor, runtimeEpoch: read.evidence.capture.runtimeEpoch });
    }
    if (!read.ok || read.evidence.coverage.status !== 'complete') throw Error('Event boundary unavailable');
    cursor = { factCursor: read.evidence.capture.watermarkCursor, runtimeEpoch: read.evidence.capture.runtimeEpoch }; return cursor;
  }
  async function gesture(payload) {
    const boundary = await beforeEvents();
    const action = await ctx.call('native-gesture', { payload });
    if (!action.ok || action.result.targetValidation !== 'aab.native-target/v1' || action.result.completion !== 'completed'
      || action.result.elapsedMs < payload.durationMs || action.result.evidenceError) throw Error(JSON.stringify(action));
    const actionId = action.result.actionId; actionIds.push(actionId);
    const events = await ctx.call('events', { view: 'decision-window', limit: 100, ...boundary, afterActionId: actionId });
    await checked(`${payload.action} has fresh started and completed phone events`, events.ok && gestureEvents(events.result.items, actionId), events, 'events');
    cursor = { factCursor: events.evidence.capture.watermarkCursor, runtimeEpoch: events.evidence.capture.runtimeEpoch };
    return stable();
  }
  let read = await stable();
  await checked('unselected fixed note at the observed top position', !selected(read.result)
    && nodes(read.result).some(n => n.text === query && n.bounds.top === titleTop), read, 'tree');
  read = await gesture({ action: 'longPress', selector: { text: query }, durationMs: 700 });
  await checked('long press selects one existing note', selected(read.result), read, 'tree');
  const back = await ctx.call('keyevent', { keyCode: 4 }); if (!back.ok) throw Error(back.error);
  read = await stable(); await checked('Back leaves selection mode', !selected(read.result), read, 'tree');
  let old = JSON.stringify(positions(read.result, titleId));
  read = await gesture({ action: 'scroll', selector: { resourceName: listId }, direction: 'down', durationMs: 600 });
  await checked('explicit container scroll moves note content', JSON.stringify(positions(read.result, titleId)) !== old, read, 'tree');
  old = JSON.stringify(positions(read.result, titleId));
  read = await gesture({ action: 'swipe', selector: swipeSelector(read.result, titleId), deltaX: 0, deltaY: 400, durationMs: 600 });
  await checked('selected note swipe moves note content', JSON.stringify(positions(read.result, titleId)) !== old, read, 'tree');
  for (let index = 0; index < 12; index++) {
    const up = await ctx.call('native-gesture', { payload: { action: 'scroll', selector: { resourceName: listId }, direction: 'up', durationMs: 800 } });
    if (!up.ok) { if (up.error !== 'native_scroll_boundary' || up.result.dispatched !== false) throw Error(JSON.stringify(up)); break; }
    await stable();
  }
  read = await stable(); await checked('note list restored to its initial top position', !selected(read.result)
    && nodes(read.result).some(n => n.text === query && n.bounds.top === titleTop), read, 'tree');
  return { assertions, actionIds };
}

const pythonSource = `import time, json
def main(ctx):
    query, title_id, list_id, title_top = (ctx.inputs[k] for k in ['query', 'titleId', 'listId', 'titleTop'])
    assertions, action_ids, cursor = [], [], {}
    def nodes(tree):
        out = []
        def walk(n):
            if not n.get('visible'): return
            out.append(n)
            for child in n.get('children', []): walk(child)
        walk(tree['windows'][-1]['root']); return out
    def selected(tree):
        return any(n.get('text') == '1' and n['bounds']['top'] >= 120 and n['bounds']['bottom'] <= 330 for n in nodes(tree))
    def positions(tree):
        return [(n.get('text'), n['bounds']['top']) for n in nodes(tree) if n.get('resourceName') == title_id]
    def fixed(tree):
        return not selected(tree) and any(n.get('text') == query and n['bounds']['top'] == title_top for n in nodes(tree))
    def checked(name, condition, read, stream):
        args = {'name': name, 'condition': condition, 'requiredEvidence': [stream], 'evidence': read['evidence']}
        if stream == 'events': args['requireCoverage'] = 'complete'
        result = ctx.assert_(args); assertions.append(result)
        if result['verdict'] != 'passed': raise Exception(name + ':' + result['verdict'])
    def stable():
        prior, deadline = None, time.monotonic() + 5
        while True:
            read = ctx.call('tree', {'compact': False})
            if not read['ok']: raise Exception(str(read))
            current = positions(read['result'])
            if current == prior: return read
            if time.monotonic() >= deadline: raise Exception('List never settled')
            prior = current; time.sleep(0.15)
    def before_events():
        nonlocal cursor
        read = ctx.call('events', {'view': 'decision-window', 'limit': 100, **cursor})
        if not read['ok'] or not read['evidence']['capture'].get('watermarkCursor'): raise Exception('Missing issued event watermark')
        if read['evidence']['coverage']['status'] != 'complete':
            read = ctx.call('events', {'view': 'decision-window', 'limit': 100, 'factCursor': read['evidence']['capture']['watermarkCursor'], 'runtimeEpoch': read['evidence']['capture']['runtimeEpoch']})
        if not read['ok'] or read['evidence']['coverage']['status'] != 'complete': raise Exception('Event boundary unavailable')
        cursor = {'factCursor': read['evidence']['capture']['watermarkCursor'], 'runtimeEpoch': read['evidence']['capture']['runtimeEpoch']}
        return cursor
    def gesture(payload):
        nonlocal cursor
        boundary = before_events()
        action = ctx.call('native-gesture', {'payload': payload})
        sdk = action.get('result', {})
        if not action['ok'] or sdk.get('targetValidation') != 'aab.native-target/v1' or sdk.get('completion') != 'completed' or sdk['elapsedMs'] < payload['durationMs'] or sdk.get('evidenceError'): raise Exception(str(action))
        action_id = sdk['actionId']; action_ids.append(action_id)
        read = ctx.call('events', {'view': 'decision-window', 'limit': 100, **boundary, 'afterActionId': action_id})
        events = [e for e in read['result']['items'] if e.get('name') == 'ui.interaction' and e.get('actionId') == action_id]
        completions = [e['data'].get('completion') for e in events]
        checked(payload['action'] + ' has fresh started and completed phone events', 'started' in completions and 'completed' in completions, read, 'events')
        cursor = {'factCursor': read['evidence']['capture']['watermarkCursor'], 'runtimeEpoch': read['evidence']['capture']['runtimeEpoch']}
        return stable()
    read = stable(); checked('unselected fixed note at the observed top position', fixed(read['result']), read, 'tree')
    read = gesture({'action': 'longPress', 'selector': {'text': query}, 'durationMs': 700})
    checked('long press selects one existing note', selected(read['result']), read, 'tree')
    if not ctx.call('keyevent', {'keyCode': 4})['ok']: raise Exception('Back failed')
    read = stable(); checked('Back leaves selection mode', not selected(read['result']), read, 'tree')
    old = positions(read['result'])
    read = gesture({'action': 'scroll', 'selector': {'resourceName': list_id}, 'direction': 'down', 'durationMs': 600})
    checked('explicit container scroll moves note content', positions(read['result']) != old, read, 'tree')
    old = positions(read['result'])
    candidates = [n for n in nodes(read['result']) if n.get('resourceName') == title_id and n['bounds']['top'] >= 400 and n['bounds']['bottom'] < 1500]
    if not candidates: raise Exception('No observed note title fits the swipe fixture')
    read = gesture({'action': 'swipe', 'selector': {'text': candidates[0]['text']}, 'deltaX': 0, 'deltaY': 400, 'durationMs': 600})
    checked('selected note swipe moves note content', positions(read['result']) != old, read, 'tree')
    for index in range(12):
        up = ctx.call('native-gesture', {'payload': {'action': 'scroll', 'selector': {'resourceName': list_id}, 'direction': 'up', 'durationMs': 800}})
        if not up['ok']:
            if up['error'] != 'native_scroll_boundary' or up['result'].get('dispatched') is not False: raise Exception(str(up))
            break
        stable()
    read = stable(); checked('note list restored to its initial top position', fixed(read['result']), read, 'tree')
    return {'assertions': assertions, 'actionIds': action_ids}
`;

async function main({ out, serverPath, serial, packageName, query, titleTop }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const target = { serial, packageName }, inputs = { query, titleTop, titleId: `${packageName}:id/Title`, listId: `${packageName}:id/MainListView` };
  const report = { ok: false, target, serverPath, inputs, cases: [] };
  const client = createMcpClient({ serverPath, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'), env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts') } });
  let sequence = 0;
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
  async function run(command, args) {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  }
  const check = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const tree = async () => check(await run('tree', { ...target, compact: false }));
  async function stable() {
    let prior = null; const deadline = Date.now() + 5000;
    for (;;) { const current = await tree(), value = JSON.stringify(positions(current, inputs.titleId)); if (value === prior) return current;
      assert.ok(Date.now() < deadline, 'List never settled'); prior = value; await delay(150); }
  }
  async function restore() {
    for (let index = 0; index < 12; index++) {
      const up = await run('native-gesture', { ...target, payload: { action: 'scroll', selector: { resourceName: inputs.listId }, direction: 'up', durationMs: 800 }, feedback: 'off' });
      if (!up.ok) { assert.equal(up.error, 'native_scroll_boundary'); assert.equal(up.dispatched, false); break; }
      await stable();
    }
    const current = await stable(); assert.equal(selected(current), false);
    assert.ok(nodes(current).some(n => n.text === query && n.bounds.top === titleTop));
  }
  async function screenshot(name) { check(await run('screenshot', { ...target, outFile: path.join(out, name + '.png'), feedback: 'off' })); }
  try {
    await client.initialize(); await restore(); await screenshot('before');
    let state = check(await run('intent', { operation: 'start', operationId: `gesture-binding-${Date.now()}`, target: { platform: 'android', ...target }, provider: 'native',
      goal: 'Select one known note, leave selection, scroll its list and swipe an observed note; verify fresh phone events and visible results.',
      require: { streams: ['events'], view: 'decision-window', limit: 100 }, recordingDir: path.join(out, 'intent-recording') }));
    const operationId = state.operationId, gestures = [];
    async function decide(decisionId, action) {
      state = check(await run('intent', { operation: 'decide', operationId, decision: { decisionId, basedOnRevision: state.revision, agentDecision: 'act', action } }));
      if (['longPress', 'swipe', 'scroll'].includes(action.action)) {
        assert.equal(state.lastAction.mechanicalStatus, 'ok'); assert.equal(state.capture.coverage.status, 'complete'); assert.equal(state.capture.gap, false);
        assert.ok(gestureEvents(state.capture.items, state.lastAction.actionId)); gestures.push(state.lastAction.actionId);
      }
      return stable();
    }
    let current = await decide('hold', { action: 'longPress', selector: { text: query }, durationMs: 700 }); assert.ok(selected(current)); await screenshot('intent-selected');
    current = await decide('back', { action: 'back' }); assert.equal(selected(current), false);
    let prior = JSON.stringify(positions(current, inputs.titleId));
    current = await decide('scroll', { action: 'scroll', selector: { resourceName: inputs.listId }, direction: 'down', durationMs: 600 });
    assert.notEqual(JSON.stringify(positions(current, inputs.titleId)), prior); await screenshot('intent-scrolled');
    state = check(await run('intent', { operation: 'observe', operationId })); prior = JSON.stringify(positions(current, inputs.titleId));
    current = await decide('swipe', { action: 'swipe', selector: swipeSelector(current, inputs.titleId), deltaX: 0, deltaY: 400, durationMs: 600 });
    assert.notEqual(JSON.stringify(positions(current, inputs.titleId)), prior);
    state = check(await run('intent', { operation: 'decide', operationId, decision: { decisionId: 'done', basedOnRevision: state.revision, agentDecision: 'complete' } }));
    const archive = check(await run('evidence', { operation: 'export', namespace: 'intent', operationId, outputDir: path.join(out, 'intent-archive'), includeRecordedPayloads: true }));
    report.cases.push({ name: 'intent', operationId, status: state.status, actionIds: gestures, archive });
    await restore();
    for (const language of ['javascript', 'python']) {
      const source = language === 'python' ? pythonSource : [nodes, selected, positions, swipeSelector, gestureEvents].map(fn => fn.toString()).join('\n') + '\nmodule.exports.main = ' + javascriptFlow.toString();
      const script = { schemaVersion: 'aab.code-script/v1', language, source, target: { platform: 'android', ...target }, inputs,
        permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 60000 } };
      write(`${language}-script.json`, script); const startedAt = Date.now();
      let state = check(await run('script', { operation: 'start', script, recordingDir: path.join(out, `${language}-recording`) }));
      const operationId = state.operationId;
      while (!['completed', 'failed', 'cancelled'].includes(state.status)) state = await run('script', { operation: 'wait', operationId, afterSequence: state.eventSequence, waitMs: 1000 });
      state = await run('script', { operation: 'status', operationId });
      const archive = check(await run('evidence', { operation: 'export', namespace: 'script', operationId, outputDir: path.join(out, `${language}-archive`), includeRecordedPayloads: true }));
      report.cases.push({ name: language, operationId, status: state.status, elapsedMs: Date.now() - startedAt, archive });
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const resultEnvelope = await run('script', { operation: 'result', operationId });
      assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
      const result = resultEnvelope.result;
      assert.equal(result.assertions.length, 9); assert.ok(result.assertions.every(a => a.verdict === 'passed'));
      report.cases.at(-1).result = result; await screenshot(`${language}-restored`);
    }
    await restore(); report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally { report.mcpExit = await client.close({ stdinEof: true }); write('report.json', report); }
  return report;
}

if (require.main === module) {
  const [out, serverPath, serial, packageName, query, titleTop] = process.argv.slice(2);
  main({ out: path.resolve(out), serverPath: path.resolve(serverPath), serial, packageName, query, titleTop: Number(titleTop) })
    .then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
