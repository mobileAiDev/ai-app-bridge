'use strict';

// Rounded labels represent intervals; several distinct chart ticks can have
// the same label. This verifies the visible scale, never the exact data point.
module.exports.volumeAxisBracketsExpected = function volumeAxisBracketsExpected(nodes, expected) {
  const ranges = nodes.map(n => /^([0-9]+(?:\.([0-9]+))?)(K)?$/.exec(n.text || ''))
    .filter(Boolean).map(match => {
      const unit = match[3] ? 1000 : 1;
      const value = Number(match[1]) * unit;
      const halfStep = unit * (10 ** -(match[2]?.length || 0)) / 2;
      return [value - halfStep, value + halfStep];
    });
  return ranges.length > 0 && Math.min(...ranges.map(r => r[0])) <= expected
    && expected < Math.max(...ranges.map(r => r[1]));
};

// Authored from the physical iPhone Intent observations. Every mutation uses a
// newly observed Element ID; a failed or uncertain action is never replayed.
module.exports.main = async function main(ctx) {
  const { planTitle, baselinePlanTitle, screenshotDir, expectedDayVolumeKg,
    negativeOnly = false } = ctx.inputs;
  const verdicts = [];
  let epoch, lastObservedAt = -1, afterMutation = -1;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function call(command, args = {}) {
    const envelope = await ctx.call(command, args);
    if (!envelope.ok || envelope.ambiguous === true) throw new Error(`${command}:${envelope.error || 'ambiguous'}`);
    return envelope;
  }
  async function read() {
    const observation = await call('ios-flutter-nodes');
    const tree = observation.result;
    if (tree.truncated || !Array.isArray(tree.nodes) || !Number.isSafeInteger(tree.updatedAtMs)) {
      throw new Error('Complete, timestamped Flutter observation required');
    }
    if (epoch === undefined) epoch = tree.runtimeEpoch;
    if (!epoch || tree.runtimeEpoch !== epoch) throw new Error('Flutter runtime changed');
    lastObservedAt = tree.updatedAtMs;
    return observation;
  }
  const nodes = observation => observation.result.nodes;
  const textNodes = (observation, text) => nodes(observation).filter(n => n.text === text);
  const has = (observation, text) => textNodes(observation, text).length > 0;
  function volumeAxisBracketsExpected(observation) {
    return module.exports.volumeAxisBracketsExpected(nodes(observation), expectedDayVolumeKg);
  }
  function one(observation, predicate, name) {
    const found = nodes(observation).filter(predicate);
    if (found.length !== 1) throw new Error(`${name}:expected one control, got ${found.length}`);
    return found[0];
  }
  function fingerprint(observation) {
    // JSON object-key order from Swift is not part of Element identity.
    return JSON.stringify(nodes(observation).map(n => [n.id, n.text, n.value, n.role,
      n.targetRef?.runtimeEpoch, n.targetRef?.elementId, n.targetRef?.guard,
      n.bounds?.left, n.bounds?.top, n.bounds?.right, n.bounds?.bottom]));
  }
  async function until(name, predicate) {
    const deadline = Date.now() + 20000;
    let previous, previousAt = -1;
    while (Date.now() < deadline) {
      const observation = await read();
      if (observation.result.updatedAtMs > afterMutation && predicate(observation)) {
        const current = fingerprint(observation);
        if (current === previous && observation.result.updatedAtMs > previousAt) return observation;
        previous = current;
        previousAt = observation.result.updatedAtMs;
      } else { previous = undefined; previousAt = -1; }
      await delay(200);
    }
    throw new Error(`${name}:no stable observed state before deadline`);
  }
  async function check(name, observation, condition) {
    const verdict = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: observation.evidence });
    verdicts.push(verdict);
    if (verdict.verdict !== 'passed') throw new Error(`${name}:${verdict.verdict}`);
  }
  async function act(command, args) {
    afterMutation = lastObservedAt;
    return call(command, args);
  }
  async function tap(text) {
    const observation = await until(`${text} ready`, o => textNodes(o, text).filter(n => n.tap).length === 1);
    const node = one(observation, n => n.text === text && n.tap, text);
    return act('ios-tap-flutter', { selector: { nodeId: String(node.id) } });
  }
  async function input(index, count, value) {
    const editable = o => nodes(o).filter(n => n.input && n.input.enabled && !n.input.readOnly)
      .sort((a, b) => a.input.bounds.top - b.input.bounds.top);
    const observation = await until('observed form editors', o => editable(o).length === count);
    // These form positions are explicit sample contracts established by the
    // Intent's screenshots: plan title/search; workout reps/weight.
    const node = editable(observation)[index];
    await act('ios-input-flutter-text', { selector: { nodeId: String(node.id) }, text: value });
    const changed = await until('edited value', o => nodes(o).some(n => n.id === node.id && n.value === value));
    await check(`editor ${index} contains ${value}`, changed, true);
  }
  async function hideKeyboard() {
    await act('ios-flutter-hide-keyboard', {});
    return until('keyboard hidden', o => o.result.viewport.viewInsets.bottom === 0);
  }
  const screenshot = name => call('ios-screenshot', { outFile: `${screenshotDir}/${name}.png` });

  let observation = await read();
  if (negativeOnly) {
    await check('deliberately wrong workout result must fail', observation, has(observation, '999999 kg × 999'));
    return { verdicts };
  }
  await tap('Plans');
  observation = await until('known baseline plan', o => has(o, baselinePlanTitle) && has(o, 'Add'));
  await check('pinned baseline plan is visible', observation, has(observation, baselinePlanTitle));
  await check('new plan title is absent before creation', observation, !has(observation, planTitle));
  await tap('Add');
  await until('new plan form', o => has(o, 'Fri') && has(o, 'Barbell bench press') && has(o, 'Save'));
  await input(0, 2, planTitle);
  await hideKeyboard();
  await tap('Fri');
  await tap('Barbell bench press');
  await tap('Save');
  observation = await until('saved plan', o => has(o, planTitle) && has(o, baselinePlanTitle));
  await check('new and baseline plans coexist', observation, true);
  await screenshot('saved-plan');
  await tap(planTitle);
  await until('workout form', o => has(o, planTitle) && has(o, 'Kilograms (kg)'));

  for (const [index, reps, weight] of [[1, '8', '42.5'], [2, '6', '45']]) {
    await input(0, 2, reps);
    await input(1, 2, weight);
    await hideKeyboard();
    await tap('Save');
    observation = await until(`set ${index} persisted in UI`, o => has(o, `Set ${index}`) && has(o, `${weight} kg × ${reps}`));
    await check(`set ${index} has exact reps and weight`, observation, true);
  }
  await tap('45 kg × 6');
  await until('existing set editor', o => has(o, 'Cardio') && has(o, 'Created date'));
  // Name, reps, weight, body weight, category: observed in this pinned form.
  await input(2, 5, '47.5');
  await hideKeyboard();
  await tap('Save');
  observation = await until('edited second set', o => has(o, '42.5 kg × 8') && has(o, '47.5 kg × 6'));
  await check('edit preserves first set and replaces second weight', observation, !has(observation, '45 kg × 6'));
  await tap('47.5 kg × 6');
  // The icon text is from the actual Material Icon widget, confirmed by the
  // native screenshot. It is not a persistent node ID or a guessed coordinate.
  await tap('\ue1b9');
  observation = await until('delete confirmation', o => has(o, 'Confirm Delete') && has(o, 'Cancel'));
  await check('delete is awaiting confirmation', observation, has(observation, 'Are you sure you want to delete Barbell bench press?'));
  await screenshot('delete-confirmation');
  await tap('Cancel');
  await until('cancel returns to existing editor', o => has(o, 'Created date') && !has(o, 'Confirm Delete'));
  await tap('\uf570');
  observation = await until('both sets survive cancellation', o => has(o, '42.5 kg × 8') && has(o, '47.5 kg × 6'));
  await check('cancel preserves exactly two visible session sets', observation,
    nodes(observation).filter(n => /^Set \d+$/.test(n.text || '')).length === 2);
  await screenshot('two-sets');
  await tap('History');
  observation = await until('history shows updated values', o => has(o, '6 x 47.5 kg') && has(o, '8 x 42.5 kg'));
  await check('history shows recorded and edited weights', observation, true);
  await screenshot('history');
  await tap('Graphs');
  await until('graph list', o => has(o, 'Global progress'));
  await tap('Barbell bench press');
  // The baseline database pins Day/Volume. The external database oracle checks
  // the exact aggregate; a rounded axis label is not a plotted data value.
  observation = await until('daily volume graph', o => has(o, 'Volume') && has(o, 'Day') && volumeAxisBracketsExpected(o));
  await check('rounded Volume axis brackets the expected daily total', observation, true);
  await screenshot('volume');
  return { planTitle, expectedPlanSets: 2, expectedPlanRepetitions: 14,
    expectedPlanVolumeKg: 625, expectedDayVolumeKg, verdicts };
};
