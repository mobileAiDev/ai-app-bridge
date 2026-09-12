'use strict';

// Authored from form-observation-41: both editors initially contain 0, so the
// field declaration, not its value or position, identifies the intended input.
module.exports.main = async function main(ctx) {
  const { planTitle, weight, screenshotPath } = ctx.inputs;
  let epoch, afterMutation = -1, observedAt = -1;
  const verdicts = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fields = tree => tree.nodes.filter(n => n.input && n.input.enabled && !n.input.readOnly);
  const matching = (tree, label) => fields(tree).filter(n => n.label === label);
  const has = (tree, text) => tree.nodes.some(n => n.text === text);

  async function call(command, args = {}) {
    const result = await ctx.call(command, args);
    if (!result.ok || result.ambiguous) throw new Error(`${command}:${result.error || 'ambiguous'}`);
    return result;
  }
  async function until(name, predicate) {
    const deadline = Date.now() + 20000;
    let previous, previousAt = -1;
    while (Date.now() < deadline) {
      const observation = await call('ios-flutter-nodes');
      const tree = observation.result;
      if (tree.truncated || !Array.isArray(tree.nodes) || !Number.isSafeInteger(tree.updatedAtMs)) {
        throw new Error('Complete timestamped Flutter observation required');
      }
      if (epoch === undefined) epoch = tree.runtimeEpoch;
      if (!epoch || tree.runtimeEpoch !== epoch) throw new Error('Flutter runtime changed');
      observedAt = tree.updatedAtMs;
      if (observedAt > afterMutation && predicate(tree)) {
        const signature = JSON.stringify(tree.nodes.map(n => [n.id, n.text, n.value, n.label, n.hint,
          n.targetRef?.elementId, n.targetRef?.guard]));
        if (signature === previous && observedAt > previousAt) return observation;
        previous = signature;
        previousAt = observedAt;
      } else { previous = undefined; previousAt = -1; }
      await delay(200);
    }
    throw new Error(`${name}:no stable observation before deadline`);
  }
  async function check(name, observation, condition) {
    const verdict = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: observation.evidence });
    verdicts.push(verdict);
    if (verdict.verdict !== 'passed') throw new Error(`${name}:${verdict.verdict}`);
  }
  async function act(command, args = {}) {
    afterMutation = observedAt;
    return call(command, args);
  }

  const plans = await until('existing plans', tree => has(tree, planTitle) && has(tree, 'Wednesday'));
  const plan = plans.result.nodes.filter(n => n.text === planTitle && n.tap);
  await check('exact existing plan is selectable', plans, plan.length === 1);
  await act('ios-tap-flutter', { selector: { nodeId: String(plan[0].id) } });
  const form = await until('named editors', tree => matching(tree, 'Reps').length === 1
    && matching(tree, 'Weight (kg)').length === 1);
  await check('equal values have distinct field declarations', form,
    matching(form.result, 'Reps')[0].value === '0' && matching(form.result, 'Weight (kg)')[0].value === '0');
  await check('transparent skeleton text is absent', form,
    !has(form.result, 'Set 9') && !has(form.result, '8 kg × 50'));
  const editor = matching(form.result, 'Weight (kg)')[0];
  await act('ios-input-flutter-text', { selector: { nodeId: String(editor.id) }, text: weight });
  const edited = await until('named weight updated', tree => matching(tree, 'Weight (kg)')[0]?.value === weight);
  await check('only the declared weight field changed', edited,
    matching(edited.result, 'Weight (kg)')[0].id === editor.id && matching(edited.result, 'Reps')[0]?.value === '0');
  await act('ios-flutter-hide-keyboard');
  const settled = await until('keyboard hidden', tree => tree.viewport?.viewInsets?.bottom === 0
    && matching(tree, 'Weight (kg)')[0]?.value === weight);
  await check('edited form remains visible without placeholder records', settled,
    has(settled.result, planTitle) && !has(settled.result, 'Set 9') && !has(settled.result, '8 kg × 50'));
  await call('ios-screenshot', { outFile: screenshotPath });
  await act('ios-flutter-back');
  const returned = await until('unsaved form closed', tree => has(tree, planTitle) && has(tree, 'Wednesday'));
  await check('returned to plans without saving', returned, matching(returned.result, 'Weight (kg)').length === 0);
  return { verdicts, planTitle, weight, saved: false };
};
