'use strict';

// Existing NotallyX sample business code, English locale, no Bridge SDK in this APK.
// UIA selects the real controls; wrapped ADB injects ASCII key events into editors.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const { outDir, runId, resumeAfterEdit = false } = ctx.inputs, pkg = ctx.target.packageName;
  const title = `UIA-${runId}`, body = 'Original-note-body', edited = `${body}-edited`;
  const started = Date.now(), steps = [], checks = [];
  let phase = 'launch', error, failureObservation;
  async function attempt(command, args) {
    const start = Date.now(), r = await ctx.call(command, args);
    steps.push({ phase, command, arguments: args, ms: Date.now() - start, ok: r.ok, error: r.error, dispatched: r.dispatched });
    if (!r.ok) fs.writeFileSync(path.join(outDir, 'last-failure.json'), JSON.stringify(r, null, 2));
    return r;
  }
  async function call(command, args = {}) {
    const deadline = Date.now() + 1500;
    let r = await attempt(command, args);
    // This scenario can reselect the same semantic control during popup changes
    // only when the original receipt proves that no tap was dispatched.
    while (command === 'tap-uia' && args.selector
      && ['uia_selector_not_found', 'uia_reference_selector_mismatch', 'uia_reobserve_required'].includes(r.error)
      && r.dispatched === false && !r.ambiguous && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      r = await attempt(command, args);
    }
    if (!r.ok || r.ambiguous) throw new Error(`${phase}: ${command}: ${r.error}`);
    return r.result;
  }
  const tap = selector => call('tap-uia', { selector });
  const id = name => ({ resourceName: `${pkg}:id/${name}` });
  const wait = text => call('wait-text', { provider: 'uia', targetText: text, timeoutMs: 7000, intervalMs: 50 });
  const back = () => call('adb-exec', { argv: ['shell', 'input', 'keyevent', 'KEYCODE_BACK'] });
  const text = value => call('adb-exec', { argv: ['shell', 'input', 'text', value] });
  const read = () => call('uia-tree', { compact: true, packageFilter: pkg, maxNodes: 1000 });
  async function findNote() {
    const deadline = Date.now() + 6000;
    let searched = false, lastMatches = [];
    do {
      const tree = await read();
      const matches = tree.nodes.filter(n => n.resourceId === `${pkg}:id/Title` && n.text === title && n.effectiveVisible !== false);
      lastMatches = matches;
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        fs.appendFileSync(path.join(outDir, 'duplicate-observations.jsonl'), JSON.stringify({ observedAtMs: Date.now(), phase, matches }) + '\n');
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      const search = tree.nodes.find(n => n.contentDescription === 'Search' && n.targetRef);
      if (!searched && search) {
        await call('tap-uia', { targetRef: search.targetRef });
        await tap(id('EnterSearchKeyword'));
        await text(title);
        searched = true;
      } else await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    if (lastMatches.length > 1) throw new Error(`duplicate exact note title remains after waiting: ${title}`);
    throw new Error(`note is not visible after search: ${title}`);
  }
  async function openNote() {
    const note = await findNote();
    await call('tap-uia', { targetRef: note.targetRef });
    const tree = await check('opened the exact requested note', 'EnterTitle', title);
    if (tree.nodes.some(n => n.resourceId === `${pkg}:id/EnterSearchKeyword`)) {
      await tap({ className: 'android.widget.ImageButton', within: { resourceName: `${pkg}:id/Toolbar` } });
    }
  }
  async function check(name, selector, expected) {
    const deadline = Date.now() + 4000;
    let passed = false, tree;
    do {
      tree = await call('uia-tree', { compact: true, packageFilter: pkg, resourceIdFilter: `${pkg}:id/`, maxNodes: 300 });
      passed = tree.nodes.filter(n => n.resourceId === `${pkg}:id/${selector}` && n.text === expected).length === 1;
      if (!passed) await new Promise(resolve => setTimeout(resolve, 50));
    } while (!passed && Date.now() < deadline);
    checks.push({ name, passed });
    if (!passed) throw new Error(`${name}: expected one ${selector} with ${expected}`);
    return tree;
  }
  async function folder(label) {
    const tree = await read();
    if (!tree.nodes.some(n => n.contentDescription === 'Open navigation drawer')
      && tree.nodes.some(n => n.resourceId === `${pkg}:id/EnterSearchKeyword`)) {
      await tap({ contentDescription: 'Navigate up' });
    }
    await tap({ contentDescription: 'Open navigation drawer' });
    await tap({ ...id('design_menu_item_text'), text: label });
  }
  async function menu(label) {
    await tap({ contentDescription: 'Tap for more options' });
    await tap({ text: label });
  }
  try {
    if (resumeAfterEdit) {
      phase = 'resume-existing-note';
      const current = await read();
      if (!current.nodes.some(n => n.resourceId === `${pkg}:id/EnterTitle` && n.text === title)) await openNote();
      await check('continuation selects original exact title', 'EnterTitle', title);
      await check('continuation preserves original saved edit', 'EnterBody', edited);
    } else {
      await call('launch-activity', { activity: 'com.philkes.notallyx.presentation.activity.main.MainActivity', clearTask: true });
      await wait('Take note');
      phase = 'create';
      await tap({ contentDescription: 'Take note' });
      await tap(id('EnterTitle')); await text(title);
      await tap(id('EnterBody')); await text(body);
      await check('editor received input events', 'EnterBody', body);
      await back();
      await tap({ contentDescription: 'Pin' });
      await wait('Unpin');
      await back();
      phase = 'edit-and-reopen';
      await openNote();
      await tap(id('EnterBody'));
      await call('adb-exec', { argv: ['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END'] });
      await text('-edited'); await back(); await back();
      await openNote();
      await check('reopened note retains edit', 'EnterBody', edited);
    }
    phase = 'archive-and-restore';
    await menu('Archive'); await folder('Archived');
    await openNote();
    await menu('Unarchive'); await folder('Notes');
    await openNote();
    phase = 'trash-and-restore';
    await menu('Delete'); await folder('Deleted');
    await openNote();
    await menu('Restore'); await folder('Notes');
    await findNote();
    phase = 'process-restart-and-persistence';
    await call('adb-exec', { argv: ['shell', 'am', 'force-stop', pkg] });
    await call('adb-exec', { argv: ['exec-out', 'run-as', pkg, 'tar', '-cf', '-', 'databases'], readOnly: true,
      outFile: path.join(outDir, 'databases.tar') });
    await call('launch-activity', { activity: 'com.philkes.notallyx.presentation.activity.main.MainActivity' });
    await openNote();
    await check('process restart retains exact title', 'EnterTitle', title);
    await check('process restart retains exact body', 'EnterBody', edited);
    await wait('Unpin');
    await call('screenshot', { outFile: path.join(outDir, 'reopened-note.png') });
  } catch (e) {
    error = e.message;
    try { await call('screenshot', { outFile: path.join(outDir, 'failure.png') }); } catch (_) {}
    try { const r = await call('uia-tree', { compact: true, maxNodes: 1000 });
      failureObservation = r.nodes.filter(n => n.packageName === pkg && (n.text || n.contentDescription))
        .map(n => ({ text: n.text, description: n.contentDescription, resourceId: n.resourceId }));
    } catch (e) { failureObservation = { error: e.message }; }
  }
  const report = { ok: !error, runId, resumeAfterEdit, title, body: edited, phase, error, ms: Date.now() - started, commands: steps.length, checks };
  fs.writeFileSync(path.join(outDir, 'details.json'), JSON.stringify({ report, steps, failureObservation }, null, 2));
  return report;
};
