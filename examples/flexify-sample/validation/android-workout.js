'use strict';

// Pinned upstream workout scenario, using current semantic observations.
// Run with a new planTitle/output directory; effects are never replayed here.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const { planTitle, outDir, resumeAfterPlan = false, resumeAfterSet1 = false, resumeAtEdit = false } = ctx.inputs, steps = [], checks = [];
  const startedAtMs = Date.now();
  let phase = 'plans', error;
  async function call(command, args = {}) {
    const began = Date.now(), reply = await ctx.call(command, args);
    steps.push({ phase, command, args, elapsedMs: Date.now() - began, reply });
    if (!reply.ok || reply.ambiguous) throw new Error(`${phase}: ${command}: ${reply.error || 'ambiguous'}`);
    return reply.result;
  }
  const tap = targetText => call('tap-flutter-text', { targetText });
  const wait = (targetText, timeoutMs = 10000) => call('wait-text', { provider: 'flutter', targetText, timeoutMs, intervalMs: 50 });
  const input = (label, text) => call('input-flutter-text', { selector: { label, role: 'input' }, text, focus: false });
  async function check(name, condition) {
    const result = await ctx.assert({ name, condition, scope: 'code' });
    checks.push({ name, verdict: result.verdict });
    if (result.verdict !== 'passed') throw new Error(name);
  }
  const screenshot = name => call('screenshot', { outFile: path.join(outDir, `${name}.png`) });
  try {
    if (!resumeAtEdit && !resumeAfterSet1) {
      await call('launch-activity', { activity: 'com.presley.flexify.MainActivity', clearTask: true });
      // Readiness is part of the reported wall time, including slow cold starts.
      await wait('Plans', 30000);
    }
    if (resumeAtEdit) {
      const before = await call('flutter-nodes');
      await check('explicit continuation starts at the unchanged second-set editor',
        before.nodes.some(n => n.label === 'Weight (kg)' && n.value === '45')
        && before.nodes.some(n => n.label === 'Reps' && n.value === '6')
        && before.nodes.some(n => n.label === 'Name' && n.value === 'Barbell bench press'));
    } else {
      if (resumeAfterSet1) {
        const before = await call('flutter-nodes');
        await check('explicit continuation starts at the original single saved set',
          before.nodes.some(n => n.text === planTitle) && before.nodes.some(n => n.text === '42.5 kg × 8')
          && before.nodes.filter(n => /^Set \d+$/.test(n.text || '')).length === 1);
      } else {
        await tap('Plans');
        await wait('Monday');
        if (!resumeAfterPlan) {
          await tap('Add');
          await wait('Add plan');
          await input('Title (optional)', planTitle);
          await tap('Fri');
          await tap('Barbell bench press');
          await tap('Save');
          await wait('Monday');
        }
        // Upstream search matches days/exercises, not the plan title. Reveal the
        // saved row in the observed list; never use a search input as row proof.
        const plans = await call('flutter-nodes');
        if (!plans.nodes.some(n => n.text === planTitle && n.role === 'control' && n.actions.includes('tap'))) {
          const lists = plans.nodes.filter(n => n.role === 'scrollable' && n.scroll?.axis === 'vertical'
            && n.scroll.maxScrollExtent > n.scroll.minScrollExtent);
          if (lists.length !== 1) throw new Error(`Expected one observed plans list, got ${lists.length}`);
          await call('scroll-flutter', { selector: { nodeId: String(lists[0].id) }, targetText: planTitle, maxSwipes: 8 });
        }
        await wait(planTitle);
        await screenshot('saved-plan');
        await tap(planTitle);
        await wait('Kilograms (kg)');
        if (resumeAfterPlan) {
          const before = await call('flutter-nodes');
          await check('explicit continuation opens the exact saved plan without existing sets',
            before.nodes.some(n => n.text === planTitle)
            && !before.nodes.some(n => /^Set \d+$/.test(n.text || '')));
        }
      }
      phase = 'record-sets';
      const sets = resumeAfterSet1 ? [['6', '45']] : [['8', '42.5'], ['6', '45']];
      for (const [reps, weight] of sets) {
        await input('Reps', reps);
        await input('Weight (kg)', weight);
        await tap('Save');
        await wait(`${weight} kg × ${reps}`);
      }
      phase = 'edit-and-cancel-delete';
      await tap('45 kg × 6');
      await wait('Created date');
    }
    phase = 'edit-and-cancel-delete';
    await input('Weight (kg)', '47.5');
    await tap('Save');
    await wait('47.5 kg × 6');
    await tap('47.5 kg × 6');
    await wait('Created date');
    await tap('\ue1b9');
    await wait('Confirm Delete');
    await screenshot('delete-confirmation');
    await tap('Cancel');
    await wait('Created date');
    await tap('Back');
    await wait('47.5 kg × 6');
    const tree = await call('flutter-nodes');
    await check('cancel preserves both exact sets', tree.nodes.some(n => n.text === '42.5 kg × 8')
      && tree.nodes.some(n => n.text === '47.5 kg × 6')
      && tree.nodes.filter(n => /^Set \d+$/.test(n.text || '')).length === 2);
    phase = 'history-and-graphs';
    await tap('History');
    await wait('6 x 47.5 kg');
    await wait('8 x 42.5 kg');
    await screenshot('history');
    await tap('Graphs');
    await wait('Global progress');
    await tap('Barbell bench press');
    const graph = await call('flutter-nodes');
    if (graph.nodes.some(n => n.text === 'Best weight')) {
      await tap('Best weight');
      await wait('Volume');
      await tap('Volume');
    }
    await wait('Volume');
    await screenshot('graph');
  } catch (failure) {
    error = failure.message;
    try { await screenshot('failure'); } catch (_) {}
    try { await call('flutter-nodes'); } catch (_) {}
  }
  const result = { ok: !error, startedAtMs, finishedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs,
    phase, error, planTitle, resumeAfterPlan, resumeAfterSet1, resumeAtEdit, expectedSets: 2, expectedRepetitions: 14, expectedVolumeKg: 625, calls: steps.length, checks };
  fs.writeFileSync(path.join(outDir, 'workout.json'), JSON.stringify({ result, steps }, null, 2));
  return result;
};
