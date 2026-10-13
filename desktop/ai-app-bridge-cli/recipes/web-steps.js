'use strict';

// Optional ordinary JavaScript helpers. Import this source from another Script
// or copy/edit it; predicates and business branches remain caller code.
// const web = createWebSteps(ctx), page = await web.read();
// const control = web.one(page, c => c.placeholder === ctx.inputs.field);
// await web.action('web-input', page, control, { value: ctx.inputs.value });
// await web.action('web-click', page, observedButton);
// await web.action('web-key', page, control, { key: 'Enter' }); // Enter or Escape
// await web.wait(p => p.dom.bodyText.includes(ctx.inputs.successText));
// Wait for the actual usable control/result; URL changes alone can precede it.
function createWebSteps(ctx) {
  const fail = (code, message, details) => Object.assign(new Error(message), { code, ...details });
  const route = page => {
    const { sessionId, runtimeEpoch, targetId } = page.pageRef;
    return { sessionId, runtimeEpoch, targetId };
  };
  async function call(command, args) {
    const reply = await ctx.call(command, args);
    if (!reply.ok) throw fail('web_call_failed', `${command} failed${typeof reply.error === 'string' ? ` (${reply.error.slice(0, 128)})` : ''}; inspect error.reply and the original call record.`, { command, reply });
    return reply;
  }
  const read = async (args = {}) => (await call('web-dom', args)).result;
  function one(page, predicate) {
    const candidates = page.dom.controls.filter(predicate);
    if (candidates.length !== 1) throw fail(candidates.length ? 'web_element_ambiguous' : 'web_element_not_found',
      `Matched ${candidates.length} controls; inspect error.candidates and refine the predicate or ask for the unresolved choice.`, { candidates });
    return candidates[0];
  }
  function bind(page, control) {
    return { ...route(page), selector: { elementId: control.elementId },
      expectedTarget: { pageRef: page.pageRef, element: control } };
  }
  const action = (command, page, control, args = {}) => call(command, { ...args, ...bind(page, control) });
  async function wait(predicate, { initial, timeoutMs = 15000, intervalMs = 150 } = {}) {
    for (const [name, value] of Object.entries({ timeoutMs, intervalMs })) {
      if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new Error(`${name} must be a positive integer in milliseconds, at most 2147483647.`);
    }
    const deadline = Date.now() + timeoutMs;
    let page = initial;
    while (true) {
      if (page && await predicate(page)) return page;
      if (page) await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw fail('web_condition_timeout',
        `Condition not observed within ${timeoutMs} ms; inspect error.observation before choosing another action.`, { timeoutMs, observation: page });
      // Keep the explicitly selected observation's route. A changed document
      // is reported by the Host; this helper never refreshes identity or replays.
      page = await read({ ...(page ? route(page) : {}), timeoutMs: Math.min(30000, remaining) });
    }
  }
  return { read, one, bind, action, wait };
}

// Running the installed recipe performs only a complete initial observation.
// Continue in a caller-owned Script with require(recipe.sourcePath).
exports.main = async ctx => createWebSteps(ctx).read();
exports.createWebSteps = createWebSteps;
