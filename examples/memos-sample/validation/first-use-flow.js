'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Plans are authored from this run's observed DOM; unknown UI returns to the agent.
module.exports.main = async function main(ctx) {
  const out = ctx.inputs.output;
  fs.mkdirSync(out, { mode: 0o700 });
  let sequence = 0;
  const assertions = [];
  const calls = [];
  async function call(command, arguments_) {
    const startedAtMs = Date.now();
    const result = await ctx.call(command, arguments_);
    const item = { sequence: ++sequence, command, arguments: arguments_, startedAtMs,
      completedAtMs: Date.now(), result };
    fs.writeFileSync(path.join(out, String(sequence).padStart(3, '0') + '-' + command + '.json'),
      JSON.stringify(item, null, 2), { flag: 'wx', mode: 0o600 });
    calls.push({ sequence, command, elapsedMs: item.completedAtMs - startedAtMs,
      resultBytes: Buffer.byteLength(JSON.stringify(result)), ok: result.ok, error: result.error ?? null });
    if (!result.ok) throw new Error(JSON.stringify({ command, error: result.error, result }));
    return result;
  }
  let observation = await call('web-dom', {});
  const dom = () => observation.result.dom;
  const matches = (control, query) => Object.entries(query).every(([key, value]) => control[key] === value);
  const condition = spec => (!spec.urlNotIncludes || !dom().url.includes(spec.urlNotIncludes))
    && (!spec.urlIncludes || dom().url.includes(spec.urlIncludes))
    && (!spec.bodyIncludes || spec.bodyIncludes.every(text => dom().bodyText.includes(text)))
    && (!spec.bodyExcludes || spec.bodyExcludes.every(text => !dom().bodyText.includes(text)))
    && (!spec.controls || spec.controls.every(query => dom().controls.filter(c => matches(c, query)).length === 1));
  async function observeUntil(spec) {
    const deadline = Date.now() + 15000;
    do {
      observation = await call('web-dom', {});
      if (condition(spec)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error('Observed condition timed out: ' + JSON.stringify(spec));
  }
  async function assert(name, spec) {
    const value = await ctx.assert({ name, condition: condition(spec), requiredEvidence: ['tree'], evidence: observation.evidence });
    assertions.push(value);
    if (value.verdict !== 'passed') throw new Error('Assertion failed: ' + JSON.stringify(value));
  }
  let plan = ctx.inputs.plan;
  try {
    while (plan) {
      await ctx.progress({ phase: plan.name, atMs: Date.now() });
      for (const step of plan.steps ?? []) {
        if (step.assert) { await assert(step.assert.name, step.assert.condition); continue; }
        if (step.observeUntil) { await observeUntil(step.observeUntil); continue; }
        if (step.observe) { observation = await call('web-dom', step.observe); continue; }
        const candidates = dom().controls.filter(c => matches(c, step.select));
        if (candidates.length !== 1) throw new Error('Expected unique current control: ' + JSON.stringify({ select: step.select, candidates }));
        const control = candidates[0];
        const element = Object.fromEntries(['elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel', 'placeholder', 'href', 'text'].map(key => [key, control[key]]));
        await call(step.command, { selector: { elementId: control.elementId },
          expectedTarget: { pageRef: observation.result.pageRef, element }, ...step.arguments });
        if (step.observeAfter !== false) observation = await call('web-dom', {});
      }
      if (plan.waitFor) await observeUntil(plan.waitFor);
      if (plan.assert) await assert(plan.assert.name, plan.assert.condition);
      fs.writeFileSync(path.join(out, plan.name + '-dom.json'), JSON.stringify(observation, null, 2), { flag: 'wx', mode: 0o600 });
      if (plan.done) break;
      plan = await ctx.askAgent({ question: 'Decide the next bounded plan from this newly observed page.',
        completedPhase: plan.name, observationsDirectory: out,
        dom: { url: dom().url, bodyText: dom().bodyText, truncated: dom().truncated,
          controls: dom().controls.map(({ elementId, tag, id, type, role, ariaLabel, placeholder, href, text, visible, disabled, interaction }) =>
            ({ elementId, tag, id, type, role, ariaLabel, placeholder, href, text, visible, disabled, interaction })) } });
    }
    return { passed: true, assertions, calls, finalDom: dom(), output: out };
  } finally {
    fs.writeFileSync(path.join(out, 'ledger.json'), JSON.stringify({ assertions, calls }, null, 2), { flag: 'wx', mode: 0o600 });
  }
};
