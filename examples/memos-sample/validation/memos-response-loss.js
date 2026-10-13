'use strict';

// The external harness loses the original CreateMemo response after the real
// server processes it. Ask the agent to query persistence before any new write.
exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const { marker, content, outputDir } = ctx.inputs;
  const keys = ['elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel', 'placeholder', 'href', 'text'];
  const calls = [];
  async function call(command, args = {}) {
    const startedAtMs = Date.now();
    const reply = await ctx.call(command, args);
    calls.push({ command, startedAtMs, completedAtMs: Date.now(), ok: reply.ok });
    fs.appendFileSync(path.join(outputDir, 'calls.jsonl'), JSON.stringify({ ...calls.at(-1), reply }) + '\n', { mode: 0o600 });
    if (!reply.ok || reply.ambiguous) throw Error(`${command}:${reply.error}`);
    return reply;
  }
  function one(observed, predicate) {
    const nodes = observed.result.dom.controls.filter(node => node.visible && predicate(node));
    if (nodes.length !== 1) throw Error(`Expected one observed control; received ${nodes.length}`);
    return nodes[0];
  }
  function act(observed, node, command, args = {}) {
    return call(command, { selector: { elementId: node.elementId }, expectedTarget: { pageRef: observed.result.pageRef,
      element: Object.fromEntries(keys.map(key => [key, node[key]])) }, ...args });
  }
  const began = Date.now();
  let observed = await call('web-dom');
  if (observed.result.dom.controls.some(node => node.visible && node.tag === 'button' && node.text === 'Remove filter')) {
    await act(observed, one(observed, node => node.tag === 'button' && node.text === 'Remove filter'), 'web-click');
    observed = await call('web-dom');
  }
  const before = await call('web-network');
  await act(observed, one(observed, node => node.role === 'textbox' && node.editable), 'web-input', { value: content });
  observed = await call('web-dom');
  await act(observed, one(observed, node => node.tag === 'button' && node.text === 'Save' && !node.disabled), 'web-click');
  let lost;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const captured = await call('web-network', { factCursor: before.evidence.capture.watermarkCursor });
    const records = captured.result.items.filter(record => record.url.endsWith('/memos.api.v1.MemoService/CreateMemo'));
    if (records.length > 1) throw Error('Unexpected duplicate save requests');
    if (records.length === 1 && records[0].error && records[0].statusCode === -1) { lost = records[0]; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!lost) throw Error('Expected the original save response to be lost');
  observed = await call('web-dom');
  const editor = one(observed, node => node.role === 'textbox' && node.editable);
  if (!editor.text.includes(marker)) throw Error('The failed response did not retain the draft');
  const decision = await ctx.askAgent({ checkpoint: 'save-response-lost', marker,
    requestCount: 1, draftRetained: true,
    instruction: 'Query the real SQLite database. If the original memo exists exactly once, reload this page and answer with {persistedOnce:true,target:<new observed Web target>}; do not click Save again.' });
  if (decision.persistedOnce !== true || decision.target?.platform !== 'web') throw Error('Persistence and a fresh Web target are required');
  const target = Object.fromEntries(['sessionId', 'runtimeEpoch', 'targetId'].map(key => [key, decision.target[key]]));
  await call('web-wait', { ...target, targetText: marker, timeoutMs: 5000 });
  observed = await call('web-dom', { ...target, selector: 'article' });
  const articles = observed.result.dom.controls.filter(node => node.visible && node.text.includes(marker));
  const verdict = await ctx.assert({ name: 'the original response-lost memo is rendered exactly once after reload',
    condition: articles.length === 1 && articles[0].text.includes(content), requiredEvidence: ['tree'], evidence: observed.evidence });
  if (verdict.verdict !== 'passed') throw Error(verdict.name);
  // Reload can restore Memos' local draft even though the memo is persisted.
  // Clear only this confirmed saved draft; never submit it a second time.
  observed = await call('web-dom', target);
  const retained = one(observed, node => node.role === 'textbox' && node.editable);
  if (retained.text.trim() !== content) throw Error('The saved draft changed; preserve it for an agent decision');
  await act(observed, retained, 'web-input', { ...target, value: '' });
  observed = await call('web-dom', { ...target, selector: '[role="textbox"]' });
  if (observed.result.dom.controls.some(node => node.text.includes(marker))) throw Error('The saved draft was not cleared');
  return { ok: true, marker, elapsedIncludingAgentMs: Date.now() - began, calls: calls.length,
    savedAgain: false, draftRetained: true, savedDraftCleared: true, originalRequestCount: 1, verdict };
};
