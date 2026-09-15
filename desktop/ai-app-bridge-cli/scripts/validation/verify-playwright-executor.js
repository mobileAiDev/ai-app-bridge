'use strict';

// Deliberately outside unit discovery: this launches the pinned real browser.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PlaywrightHost } = require('../../bin/executors/playwright-host');
const { runExecution } = require('../../bin/shared-kernel/execution-scope');

async function main() {
  const directory = path.resolve(process.argv[2] || '../../build/executor-0.3.7');
  const browser = process.argv[3] || 'chromium';
  const evidenceName = browser === 'chromium' ? 'playwright-verification.json' : `playwright-${browser}-verification.json`;
  fs.mkdirSync(directory, { recursive: true });
  const host = new PlaywrightHost({ home: path.join(directory, 'cache') });
  const proof = { startedAt: new Date().toISOString(), checks: [], actions: [] };
  let port;
  let raceSignal, raceClicks = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/race-events') {
      response.setHeader('content-type', 'text/event-stream'); response.write(': ready\n\n'); raceSignal = response; return;
    }
    if (request.url === '/race-click') { raceClicks++; response.end('recorded'); return; }
    if (request.url === '/race') {
      response.end('<button data-testid="race-button" disabled>Old document</button><script>new EventSource("/race-events").onmessage=()=>location.href="/race-next"</script>'); return;
    }
    if (request.url === '/race-next') {
      response.end('<button data-testid="race-button" onclick="fetch(\'/race-click\')">New document</button>'); return;
    }
    if (request.url === '/frame') { response.end('<title>Cross origin H5</title><button data-testid="frame-button" onclick="this.textContent=\'H5 clicked\'">H5</button>'); return; }
    if (request.url === '/next') { response.end('<title>Next document</title><h1>Next document</h1><button data-testid="save" onclick="count.textContent=String(Number(count.textContent)+1)">Save</button><p data-testid="count" id="count">0</p>'); return; }
    response.end(`<!doctype html><title>Executor fixture</title>
      <style>body{font:18px sans-serif;padding:24px}label,button,iframe{display:block;margin:12px}iframe{height:100px}</style>
      <h1>Executor fixture</h1><label>商品名称<input data-testid="name"></label>
      <input type="checkbox" data-testid="enabled"><select data-testid="choice"><option>A</option><option>B</option></select>
      <button data-testid="save" onclick="count.textContent=String(Number(count.textContent)+1)">Save</button><p data-testid="count" id="count">0</p>
      <button data-testid="disabled" disabled>Disabled</button>
      <button data-testid="hidden-label" style="width:100px;height:30px"><span style="display:none">Hidden text</span></button>
      <button data-testid="duplicate">One</button><button data-testid="duplicate">Two</button>
      <button data-testid="dialog" onclick="this.textContent=confirm('Confirm fixture?')?'Accepted':'Dismissed'">Dialog</button>
      <input data-testid="upload" type="file"><p data-testid="file-name" id="fileName"></p>
      <script>document.querySelector('[data-testid=upload]').onchange=e=>fileName.textContent=e.target.files[0].name</script>
      <div id="shadow"></div><script>const root=shadow.attachShadow({mode:'open'});root.innerHTML='<button data-testid="shadow-button">Shadow</button>';root.querySelector('button').onclick=e=>e.target.textContent='Shadow clicked'</script>
      <iframe src="http://localhost:${port}/frame"></iframe>
      <button data-testid="popup" onclick="window.open('/next')">New page</button>`);
  });
  await new Promise(resolve => server.listen(0, resolve));
  port = server.address().port;
  try {
    const opened = await host.run({ operation: 'open', browser, url: `http://127.0.0.1:${port}/` });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const identity = { sessionId: opened.sessionId, runtimeEpoch: opened.runtimeEpoch, targetId: opened.targetId };
    proof.browser = opened;
    const observe = () => host.run({ operation: 'observe', ...identity });
    let observation = await observe();
    assert.equal(observation.ok, true, JSON.stringify(observation));
    assert.equal(observation.documents.length, 2);
    const mainDocument = observation.documents.find(item => item.parentFrameId === null);
    const hiddenLabel = mainDocument.controls.find(item => item.testId === 'hidden-label');
    assert.equal(hiddenLabel.visible, true);
    assert.equal(hiddenLabel.text, '', 'Hidden DOM text must not replace empty rendered text');
    proof.checks.push('visible controls preserve empty rendered text without substituting hidden content');
    const frame = observation.documents.find(item => item.parentFrameId !== null);
    const document = { frameId: mainDocument.frameId, documentId: mainDocument.documentId };
    const action = async (type, value, extra = {}, settings = {}) => {
      const result = await host.run({ operation: 'act', ...identity, ...document,
        action: { type, selector: { by: 'testId', value }, ...extra }, ...settings });
      proof.actions.push(result);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.executionReceipt.settled, true);
      return result;
    };
    const waitText = async (value, text, selectedDocument = document) => {
      const result = await host.run({ operation: 'wait', ...identity, ...selectedDocument, selector: { by: 'testId', value }, text, timeoutMs: 5000 });
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    await action('fill', 'name', { text: '中文商品 123' });
    await action('check', 'enabled', { checked: true });
    await action('select', 'choice', { values: ['B'] });
    await action('click', 'save', {}, { actionId: 'save-once' });
    assert.equal((await action('click', 'save', {}, { actionId: 'save-once' })).replayed, true);
    await waitText('count', '1');
    proof.checks.push('browser fill/check/select and exactly one click under duplicate actionId');
    const conflict = await host.run({ operation: 'act', ...identity, ...document, actionId: 'save-once',
      action: { type: 'doubleClick', selector: { by: 'testId', value: 'save' } } });
    assert.equal(conflict.error, 'idempotency_conflict');
    const ambiguous = await host.run({ operation: 'act', ...identity, ...document,
      action: { type: 'click', selector: { by: 'testId', value: 'duplicate' } } });
    assert.equal(ambiguous.error, 'ambiguous_target');
    assert.equal(ambiguous.dispatched, false);
    const selectorChain = await host.run({ operation: 'act', ...identity, ...document,
      action: { type: 'click', selector: { by: 'css', value: `body >> aabdocument=bind:${document.documentId} >> button` } } });
    assert.equal(selectorChain.error, 'executor_selector_invalid');
    assert.equal(selectorChain.dispatched, false);
    const css = await host.run({ operation: 'wait', ...identity, ...document,
      selector: { by: 'css', value: '[data-testid="count"]' }, text: '1' });
    assert.equal(css.ok, true);
    const cancelled = await runExecution({ timeoutMs: 150, mutation: true }, () => host.run({ operation: 'act', ...identity, ...document,
      actionId: 'cancel-disabled', action: { type: 'click', selector: { by: 'testId', value: 'disabled' } }, timeoutMs: 20000 }));
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.executionReceipt.settled, true);
    await action('click', 'save');
    await waitText('count', '2');
    proof.checks.push('conflicting identity and nonunique selector reject; cancellation settles before reuse');
    await action('click', 'dialog', {}, { dialog: { action: 'accept' } });
    await waitText('dialog', 'Accepted');
    await action('click', 'shadow-button');
    await waitText('shadow-button', 'Shadow clicked');
    const inFrame = await host.run({ operation: 'act', ...identity, frameId: frame.frameId, documentId: frame.documentId,
      action: { type: 'click', selector: { by: 'testId', value: 'frame-button' } } });
    assert.equal(inFrame.ok, true, JSON.stringify(inFrame));
    await waitText('frame-button', 'H5 clicked', { frameId: frame.frameId, documentId: frame.documentId });
    const upload = path.join(directory, 'fixture-upload.txt'); fs.writeFileSync(upload, 'executor fixture\n');
    await action('upload', 'upload', { files: [upload] });
    await waitText('file-name', 'fixture-upload.txt');
    proof.checks.push('explicit dialog acceptance, open shadow DOM, cross origin iframe, file upload');
    observation = await observe();
    assert.equal(observation.documents[0].controls.find(item => item.testId === 'name').value, '中文商品 123');
    fs.writeFileSync(path.join(directory, `playwright-${browser}-observation.json`), JSON.stringify(observation, null, 2));
    const outFile = path.join(directory, `playwright-${Date.now()}.png`);
    const screenshot = await host.run({ operation: 'screenshot', ...identity, outFile, fullPage: true });
    assert.equal(screenshot.ok, true, JSON.stringify(screenshot)); proof.screenshot = screenshot;
    await action('click', 'popup');
    observation = await observe();
    assert.equal(observation.pages.length, 2);
    const popupIdentity = { ...identity, targetId: observation.pages.find(item => item.targetId !== identity.targetId).targetId };
    const popupObservation = await host.run({ operation: 'observe', ...popupIdentity });
    assert.equal(popupObservation.title, 'Next document');
    const popupDocument = { frameId: popupObservation.documents[0].frameId, documentId: popupObservation.documents[0].documentId };
    const popupConflict = await host.run({ operation: 'act', ...popupIdentity, ...popupDocument, actionId: 'save-once',
      action: { type: 'click', selector: { by: 'testId', value: 'save' } } });
    assert.equal(popupConflict.error, 'executor_receipt_identity_mismatch');
    assert.equal(popupConflict.dispatched, false);
    const popupCount = await host.run({ operation: 'wait', ...popupIdentity, ...popupDocument,
      selector: { by: 'testId', value: 'count' }, text: '0' });
    assert.equal(popupCount.ok, true, JSON.stringify(popupCount));
    proof.popupConflict = popupConflict;
    proof.checks.push('actionId conflicts across popup pages in one session without a second click');
    const navigated = await host.run({ operation: 'navigate', ...identity, ...document, url: `http://127.0.0.1:${port}/next` });
    assert.equal(navigated.ok, true, JSON.stringify(navigated));
    const stale = await host.run({ operation: 'act', ...identity, ...document, action: { type: 'click', selector: { by: 'testId', value: 'save' } } });
    assert.equal(stale.error, 'reobserve_required');
    assert.equal(stale.dispatched, false);
    const events = await host.run({ operation: 'events', ...identity });
    assert.ok(events.items.some(item => item.type === 'dialog' && item.disposition === 'accept'));
    assert.equal((await host.run({ operation: 'close', ...identity })).ok, true);
    const receipt = await host.run({ operation: 'receipt', ...identity, actionId: 'save-once' });
    assert.equal(receipt.receipt.result.ok, true);
    proof.checks.push('popup discovery, navigation invalidates references, events and retained receipts after close');
    const race = await host.run({ operation: 'open', browser, url: `http://127.0.0.1:${port}/race` });
    const raceIdentity = { sessionId: race.sessionId, runtimeEpoch: race.runtimeEpoch, targetId: race.targetId };
    const raceObservation = await host.run({ operation: 'observe', ...raceIdentity });
    const raceDocument = raceObservation.documents[0];
    assert.ok(raceSignal);
    const trigger = setTimeout(() => raceSignal.end('data: navigate\n\n'), 700);
    let raceResult;
    try {
      raceResult = await host.run({ operation: 'act', ...raceIdentity, frameId: raceDocument.frameId, documentId: raceDocument.documentId,
        action: { type: 'click', selector: { by: 'testId', value: 'race-button' } }, timeoutMs: 1500 });
    } finally { clearTimeout(trigger); }
    assert.equal(raceResult.ok, false, JSON.stringify(raceResult));
    assert.equal(raceResult.dispatched, true);
    assert.equal(raceResult.executionReceipt.settled, true);
    assert.equal(raceClicks, 0, 'A waiting locator must never click the matching button in a replacement document');
    const nextObservation = await host.run({ operation: 'observe', ...raceIdentity });
    assert.match(nextObservation.url, /\/race-next$/);
    assert.notEqual(nextObservation.documents[0].documentId, raceDocument.documentId);
    await host.run({ operation: 'close', ...raceIdentity });
    proof.navigationRace = raceResult;
    proof.checks.push('A navigation during a waiting action cannot retarget the replacement document');
    proof.ok = true;
  } finally {
    await host.close();
    raceSignal?.end();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(directory, evidenceName), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: true, checks: proof.checks, evidence: path.join(directory, evidenceName) }) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
