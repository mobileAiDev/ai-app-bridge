'use strict';

// Real UI save, followed by a deliberate Script worker exit before the next
// checkpoint. Reentry is an explicit inspect-only state; it cannot replay Save.
exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const keys = ['elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel', 'placeholder', 'href', 'text'];
  const { marker, content } = ctx.inputs;
  async function call(command, arguments_ = {}) {
    const startedAtMs = Date.now();
    const reply = await ctx.call(command, arguments_);
    fs.appendFileSync(path.join(ctx.inputs.outputDir, 'calls.jsonl'), JSON.stringify({ command, startedAtMs,
      completedAtMs: Date.now(), reply }) + '\n', { mode: 0o600 });
    if (!reply.ok || reply.ambiguous) throw Error(`${command}:${reply.error}`);
    return reply;
  }
  function one(observation, predicate) {
    const matches = observation.result.dom.controls.filter(node => node.visible && predicate(node));
    if (matches.length !== 1) throw Error(`Expected one observed element; received ${matches.length}`);
    return matches[0];
  }
  function act(observation, node, command, arguments_ = {}) {
    return call(command, { selector: { elementId: node.elementId }, expectedTarget: {
      pageRef: observation.result.pageRef, element: Object.fromEntries(keys.map(key => [key, node[key]])),
    }, ...arguments_ });
  }
  const resumed = await ctx.resume();
  if (resumed === null) {
    await ctx.checkpoint('before-create', { phase: 'create' });
    let observed = await call('web-dom');
    await act(observed, one(observed, node => node.role === 'textbox' && node.editable), 'web-input', { value: content });
    observed = await call('web-dom');
    await act(observed, one(observed, node => node.tag === 'button' && node.text === 'Save' && !node.disabled), 'web-click');
    // A returned click receipt is not a database assertion. The controller
    // independently checks SQLite before deciding how this operation resumes.
    process.exit(31);
  }
  if (resumed.phase !== 'inspect-created') throw Error('Explicit inspect-created recovery state is required');
  await call('web-wait', { targetText: marker, timeoutMs: 5000 });
  const observed = await call('web-dom', { selector: 'article' });
  const articles = observed.result.dom.controls.filter(node => node.visible && node.text.includes(marker));
  const verdict = await ctx.assert({ name: 'the originally saved memo is visible exactly once after worker recovery',
    condition: articles.length === 1 && articles[0].text.includes(content), requiredEvidence: ['tree'], evidence: observed.evidence });
  if (verdict.verdict !== 'passed') throw Error(verdict.name);
  await ctx.checkpoint('created-memo-observed', { phase: 'done' });
  return { ok: true, marker, savedAgain: false, verdict };
};
