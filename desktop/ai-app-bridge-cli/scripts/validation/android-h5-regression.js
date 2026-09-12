'use strict';
// Authored after intent-02-completed.json and its independent Android witness.
module.exports.main = async ctx => {
  const assertions = [], actionIds = [];
  async function call(command, args = {}) {
    const result = await ctx.call(command, args);
    if (!result.ok) throw Error(JSON.stringify(result));
    return result;
  }
  async function check(name, condition, observation) {
    const result = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: observation.evidence });
    assertions.push(result); if (result.verdict !== 'passed') throw Error(JSON.stringify(result));
  }
  async function mutate(command, args) {
    const result = await call(command, args);
    if (!result.executionReceipt?.settled || result.executionReceipt.kind !== 'h5'
      || result.executionReceipt.actionId !== result.execution.actionId) throw Error('Original H5 receipt missing');
    actionIds.push(result.execution.actionId);
  }
  const initial = await call('h5-dom');
  const count = Number(initial.result.dom.bodyText.split('\n').map(s => s.trim()).find(s => /^\d+$/.test(s)));
  await check('Observed document and unique editor', initial.result.pageRef.schemaVersion === 'aab.android-h5-target/v1'
    && initial.result.dom.controls.filter(n => n.ariaLabel === 'Editor label' && n.editable).length === 1, initial);
  await mutate('h5-input', { selector: { ariaLabel: 'Editor label' }, text: '' });
  const cleared = await call('h5-dom');
  await check('Empty replacement cleared the editor', cleared.result.dom.controls.find(n => n.ariaLabel === 'Editor label').value === '', cleared);
  await mutate('h5-input', { selector: { ariaLabel: 'Editor label' }, text: ctx.inputs.text });
  const typed = await call('h5-dom');
  await check('Unicode replacement reached the editor', typed.result.dom.controls.find(n => n.ariaLabel === 'Editor label').value === ctx.inputs.text, typed);
  const waited = await call('h5-wait', { selector: { text: 'Count', tag: 'button' }, timeoutMs: 5000 });
  if (waited.execution.actionId !== null) throw Error('Observation wait gained a mutation identity');
  await mutate('h5-click', { selector: { text: 'Count', tag: 'button' } });
  const clicked = await call('h5-dom');
  await check('Exactly one visible counter increment', Number(clicked.result.dom.bodyText.split('\n').map(s => s.trim()).find(s => /^\d+$/.test(s))) === count + 1, clicked);
  await call('screenshot');
  return { gate: assertions.every(r => r.verdict === 'passed') ? 'passed' : 'failed', assertions, actionIds, before: count, after: count + 1 };
};
