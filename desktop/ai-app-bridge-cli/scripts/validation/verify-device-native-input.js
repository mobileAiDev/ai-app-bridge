#!/usr/bin/env node
'use strict';

// NotallyX search fixture. The caller opens the observed search page and supplies
// an exact title from an independent database snapshot; no note is edited here.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function javascriptFlow(ctx) {
  const { editorId, titleId, query } = ctx.inputs;
  const nodes = tree => {
    const result = [];
    function walk(node) { if (!node.visible) return; result.push(node); for (const child of node.children || []) walk(child); }
    walk(tree.windows.at(-1).root); return result;
  };
  const assertions = [];
  async function readUntil(name, predicate) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const read = await ctx.call('tree', { compact: false });
      if (!read.ok) throw Error(`tree:${read.error}`);
      const condition = predicate(nodes(read.result));
      if (condition || Date.now() >= deadline) {
        const checked = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: read.evidence });
        assertions.push(checked);
        if (checked.verdict !== 'passed') throw Error(`${name}:${checked.verdict}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await readUntil('empty focused search editor', ns => ns.filter(n => n.resourceName === editorId && n.focused && n.text === '').length === 1);
  const entered = await ctx.call('input-text', { text: query });
  if (!entered.ok || entered.result.targetValidation !== 'coordinates-or-focus') throw Error(JSON.stringify(entered));
  await readUntil('query and exact matching result', ns => ns.some(n => n.resourceName === editorId && n.text === query)
    && ns.filter(n => n.resourceName === titleId).length === 1 && ns.some(n => n.resourceName === titleId && n.text === query));
  const cleared = await ctx.call('input-text', { text: '' });
  if (!cleared.ok) throw Error(JSON.stringify(cleared));
  await readUntil('search editor cleared', ns => ns.filter(n => n.resourceName === editorId && n.focused && n.text === '').length === 1);
  return { assertions, query, actionIds: [entered.result.actionId, cleared.result.actionId] };
}

const pythonSource = `import time
def main(ctx):
    editor_id, title_id, query = ctx.inputs['editorId'], ctx.inputs['titleId'], ctx.inputs['query']
    assertions = []
    def nodes(tree):
        result = []
        def walk(node):
            if not node.get('visible'): return
            result.append(node)
            for child in node.get('children', []): walk(child)
        walk(tree['windows'][-1]['root'])
        return result
    def read_until(name, predicate):
        deadline = time.monotonic() + 5
        while True:
            read = ctx.call('tree', {'compact': False})
            if not read['ok']: raise Exception('tree:' + read['error'])
            condition = predicate(nodes(read['result']))
            if condition or time.monotonic() >= deadline:
                checked = ctx.assert_({'name': name, 'condition': condition, 'requiredEvidence': ['tree'], 'evidence': read['evidence']})
                assertions.append(checked)
                if checked['verdict'] != 'passed': raise Exception(name + ':' + checked['verdict'])
                return
            time.sleep(0.1)
    empty = lambda ns: len([n for n in ns if n.get('resourceName') == editor_id and n.get('focused') and n.get('text') == '']) == 1
    read_until('empty focused search editor', empty)
    entered = ctx.call('input-text', {'text': query})
    if not entered['ok'] or entered['result']['targetValidation'] != 'coordinates-or-focus': raise Exception(str(entered))
    read_until('query and exact matching result', lambda ns: any(n.get('resourceName') == editor_id and n.get('text') == query for n in ns)
        and len([n for n in ns if n.get('resourceName') == title_id]) == 1 and any(n.get('resourceName') == title_id and n.get('text') == query for n in ns))
    cleared = ctx.call('input-text', {'text': ''})
    if not cleared['ok']: raise Exception(str(cleared))
    read_until('search editor cleared', empty)
    return {'assertions': assertions, 'query': query, 'actionIds': [entered['result']['actionId'], cleared['result']['actionId']]}
`;

async function main({ out, serverPath, serial, packageName, query }) {
  assert.ok(query && typeof query === 'string', 'An exact independently observed title is required');
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const target = { serial, packageName };
  const inputs = { query, editorId: `${packageName}:id/EnterSearchKeyword`, titleId: `${packageName}:id/Title` };
  const client = createMcpClient({ serverPath, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts') } });
  let sequence = 0;
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
  const run = async (command, args) => {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const check = result => { assert.equal(result.ok, true, `${result.command}:${result.error}`); return result; };
  const nodes = tree => {
    const result = [];
    function walk(n) { if (!n.visible) return; result.push(n); for (const child of n.children || []) walk(child); }
    walk(tree.windows.at(-1).root); return result;
  };
  async function readUntil(predicate) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const tree = check(await run('tree', { ...target, compact: false }));
      if (predicate(nodes(tree))) return tree;
      assert.ok(Date.now() < deadline, 'Current search tree did not reach the required state');
      await delay(100);
    }
  }
  const empty = ns => ns.filter(n => n.resourceName === inputs.editorId && n.focused && n.text === '').length === 1;
  const report = { ok: false, target, serverPath, inputs, cases: [] };
  try {
    await client.initialize(); await readUntil(empty);
    check(await run('screenshot', { ...target, outFile: path.join(out, 'search-before.png'), feedback: 'off' }));
    let state = check(await run('intent', { operation: 'start', operationId: `input-binding-${Date.now()}`,
      goal: 'Enter the independently known note title in the observed search editor and clear it after checking the result.', target, provider: 'native',
      recordingDir: path.join(out, 'intent-recording') }));
    const operationId = state.operationId;
    async function decide(decisionId, value) {
      return check(await run('intent', { operation: 'decide', operationId, decision: { decisionId, basedOnRevision: state.revision,
        agentDecision: 'act', action: { provider: 'native', action: 'inputText', selector: { resourceName: inputs.editorId }, value } } }));
    }
    state = await decide('query-title', query);
    await readUntil(ns => ns.some(n => n.resourceName === inputs.editorId && n.text === query)
      && ns.filter(n => n.resourceName === inputs.titleId).length === 1 && ns.some(n => n.resourceName === inputs.titleId && n.text === query));
    check(await run('screenshot', { ...target, outFile: path.join(out, 'search-result.png'), feedback: 'off' }));
    state = check(await run('intent', { operation: 'observe', operationId }));
    state = await decide('clear-query', ''); await readUntil(empty);
    state = check(await run('intent', { operation: 'decide', operationId,
      decision: { decisionId: 'done', basedOnRevision: state.revision, agentDecision: 'complete' } }));
    assert.equal(state.status, 'completed');
    const archive = check(await run('evidence', { operation: 'export', namespace: 'intent', operationId, outputDir: path.join(out, 'intent-archive'), includeRecordedPayloads: true }));
    const receipts = JSON.parse(fs.readFileSync(path.join(out, 'intent-archive/records.json'))).map(row => row.payload).filter(row => row.kind === 'action-receipt');
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) {
      const sdk = receipt.providerResult.providerResult;
      assert.equal(sdk.targetValidation, 'aab.native-target/v1'); assert.equal(sdk.actionId, receipt.actionId); assert.equal(sdk.focused, true);
    }
    report.cases.push({ name: 'intent', operationId, status: state.status, sdkTargetValidated: 2, archive });
    for (const language of ['javascript', 'python']) {
      const source = language === 'javascript' ? `module.exports.main = ${javascriptFlow.toString()};` : pythonSource;
      const script = { schemaVersion: 'aab.code-script/v1', language, source, target: { platform: 'android', ...target }, inputs,
        permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 20000 } };
      write(`${language}-script.json`, script);
      const startedAt = Date.now();
      let state = check(await run('script', { operation: 'start', script, recordingDir: path.join(out, `${language}-recording`) })); const operationId = state.operationId;
      while (!['completed', 'failed', 'cancelled'].includes(state.status)) state = await run('script', { operation: 'wait', operationId, afterSequence: state.eventSequence, waitMs: 1000 });
      state = await run('script', { operation: 'status', operationId }); assert.equal(state.status, 'completed', `${language}:${state.error}`);
      const resultEnvelope = await run('script', { operation: 'result', operationId });
      assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
      const result = resultEnvelope.result;
      assert.equal(result.assertions.length, 3); assert.ok(result.assertions.every(a => a.verdict === 'passed'));
      const archive = check(await run('evidence', { operation: 'export', namespace: 'script', operationId, outputDir: path.join(out, `${language}-archive`), includeRecordedPayloads: true }));
      report.cases.push({ name: language, operationId, elapsedMs: Date.now() - startedAt, result, archive });
    }
    check(await run('screenshot', { ...target, outFile: path.join(out, 'search-after.png'), feedback: 'off' })); report.ok = true;
  } finally { report.mcpExit = await client.close({ stdinEof: true }); write('report.json', report); }
  return report;
}

if (require.main === module) {
  const [out, serverPath, serial, packageName, query] = process.argv.slice(2);
  main({ out: path.resolve(out), serverPath: path.resolve(serverPath), serial, packageName, query })
    .then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
