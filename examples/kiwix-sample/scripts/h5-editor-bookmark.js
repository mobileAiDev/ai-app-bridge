'use strict';

const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];
const buttons = (read, label) => flatten(read.result.source).filter(node =>
  node.type === 'Button' && node.label === label && node.isVisible === '1' && node.isEnabled === '1');
const has = (read, label) => buttons(read, label).length === 1;
const editors = read => read.result.dom.controls.filter(node => node.visible && node.editable);
const lessonURL = 'zim://B237D3C6-4CE9-B57F-411A-3CCB8CC24367/index.html#/javascript-algorithms-and-data-structures/basic-javascript/cf1111c1c11feddfaeb3bdef';
const code = "const sum = 6 + 14;\nconsole.log('Script 复跑', sum);";
// CodeMirror renders this non-editable placeholder only when its document is empty.
// DOM text includes the placeholder; it is not the editor's document value.
const emptyEditorText = 'Code goes here...\n';

// Derived from kiwix-fcc-intent-20260911-03. Baseline: this lesson's Code tab
// under its open native bookmark sheet, with this lesson and Climate change saved.
// Exercises are not executed: the unmodified archive places Run outside the
// actual WKWebView viewport. Editor state and persisted bookmarks are separate checks.
module.exports.main = async ctx => {
  const { outputDir, wdaSessionId, keyboardHideLabel } = ctx.inputs;
  if (!outputDir || !wdaSessionId || !keyboardHideLabel) throw new Error('Explicit outputDir, WDA session and observed keyboardHideLabel are required');
  fs.mkdirSync(outputDir, { recursive: false });
  let sessionId = wdaSessionId, sequence = 0;
  const checks = [], artifacts = [], startedAtMs = Date.now();
  async function call(command, args = {}, native = false) {
    const read = await ctx.call(command, { ...(native ? { wdaSessionId: sessionId } : {}), ...args });
    fs.writeFileSync(path.join(outputDir, `${String(++sequence).padStart(3, '0')}-${command}.json`), JSON.stringify(read, null, 2) + '\n', { flag: 'wx' });
    if (!read.ok) throw new Error(`${command}: ${read.error}: ${JSON.stringify(read.result)}`);
    return read;
  }
  async function check(name, condition, read, stream = 'tree') {
    const result = await ctx.assert({ name, condition, requiredEvidence: [stream], evidence: read.evidence });
    checks.push(result);
    if (result.verdict !== 'passed') throw new Error(`${name}: ${result.verdict}`);
  }
  async function waitNative(name, predicate) {
    const deadline = Date.now() + 15000;
    let read;
    do {
      read = await call('ios-uia-tree', {}, true);
      if (predicate(read)) break;
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    await check(name, predicate(read), read);
    return read;
  }
  async function waitH5(name, predicate) {
    const deadline = Date.now() + 15000;
    let read, previous, stable = false;
    do {
      read = await call('ios-h5-dom');
      const { dom, pageRef } = read.result;
      const { width, height, scrollX, scrollY } = dom.viewport;
      const signature = JSON.stringify([pageRef.documentId, dom.url, [width, height, scrollX, scrollY],
        dom.controls.map(n => [n.elementId, n.text, n.editable, n.interaction.status,
          n.bounds.left, n.bounds.top, n.bounds.width, n.bounds.height])]);
      stable = predicate(read) && dom.readyState === 'complete' && previous === signature;
      if (stable) break;
      previous = signature;
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    await check(name, stable && predicate(read), read);
    return read;
  }
  const nativeTap = label => call('ios-tap-native', { selector: { label, type: 'Button' } }, true);
  const h5Tap = text => call('ios-h5-click', { selector: { text, tag: 'button' } });
  async function closeKeyboard() {
    const keyboard = await waitNative('observe keyboard or the unobscured native toolbar', read =>
      has(read, keyboardHideLabel) || has(read, 'Show Bookmarks'));
    if (has(keyboard, keyboardHideLabel)) {
      await nativeTap(keyboardHideLabel);
      await waitNative('keyboard closes through its observed native control', read =>
        !has(read, keyboardHideLabel) && has(read, 'Show Bookmarks'));
    }
  }
  async function screenshot(name) {
    const outFile = path.join(outputDir, name + '.png');
    const read = await call('ios-screenshot', { outFile });
    const sha256 = createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    await check(`${name}: captured screenshot bytes`, read.evidence.refs.some(ref =>
      ref.stream === 'screenshot' && ref.sha256 === sha256), read, 'screenshot');
    artifacts.push({ name, path: outFile, sha256, binding: 'separate capture after nearby tree or DOM; not atomic' });
  }
  const saved = read => has(read, 'freeCodeCamp on Kiwix') && has(read, 'Climate change') && has(read, 'Remove Bookmark');
  await waitNative('baseline contains both archive bookmarks and current removal control', saved);
  await nativeTap('Remove Bookmark');
  await waitNative('only the current course bookmark is removed', read =>
    !has(read, 'freeCodeCamp on Kiwix') && has(read, 'Climate change') && has(read, 'Add Bookmark'));
  await nativeTap('Done');
  await waitNative('bookmark sheet closes before H5 editing', read => has(read, 'Show Bookmarks') && !has(read, 'Done'));
  let read = await waitH5('real course exposes one editable code control and its frozen lesson URL', read =>
    read.result.dom.url === lessonURL && editors(read).length === 1 && editors(read)[0].interaction.status === 'ready');
  const run = read.result.dom.controls.filter(n => n.tag === 'button' && n.text === 'Run');
  await check('sample Run is rendered outside the viewport; exercise execution remains unverified',
    run.length === 1 && run[0].visible && run[0].interaction.status === 'outside-viewport'
    && run[0].bounds.top >= read.result.dom.viewport.height, read);

  await call('ios-h5-input', { selector: { elementId: editors(read)[0].elementId }, text: '' });
  read = await waitH5('clearing shows the real empty-editor placeholder in an editable control', read =>
    editors(read).length === 1 && editors(read)[0].text === emptyEditorText);
  const emptyEditorId = editors(read)[0].elementId;
  await closeKeyboard();
  await h5Tap('Instructions');
  await waitH5('instructions remove the code editor', read => editors(read).length === 0
    && read.result.dom.bodyText.includes('Change the 0 so that sum will equal 20.'));
  await h5Tap('Code');
  read = await waitH5('App recreates a new empty editor from its own state', read =>
    editors(read).length === 1 && editors(read)[0].elementId !== emptyEditorId
    && editors(read)[0].text === emptyEditorText && editors(read)[0].interaction.status === 'ready');
  await call('ios-h5-input', { selector: { elementId: editors(read)[0].elementId }, text: code });
  read = await waitH5('multiline Unicode replacement appears in the real editor', read =>
    editors(read).length === 1 && editors(read)[0].text === code);
  const editedId = editors(read)[0].elementId;
  await closeKeyboard();
  await h5Tap('Instructions');
  await waitH5('second tab switch removes the edited DOM node', read => editors(read).length === 0);
  await h5Tap('Code');
  await waitH5('App model restores all code into a newly created editor', read =>
    editors(read).length === 1 && editors(read)[0].elementId !== editedId && editors(read)[0].text === code);
  await closeKeyboard();
  await screenshot('code-recreated-from-app-state');
  await waitNative('native toolbar is ready after the editor screenshot', read => has(read, 'Show Bookmarks'));
  await nativeTap('Show Bookmarks');
  await waitNative('unsaved course still preserves the Wikipedia bookmark', read =>
    has(read, 'Add Bookmark') && has(read, 'Climate change') && !has(read, 'freeCodeCamp on Kiwix'));
  await nativeTap('Add Bookmark');
  await waitNative('saving publishes both bookmarks and the removal control', saved);
  await screenshot('saved-course-bookmark');
  await waitNative('saved bookmark sheet remains bound after the screenshot', saved);
  await nativeTap('Done');
  read = await waitNative('native sheet closes before process restart', read => has(read, 'Show Bookmarks') && !has(read, 'Done'));
  const previousProcessId = read.result.session.processId;
  await call('ios-wda-session', { operation: 'close' }, true);
  await call('ios-launch-app', { terminateExisting: true });
  const created = await call('ios-wda-session', { operation: 'create' });
  sessionId = created.result.session.sessionId;
  await waitNative('real App restart restores the reader toolbar in a new process', read =>
    read.result.session.processId !== previousProcessId && has(read, 'Show Bookmarks'));
  await nativeTap('Show Bookmarks');
  await waitNative('real App restart preserves both bookmark entries', read =>
    read.result.session.processId !== previousProcessId && has(read, 'freeCodeCamp on Kiwix') && has(read, 'Climate change'));
  await nativeTap('freeCodeCamp on Kiwix');
  await waitH5('saved bookmark reopens the exact SPA lesson route and instructions', read =>
    read.result.dom.url === lessonURL && read.result.dom.bodyText.includes('Change the 0 so that sum will equal 20.'));
  await screenshot('lesson-bookmark-after-restart');
  const result = { ok: true, checks, artifacts, sessionId, previousProcessId,
    processId: created.result.session.processId, startedAtMs, elapsedMs: Date.now() - startedAtMs,
    scope: 'H5 empty/multiline editor state across real editor recreation, native keyboard control, bookmark save and restart reopening; no exercise execution or durable code-progress claim' };
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
};
