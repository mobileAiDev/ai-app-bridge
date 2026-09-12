#!/usr/bin/env node
'use strict';

// LocalSend Chinese fixture: message draft is cancelled, settings scroll is
// restored. Preferences must additionally be checked by an independent reader.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function flutterFlow(ctx) {
  const assertions = [], actionIds = [];
  let cursor = {};
  const has = (read, text) => read.result.nodes.some(n => n.text === text);
  const editors = read => read.result.nodes.filter(n => n.role === 'input' && !n.input.readOnly);
  const vertical = read => read.result.nodes.filter(n => n.role === 'scrollable' && n.scroll.axis === 'vertical' && n.scroll.maxScrollExtent > 300);
  const horizontal = read => read.result.nodes.find(n => n.role === 'scrollable' && n.scroll.axis === 'horizontal');
  async function checked(name, condition, read, stream = 'tree') {
    const result = await ctx.assert({ name, condition, requiredEvidence: [stream], evidence: read.evidence,
      ...(stream === 'events' ? { requireCoverage: 'complete' } : {}) });
    assertions.push(result); if (result.verdict !== 'passed') throw Error(`${name}:${result.verdict}`);
  }
  async function stable(predicate) {
    let prior = null; const deadline = Date.now() + 8000;
    for (;;) {
      const read = await ctx.call('flutter-nodes', {});
      if (!read.ok || read.result.targetSchema !== 'aab.flutter-target/v1' || read.result.truncated) throw Error('Missing complete Flutter target tree');
      const signature = JSON.stringify(read.result.nodes.map(n => [n.id, n.text, n.value, n.bounds, n.input, n.scroll]));
      if (predicate(read) && signature === prior) return read;
      if (Date.now() >= deadline) throw Error('Expected Flutter state did not settle');
      prior = signature; await new Promise(resolve => setTimeout(resolve, 180));
    }
  }
  async function boundary() {
    let read = await ctx.call('events', { view: 'decision-window', limit: 100, ...cursor });
    if (!read.ok || !read.evidence.capture.watermarkCursor) throw Error('Missing issued capture boundary');
    if (read.evidence.coverage.status !== 'complete') read = await ctx.call('events', { view: 'decision-window', limit: 100,
      factCursor: read.evidence.capture.watermarkCursor, runtimeEpoch: read.evidence.capture.runtimeEpoch });
    if (!read.ok || read.evidence.coverage.status !== 'complete') throw Error('Fresh event suffix unavailable');
    cursor = { factCursor: read.evidence.capture.watermarkCursor, runtimeEpoch: read.evidence.capture.runtimeEpoch }; return cursor;
  }
  async function action(command, args, eventName) {
    const since = await boundary();
    const result = await ctx.call(command, args), sdk = result.result;
    const actionId = result.execution.actionId;
    if (!result.ok || sdk.targetValidation !== 'aab.flutter-target/v1' || !actionId) throw Error(JSON.stringify(result));
    if (sdk.request) {
      for (const key of ['schemaVersion', 'runtimeEpoch', 'elementId', 'guard']) {
        if (sdk.request.targetRef[key] !== sdk.targetRef[key]) throw Error('SDK returned a different target');
      }
    }
    actionIds.push(actionId);
    const matches = read => read.ok && read.result.items.some(e =>
      e.actionId === actionId && e.name === eventName && e.data.targetValidation === 'aab.flutter-target/v1'
      && e.data.targetRef.elementId === sdk.targetRef.elementId);
    let read; const deadline = Date.now() + 8000;
    for (;;) {
      read = await ctx.call('events', { view: 'decision-window', limit: 100, ...since, afterActionId: actionId });
      if (matches(read) || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await checked(`${command} has its bound phone ${eventName} event`, matches(read), read, 'events');
    cursor = { factCursor: read.evidence.capture.watermarkCursor, runtimeEpoch: read.evidence.capture.runtimeEpoch };
    return result;
  }
  const tap = selector => action('tap-flutter', { selector }, 'target.tap');
  const photo = name => ctx.call('screenshot', { outFile: `${ctx.inputs.out}/${name}.png`, feedback: 'off' });
  let read = await stable(r => has(r, '通过链接接收'));
  await checked('receive fixture is visible', has(read, '通过链接接收'), read);
  await tap({ text: '发送' }); read = await stable(r => has(r, '选择') && has(r, '文本'));
  await checked('send selection is visible', has(read, '选择'), read);
  await tap({ text: '文本' }); read = await stable(r => has(r, '输入消息') && editors(r).length === 1);
  const editorId = editors(read)[0].id;
  await checked('new dialog exposes the empty editor', !(editors(read)[0].value || ''), read);
  await action('input-flutter-text', { selector: { nodeId: editorId }, text: '桥接验证🙂\nsecond line' }, 'input.changed');
  read = await stable(r => editors(r).length === 1 && editors(r)[0].value === '桥接验证🙂 second line');
  await checked('bound editor contains the Unicode draft', editors(read)[0].value === '桥接验证🙂 second line', read);
  if (!(await photo('input')).ok) throw Error('Input screenshot failed');
  await action('input-flutter-text', { selector: { nodeId: editorId }, text: '' }, 'input.changed');
  read = await stable(r => editors(r).length === 1 && !(editors(r)[0].value || ''));
  await checked('same bound editor can be cleared', !(editors(read)[0].value || ''), read);
  await tap({ text: '取消' }); read = await stable(r => has(r, '选择') && !has(r, '输入消息'));
  await checked('cancel closes the draft without selecting a message', has(read, '选择') && !has(read, '输入消息'), read);
  await tap({ text: '文本' }); read = await stable(r => has(r, '输入消息') && editors(r).length === 1);
  await checked('reopened dialog is a fresh empty editor', editors(read)[0].id !== editorId && !(editors(read)[0].value || ''), read);
  await tap({ text: '取消' }); await stable(r => has(r, '选择') && !has(r, '输入消息'));
  await tap({ text: '设置' }); read = await stable(r => has(r, '主题') && vertical(r).length === 1);
  const container = vertical(read)[0], outer = horizontal(read), origin = container.scroll.pixels;
  const titleTop = read.result.nodes.find(n => n.text === '主题').bounds.top;
  await checked('nested horizontal and vertical containers have distinct refs', outer && outer.id !== container.id, read);
  await action('scroll-flutter', { selector: { nodeId: container.id }, delta: 300 }, 'scroll.changed');
  read = await stable(r => vertical(r).length === 1 && vertical(r)[0].scroll.pixels === origin + 300);
  await checked('only the selected vertical container moves', vertical(read)[0].scroll.pixels === origin + 300
    && horizontal(read).scroll.pixels === outer.scroll.pixels && !has(read, '主题'), read);
  if (!(await photo('scrolled')).ok) throw Error('Scroll screenshot failed');
  await action('scroll-flutter', { selector: { nodeId: container.id }, delta: -300 }, 'scroll.changed');
  read = await stable(r => has(r, '主题') && vertical(r)[0].scroll.pixels === origin);
  await checked('settings content and scroll position are restored', read.result.nodes.find(n => n.text === '主题').bounds.top === titleTop, read);
  const receive = read.result.nodes.filter(n => n.text === '接收' && n.widgetType === 'NavigationDestination');
  if (receive.length !== 1) throw Error('Receive navigation destination is not unique');
  await tap({ nodeId: receive[0].id }); read = await stable(r => has(r, '通过链接接收'));
  await checked('receive fixture is restored', has(read, '通过链接接收'), read);
  if (!(await photo('restored')).ok) throw Error('Restored screenshot failed');
  return { completedFlow: true, assertions, actionIds };
}

const pythonSource = `import time, json
def main(ctx):
    assertions, action_ids, cursor = [], [], {}
    def has(r, text): return any(n.get('text') == text for n in r['result']['nodes'])
    def editors(r): return [n for n in r['result']['nodes'] if n['role'] == 'input' and not n['input']['readOnly']]
    def vertical(r): return [n for n in r['result']['nodes'] if n['role'] == 'scrollable' and n['scroll']['axis'] == 'vertical' and (n['scroll']['maxScrollExtent'] or 0) > 300]
    def horizontal(r): return next(n for n in r['result']['nodes'] if n['role'] == 'scrollable' and n['scroll']['axis'] == 'horizontal')
    def checked(name, condition, read, stream='tree'):
        args = {'name': name, 'condition': bool(condition), 'requiredEvidence': [stream], 'evidence': read['evidence']}
        if stream == 'events': args['requireCoverage'] = 'complete'
        result = ctx.assert_(args); assertions.append(result)
        if result['verdict'] != 'passed': raise Exception(name + ':' + result['verdict'])
    def stable(predicate):
        prior, deadline = None, time.monotonic() + 8
        while True:
            r = ctx.call('flutter-nodes', {})
            if not r['ok'] or r['result'].get('targetSchema') != 'aab.flutter-target/v1' or r['result'].get('truncated'): raise Exception('Missing complete Flutter target tree')
            signature = [[n['id'], n.get('text'), n.get('value'), n['bounds'], n.get('input'), n.get('scroll')] for n in r['result']['nodes']]
            if predicate(r) and signature == prior: return r
            if time.monotonic() >= deadline: raise Exception('Expected Flutter state did not settle')
            prior = signature; time.sleep(0.18)
    def boundary():
        nonlocal cursor
        r = ctx.call('events', {'view': 'decision-window', 'limit': 100, **cursor})
        if not r['ok'] or not r['evidence']['capture'].get('watermarkCursor'): raise Exception('Missing issued capture boundary')
        if r['evidence']['coverage']['status'] != 'complete':
            r = ctx.call('events', {'view': 'decision-window', 'limit': 100, 'factCursor': r['evidence']['capture']['watermarkCursor'], 'runtimeEpoch': r['evidence']['capture']['runtimeEpoch']})
        if not r['ok'] or r['evidence']['coverage']['status'] != 'complete': raise Exception('Fresh event suffix unavailable')
        cursor = {'factCursor': r['evidence']['capture']['watermarkCursor'], 'runtimeEpoch': r['evidence']['capture']['runtimeEpoch']}; return cursor
    def action(command, args, event_name):
        nonlocal cursor
        since = boundary(); result = ctx.call(command, args); sdk = result['result']
        if not result['ok'] or sdk.get('targetValidation') != 'aab.flutter-target/v1' or not result['execution'].get('actionId'): raise Exception(str(result))
        if sdk['request']['targetRef'] != sdk['targetRef']: raise Exception('SDK returned a different target')
        action_id = result['execution']['actionId']; action_ids.append(action_id)
        def matches(read): return read['ok'] and any(e.get('actionId') == action_id and e.get('name') == event_name and e['data'].get('targetValidation') == 'aab.flutter-target/v1' and e['data']['targetRef']['elementId'] == sdk['targetRef']['elementId'] for e in read['result']['items'])
        deadline = time.monotonic() + 8
        while True:
            read = ctx.call('events', {'view': 'decision-window', 'limit': 100, **since, 'afterActionId': action_id})
            if matches(read) or time.monotonic() >= deadline: break
            time.sleep(0.1)
        checked(command + ' has its bound phone ' + event_name + ' event', matches(read), read, 'events')
        cursor = {'factCursor': read['evidence']['capture']['watermarkCursor'], 'runtimeEpoch': read['evidence']['capture']['runtimeEpoch']}
        return result
    def tap(selector): return action('tap-flutter', {'selector': selector}, 'target.tap')
    def photo(name):
        if not ctx.call('screenshot', {'outFile': ctx.inputs['out'] + '/' + name + '.png', 'feedback': 'off'})['ok']: raise Exception('Screenshot failed')
    read = stable(lambda r: has(r, '通过链接接收')); checked('receive fixture is visible', has(read, '通过链接接收'), read)
    tap({'text': '发送'}); read = stable(lambda r: has(r, '选择') and has(r, '文本')); checked('send selection is visible', has(read, '选择'), read)
    tap({'text': '文本'}); read = stable(lambda r: has(r, '输入消息') and len(editors(r)) == 1); editor_id = editors(read)[0]['id']
    checked('new dialog exposes the empty editor', not editors(read)[0].get('value', ''), read)
    action('input-flutter-text', {'selector': {'nodeId': editor_id}, 'text': '桥接验证🙂\\nsecond line'}, 'input.changed')
    read = stable(lambda r: len(editors(r)) == 1 and editors(r)[0].get('value') == '桥接验证🙂 second line')
    checked('bound editor contains the Unicode draft', editors(read)[0]['value'] == '桥接验证🙂 second line', read); photo('input')
    action('input-flutter-text', {'selector': {'nodeId': editor_id}, 'text': ''}, 'input.changed')
    read = stable(lambda r: len(editors(r)) == 1 and not editors(r)[0].get('value', '')); checked('same bound editor can be cleared', not editors(read)[0].get('value', ''), read)
    tap({'text': '取消'}); read = stable(lambda r: has(r, '选择') and not has(r, '输入消息')); checked('cancel closes the draft without selecting a message', has(read, '选择') and not has(read, '输入消息'), read)
    tap({'text': '文本'}); read = stable(lambda r: has(r, '输入消息') and len(editors(r)) == 1)
    checked('reopened dialog is a fresh empty editor', editors(read)[0]['id'] != editor_id and not editors(read)[0].get('value', ''), read)
    tap({'text': '取消'}); stable(lambda r: has(r, '选择') and not has(r, '输入消息'))
    tap({'text': '设置'}); read = stable(lambda r: has(r, '主题') and len(vertical(r)) == 1)
    container, outer = vertical(read)[0], horizontal(read); origin = container['scroll']['pixels']
    title_top = next(n['bounds']['top'] for n in read['result']['nodes'] if n.get('text') == '主题')
    checked('nested horizontal and vertical containers have distinct refs', outer['id'] != container['id'], read)
    action('scroll-flutter', {'selector': {'nodeId': container['id']}, 'delta': 300}, 'scroll.changed')
    read = stable(lambda r: len(vertical(r)) == 1 and vertical(r)[0]['scroll']['pixels'] == origin + 300)
    checked('only the selected vertical container moves', vertical(read)[0]['scroll']['pixels'] == origin + 300 and horizontal(read)['scroll']['pixels'] == outer['scroll']['pixels'] and not has(read, '主题'), read); photo('scrolled')
    action('scroll-flutter', {'selector': {'nodeId': container['id']}, 'delta': -300}, 'scroll.changed')
    read = stable(lambda r: has(r, '主题') and vertical(r)[0]['scroll']['pixels'] == origin)
    checked('settings content and scroll position are restored', next(n['bounds']['top'] for n in read['result']['nodes'] if n.get('text') == '主题') == title_top, read)
    receive = [n for n in read['result']['nodes'] if n.get('text') == '接收' and n['widgetType'] == 'NavigationDestination']
    if len(receive) != 1: raise Exception('Receive navigation destination is not unique')
    tap({'nodeId': receive[0]['id']}); read = stable(lambda r: has(r, '通过链接接收')); checked('receive fixture is restored', has(read, '通过链接接收'), read); photo('restored')
    return {'completedFlow': True, 'assertions': assertions, 'actionIds': action_ids}
`;

async function main({ out, serverPath, serial, packageName }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const target = { serial, packageName }, report = { ok: false, target, serverPath, cases: [] };
  const client = createMcpClient({ serverPath, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'), env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts') } });
  let sequence = 0;
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
  async function run(command, args) {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  }
  const check = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  async function archive(namespace, operationId, name) {
    return check(await run('evidence', { operation: 'export', namespace, operationId, outputDir: path.join(out, name), includeRecordedPayloads: true }));
  }
  try {
    await client.initialize();
    let state = check(await run('intent', { operation: 'start', operationId: `flutter-targets-${Date.now()}`, provider: 'flutter', target: { platform: 'android', ...target },
      goal: 'Verify actual Flutter message input, clearing, draft cancellation and explicit nested settings scroll, then restore Receive. Preserve preferences.',
      timeoutMs: 120000, require: { streams: ['events'], view: 'decision-window', limit: 100 }, recordingDir: path.join(out, 'intent-recording') }));
    const operationId = state.operationId, start = Date.now();
    fs.mkdirSync(path.join(out, 'intent-ui'));
    const observedAssertions = [];
    try {
      const intentResult = await flutterFlow({ inputs: { out: path.join(out, 'intent-ui') },
        async assert(spec) {
          // These are controller checks, not Script-issued assertion receipts.
          assert.equal(Boolean(spec.condition), true, spec.name);
          const result = { name: spec.name, verdict: 'passed', scope: 'external-controller-observation' };
          observedAssertions.push(result); return result;
        },
        async call(command, args) {
          const actionNames = { 'tap-flutter': 'tap', 'input-flutter-text': 'inputText', 'scroll-flutter': 'scrollBy' };
          if (actionNames[command]) {
            state = check(await run('intent', { operation: 'observe', operationId }));
            const action = { provider: 'flutter', action: actionNames[command], selector: args.selector,
              ...(command === 'input-flutter-text' ? { value: args.text } : {}), ...(command === 'scroll-flutter' ? { delta: args.delta } : {}) };
            state = check(await run('intent', { operation: 'decide', operationId, decision: {
              decisionId: `action-${state.revision}`, basedOnRevision: state.revision, agentDecision: 'act', action } }));
            assert.equal(state.lastAction.mechanicalStatus, 'ok');
            assert.equal(state.capture.coverage.status, 'complete');
            const eventName = command === 'tap-flutter' ? 'target.tap' : command === 'input-flutter-text' ? 'input.changed' : 'scroll.changed';
            const actionId = state.lastAction.actionId, deadline = Date.now() + 8000;
            let event;
            for (;;) {
              event = state.capture.items.find(e => e.actionId === actionId && e.name === eventName);
              if (event || Date.now() >= deadline) break;
              await new Promise(resolve => setTimeout(resolve, 100));
              state = check(await run('intent', { operation: 'observe', operationId }));
              assert.equal(state.capture.coverage.status, 'complete');
            }
            assert.ok(event, 'Intent must capture the matching phone event');
            return { ok: true, execution: { actionId }, result: { ...event.data, validationSource: 'intent-mobile-capture' } };
          }
          const raw = check(await run(command, { ...target, ...args }));
          return { ok: true, result: raw, evidence: { capture: raw, coverage: raw.coverage } };
        },
      });
      state = check(await run('intent', { operation: 'decide', operationId, decision: { decisionId: 'done', basedOnRevision: state.revision, agentDecision: 'complete' } }));
      report.cases.push({ name: 'intent', operationId, status: state.status, elapsedMs: Date.now() - start, result: intentResult });
    } catch (error) {
      if (!['completed', 'failed', 'cancelled'].includes(state.status)) await run('intent', { operation: 'cancel', operationId });
      throw error;
    } finally {
      write('intent-controller-assertions.json', observedAssertions);
      report.intentArchive = await archive('intent', operationId, 'intent-archive');
    }
    for (const language of ['javascript', 'python']) {
      const ui = path.join(out, `${language}-ui`); fs.mkdirSync(ui);
      const script = { schemaVersion: 'aab.code-script/v1', language, source: language === 'javascript' ? `module.exports.main = ${flutterFlow.toString()};` : pythonSource,
        target, inputs: { out: ui }, permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 120000 } };
      write(`${language}-script.json`, script); const start = Date.now();
      let state = check(await run('script', { operation: 'start', script, recordingDir: path.join(out, `${language}-recording`) }));
      const operationId = state.operationId;
      while (!['completed', 'failed', 'cancelled'].includes(state.status)) state = await run('script', { operation: 'wait', operationId, afterSequence: state.eventSequence, waitMs: 1000 });
      state = await run('script', { operation: 'status', operationId });
      const archived = await archive('script', operationId, `${language}-archive`);
      report.cases.push({ name: language, operationId, status: state.status, elapsedMs: Date.now() - start, archive: archived });
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const resultEnvelope = await run('script', { operation: 'result', operationId });
      assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
      const result = resultEnvelope.result;
      assert.equal(result.completedFlow, true); assert.equal(result.actionIds.length, 11);
      assert.equal(result.assertions.length, 22); assert.ok(result.assertions.every(a => a.verdict === 'passed'));
      report.cases.at(-1).result = result;
    }
    report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally { report.mcpExit = await client.close({ stdinEof: true }); write('report.json', report); }
  return report;
}

if (require.main === module) {
  const [out, serverPath, serial, packageName] = process.argv.slice(2);
  main({ out: path.resolve(out), serverPath: path.resolve(serverPath), serial, packageName })
    .then(r => console.log(JSON.stringify({ ok: r.ok, cases: r.cases.map(c => ({ name: c.name, status: c.status, elapsedMs: c.elapsedMs })) })))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
