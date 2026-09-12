'use strict';

const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];
const editors = read => read.result.dom.controls.filter(node => node.visible && node.editable);
const hasButton = (read, label) => flatten(read.result.source).filter(node =>
  node.type === 'Button' && node.label === label && node.isVisible === '1' && node.isEnabled === '1').length === 1;
const elementKeys = ['elementId', 'tag', 'id', 'name', 'type', 'text', 'ariaLabel', 'href'];
const binding = read => ({ pageRef: read.result.pageRef,
  element: Object.fromEntries(elementKeys.map(key => [key, editors(read)[0][key]])) });
const lessonURL = 'zim://B237D3C6-4CE9-B57F-411A-3CCB8CC24367/index.html#/javascript-algorithms-and-data-structures/basic-javascript/cf1111c1c11feddfaeb3bdef';
const codeA = "const sum = 6 + 14;\nconsole.log('original tab', sum);";
const codeB = "const sum = 9 + 11;\nconsole.log('second tab', sum);";

// Derived from kiwix-tabs-intent-20260911-01 and the accepted editor Intent.
// Begin on the saved course's Instructions tab with no native sheet or keyboard.
// The two editors intentionally share URL, DOM ID and text before the stale-page
// rejection. Only their actual WebView/document identities distinguish them.
module.exports.main = async ctx => {
  const { outputDir, wdaSessionId, keyboardHideLabel } = ctx.inputs;
  if (!outputDir || !wdaSessionId || !keyboardHideLabel) throw new Error('Explicit outputDir, WDA session and keyboard label are required');
  fs.mkdirSync(outputDir, { recursive: false });
  let sequence = 0;
  const checks = [], artifacts = [], startedAtMs = Date.now();
  async function call(command, args = {}, options = {}) {
    const read = await ctx.call(command, { ...(options.native ? { wdaSessionId } : {}), ...args });
    fs.writeFileSync(path.join(outputDir, `${String(++sequence).padStart(3, '0')}-${command}.json`), JSON.stringify(read, null, 2) + '\n', { flag: 'wx' });
    if (options.expectedError) {
      if (read.ok || read.error !== options.expectedError) throw new Error(`${command}: expected ${options.expectedError}: ${JSON.stringify(read)}`);
    } else if (!read.ok) throw new Error(`${command}: ${read.error}: ${JSON.stringify(read.result)}`);
    return read;
  }
  async function check(name, condition, read, stream = 'tree') {
    const result = await ctx.assert({ name, condition, requiredEvidence: [stream], evidence: read.evidence });
    checks.push(result);
    if (result.verdict !== 'passed') throw new Error(`${name}: ${result.verdict}`);
  }
  async function observe(name, command, predicate, native = false) {
    const deadline = Date.now() + 15000;
    let read, previous, ready = false;
    do {
      read = await call(command, {}, { native });
      if (native) ready = predicate(read);
      else {
        const { dom, pageRef } = read.result;
        const signature = JSON.stringify([pageRef.webViewId, pageRef.documentId, dom.url,
          dom.viewport.width, dom.viewport.height, dom.viewport.scrollX, dom.viewport.scrollY,
          dom.controls.map(node => [node.elementId, node.text, node.interaction.status,
            node.bounds.left, node.bounds.top, node.bounds.width, node.bounds.height])]);
        ready = predicate(read) && dom.readyState === 'complete' && signature === previous;
        previous = signature;
      }
      if (ready) break;
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    await check(name, ready, read);
    return read;
  }
  const native = (name, predicate) => observe(name, 'ios-uia-tree', predicate, true);
  const h5 = (name, predicate) => observe(name, 'ios-h5-dom', predicate);
  const nativeTap = label => call('ios-tap-native', { selector: { label, type: 'Button' } }, { native: true });
  const h5Tap = text => call('ios-h5-click', { selector: { text, tag: 'button' } });
  const exactCode = code => read => read.result.dom.url === lessonURL && editors(read).length === 1 && editors(read)[0].text === code;
  async function closeKeyboard() {
    const read = await native('observe keyboard or native toolbar', read => hasButton(read, keyboardHideLabel) || hasButton(read, 'More'));
    if (hasButton(read, keyboardHideLabel)) await nativeTap(keyboardHideLabel);
    await native('native toolbar is available with keyboard closed', read => !hasButton(read, keyboardHideLabel) && hasButton(read, 'More'));
  }
  async function tabMenu() {
    await native('observe native overflow before changing tabs', read => hasButton(read, 'More'));
    await nativeTap('More');
    await native('tab manager is in the overflow menu', read => hasButton(read, 'Tabs Manager'));
    await nativeTap('Tabs Manager');
    await native('tab actions are visible', read => hasButton(read, 'New Tab') && hasButton(read, 'Close This Tab'));
  }
  async function screenshot(name) {
    const outFile = path.join(outputDir, name + '.png');
    const read = await call('ios-screenshot', { outFile });
    const sha256 = createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    await check(`${name}: screenshot bytes match the retained reference`, read.evidence.refs.some(ref =>
      ref.stream === 'screenshot' && ref.sha256 === sha256), read, 'screenshot');
    artifacts.push({ name, path: outFile, sha256, binding: 'separate capture after nearby DOM; not atomic' });
  }

  await h5('baseline is the saved course Instructions page', read => read.result.dom.url === lessonURL
    && editors(read).length === 0 && read.result.dom.bodyText.includes('Change the 0 so that sum will equal 20.'));
  await h5Tap('Code');
  let read = await h5('original tab has one ready editor', read => editors(read).length === 1 && editors(read)[0].interaction.status === 'ready');
  await call('ios-h5-input', { selector: { elementId: editors(read)[0].elementId }, text: codeA });
  read = await h5('original tab accepts its code', exactCode(codeA));
  const first = binding(read);
  await closeKeyboard();
  await tabMenu();
  await nativeTap('New Tab');
  await native('new tab opens the app homepage with the existing course bookmark', read =>
    hasButton(read, 'freeCodeCamp on Kiwix') && hasButton(read, 'Climate change'));
  await nativeTap('freeCodeCamp on Kiwix');
  read = await h5('second tab opens the same course URL in another WebView and document', read =>
    read.result.dom.url === lessonURL && read.result.pageRef.webViewId !== first.pageRef.webViewId
    && read.result.pageRef.documentId !== first.pageRef.documentId && editors(read).length === 0);
  const hidden = await call('ios-h5-dom', { webViewId: first.pageRef.webViewId }, { expectedError: 'ios_h5_webview_not_found' });
  await check('explicit hidden WebView read is rejected without selecting the new tab', !hidden.ok, read);
  await h5Tap('Code');
  read = await h5('second tab has its own ready editor', read => editors(read).length === 1 && editors(read)[0].interaction.status === 'ready');
  await call('ios-h5-input', { selector: { elementId: editors(read)[0].elementId }, text: codeA });
  read = await h5('second tab starts with identical editor content', exactCode(codeA));
  const second = binding(read);
  await check('URL and complete element identity match while page identities differ',
    first.pageRef.url === second.pageRef.url && isDeepStrictEqual(first.element, second.element)
    && first.pageRef.webViewId !== second.pageRef.webViewId && first.pageRef.documentId !== second.pageRef.documentId, read);
  const stale = await call('ios-h5-input', { selector: { elementId: second.element.elementId }, expectedTarget: first,
    text: 'THIS MUST NEVER REPLACE EITHER EDITOR' }, { expectedError: 'reobserve_required' });
  read = await h5('stale original-tab binding leaves the matching new editor unchanged', exactCode(codeA));
  await check('cross-tab input rejects before dispatch with no ambiguous effect', stale.result.dispatched === false && stale.result.ambiguous === false, read);
  await call('ios-h5-input', { selector: { elementId: second.element.elementId }, expectedTarget: second, text: codeB });
  read = await h5('explicit current-tab binding accepts the second tab code', exactCode(codeB));
  const editedSecond = binding(read);
  await closeKeyboard();
  await screenshot('second-tab-code');
  await tabMenu();
  await nativeTap('Close This Tab');
  read = await h5('closing only the new tab restores the original live editor and its unchanged code', read =>
    exactCode(codeA)(read) && isDeepStrictEqual(read.result.pageRef, first.pageRef)
    && editors(read)[0].elementId === first.element.elementId);
  const closed = await call('ios-h5-input', { webViewId: editedSecond.pageRef.webViewId,
    selector: { elementId: editedSecond.element.elementId }, expectedTarget: editedSecond,
    text: 'CLOSED TAB MUST NOT REDIRECT' }, { expectedError: 'ios_h5_webview_not_found' });
  read = await h5('closed-tab input cannot change the restored original editor', exactCode(codeA));
  await check('closed-tab mutation rejects before dispatch', closed.result.dispatched === false && closed.result.ambiguous === false, read);
  await screenshot('original-tab-restored');
  // Leave the course in the next run's observed Instructions state without saving code.
  await h5Tap('Instructions');
  await h5('final original page is the course Instructions tab', read => read.result.dom.url === lessonURL && editors(read).length === 0);
  const result = { ok: true, checks, artifacts, startedAtMs, elapsedMs: Date.now() - startedAtMs,
    sessionId: wdaSessionId, first, second, codeA, codeB,
    scope: 'Two real cached WKWebViews, identical URL and element identity, separate editor state, hidden/closed/stale target rejection and closing only the new native tab; no exercise execution or editor persistence across App restart' };
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
};
