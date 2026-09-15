'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { ReceiptJournal } = require('./receipt-journal');
const { atomicJson } = require('./managed-runtime');

const protocol = 'aab.playwright-worker/v1';
const packageDirectory = process.argv[2];
const sessionDirectory = process.argv[3];
const identity = { sessionId: process.argv[4], runtimeEpoch: process.argv[5] };
const playwright = createRequire(path.join(packageDirectory, 'package.json'))('playwright');
const pages = new Map();
const frames = new Map();
const journals = new Map();
const events = [];
let eventSequence = 0;
let eventBytes = 0;
let browser;
let browserContext;
let closing = false;
let active;
let tail = Promise.resolve();
const requests = new Map();

function failure(code, message, details) { return Object.assign(new Error(message), { code, details }); }
function emitEvent(type, data) {
  const event = { sequence: ++eventSequence, observedAtMs: Date.now(), type, ...data };
  const bytes = Buffer.byteLength(JSON.stringify(event));
  events.push({ event, bytes }); eventBytes += bytes;
  while (events.length > 1000 || eventBytes > 1024 * 1024) eventBytes -= events.shift().bytes;
}
function bindFrame(frame, targetId) {
  let entry = frames.get(frame);
  if (!entry) { entry = { frameId: randomUUID(), documentId: randomUUID(), targetId, frame }; frames.set(frame, entry); }
  return entry;
}
function bindPage(page) {
  if (pages.size >= 64) {
    emitEvent('page-capacity', { maximum: 64 });
    void page.close().catch(error => emitEvent('page-close-error', { message: error.message }));
    return null;
  }
  const targetId = randomUUID();
  pages.set(targetId, page);
  for (const frame of page.frames()) bindFrame(frame, targetId);
  page.on('frameattached', frame => bindFrame(frame, targetId));
  page.on('framenavigated', frame => { bindFrame(frame, targetId).documentId = randomUUID(); });
  page.on('framedetached', frame => frames.delete(frame));
  page.on('close', () => { pages.delete(targetId); emitEvent('page-closed', { targetId }); for (const [frame, entry] of frames) if (entry.targetId === targetId) frames.delete(frame); });
  page.on('console', message => emitEvent('console', { targetId, level: message.type(), text: message.text().slice(0, 8192) }));
  page.on('pageerror', error => emitEvent('page-error', { targetId, message: error.message.slice(0, 8192) }));
  page.on('requestfailed', request => emitEvent('request-failed', { targetId, url: request.url().slice(0, 8192), method: request.method(), failure: request.failure()?.errorText }));
  page.on('response', response => emitEvent('response', { targetId, url: response.url().slice(0, 8192), status: response.status() }));
  page.on('dialog', async dialog => {
    const policy = active?.args.targetId === targetId ? active.args.dialog : null;
    emitEvent('dialog', { targetId, dialogType: dialog.type(), message: dialog.message().slice(0, 8192), disposition: policy?.action || 'dismiss' });
    try { if (policy?.action === 'accept') await dialog.accept(policy.promptText); else await dialog.dismiss(); }
    catch (error) { emitEvent('dialog-error', { targetId, message: error.message.slice(0, 8192) }); }
  });
  emitEvent('page-opened', { targetId });
  return targetId;
}
function pageFor(args) {
  if (args.sessionId !== identity.sessionId || args.runtimeEpoch !== identity.runtimeEpoch) throw failure('executor_session_mismatch', 'Executor session identity changed.');
  const page = pages.get(args.targetId);
  if (!page || page.isClosed()) throw failure('executor_target_closed', 'The selected browser page is not open.');
  return page;
}
function documentFor(args) {
  pageFor(args);
  const entry = [...frames.values()].find(value => value.frameId === args.frameId && value.targetId === args.targetId);
  if (!entry || entry.frame.isDetached() || entry.documentId !== args.documentId) throw failure('reobserve_required', 'The selected frame/document changed; observe again.');
  return entry;
}
async function locate(frame, selector, documentId) {
  // The isolated selector world remembers the document bound by observe().
  // Locator retries stay inside it; a new document can never acquire an old ID.
  const root = frame.locator(`aabdocument=match:${documentId}`);
  switch (selector.by) {
    case 'role': return root.getByRole(selector.value, { name: selector.name, exact: true });
    case 'testId': return root.getByTestId(selector.value);
    case 'text': return root.getByText(selector.value, { exact: true });
    case 'label': return root.getByLabel(selector.value, { exact: true });
    case 'placeholder': return root.getByPlaceholder(selector.value, { exact: true });
    case 'css': {
      // Accept CSS syntax only. Playwright's selector chains could otherwise
      // escape the observed document through an internal selector engine.
      const valid = await frame.evaluate(value => {
        try { document.querySelectorAll(value); return true; } catch { return false; }
      }, selector.value);
      if (!valid) throw failure('executor_selector_invalid', 'The css selector must use standard CSS syntax.');
      return root.locator(`css=${selector.value}`);
    }
    default: throw failure('executor_selector_unsupported', 'Unknown selector kind.');
  }
}
async function unique(frame, selector, documentId) {
  const locator = await locate(frame, selector, documentId);
  const count = await locator.count();
  if (count !== 1) throw failure(count === 0 ? 'target_not_found' : 'ambiguous_target', 'Executor selectors must match exactly one element.', { matches: count });
  return locator;
}
function assertDocument(entry, documentId) {
  if (entry.documentId !== documentId || entry.frame.isDetached()) throw failure('reobserve_required', 'The selected document changed during preparation.');
}
function journalFor(targetId) {
  let journal = journals.get(targetId);
  if (!journal) { journal = new ReceiptJournal(path.join(sessionDirectory, 'receipts'), { ...identity, targetId }); journals.set(targetId, journal); }
  return journal;
}

async function observe(args, options) {
  const page = pageFor(args);
  const documents = [];
  const pageFrames = page.frames();
  if (pageFrames.length > 64) throw failure('executor_frame_limit', 'This document exceeds the 64-frame observation limit.');
  for (const frame of pageFrames) {
    const entry = bindFrame(frame, args.targetId);
    const documentId = entry.documentId;
    await frame.locator(`aabdocument=bind:${documentId}`).count();
    const snapshot = await frame.locator('body').ariaSnapshotJSON({ ...options, depth: 30 });
    const controls = await frame.locator('input,textarea,select,button,a[href],[contenteditable="true"],[role],[data-testid]').evaluateAll((elements, limit) => elements.slice(0, limit).map(element => ({
      tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), testId: element.getAttribute('data-testid'),
      id: element.id || null, text: typeof element.innerText === 'string' ? element.innerText.slice(0, 512) : null,
      label: element.getAttribute('aria-label'), placeholder: element.getAttribute('placeholder'),
      value: element.matches('input[type="password"]') ? null : ('value' in element ? String(element.value).slice(0, 4096) : null),
      disabled: 'disabled' in element ? element.disabled : element.getAttribute('aria-disabled') === 'true',
      visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    })), args.maxControls ?? 200);
    assertDocument(entry, documentId);
    documents.push({ frameId: entry.frameId, documentId, parentFrameId: frame.parentFrame() ? bindFrame(frame.parentFrame(), args.targetId).frameId : null,
      url: frame.url(), name: frame.name(), snapshot, controls });
  }
  const result = { ok: true, ...identity, targetId: args.targetId, url: page.url(), title: await page.title(),
    documents, pages: [...pages].filter(([, item]) => !item.isClosed()).map(([targetId, item]) => ({ targetId, url: item.url() })),
    scope: 'browser-dom', engine: 'playwright', observedAtMs: Date.now() };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw failure('executor_observation_too_large', 'Browser observation exceeds 4 MiB.');
  return result;
}

async function mutate(args, options) {
  const actionId = args.actionId;
  const journal = journalFor(args.targetId);
  const begun = journal.begin(actionId, { operation: args.operation, targetId: args.targetId, frameId: args.frameId, documentId: args.documentId,
    ...(args.action ? { action: args.action } : {}), ...(args.url ? { url: args.url } : {}), ...(args.dialog ? { dialog: args.dialog } : {}) });
  if (!begun.fresh) {
    if (begun.receipt.phase === 'completed') return { ...begun.receipt.result, replayed: true, executionReceipt: begun.receipt };
    throw failure('executor_action_unresolved', 'This action was already started. Query its original receipt; do not replay it.');
  }
  let dispatched = false;
  let result;
  const startedAtMs = Date.now();
  try {
    const entry = documentFor(args);
    if (args.operation === 'navigate') {
      const page = pageFor(args);
      if (entry.frame !== page.mainFrame()) throw failure('executor_navigation_scope', 'Navigation requires the observed main document.');
      dispatched = true;
      await page.goto(args.url, { ...options, waitUntil: 'domcontentloaded' });
    } else {
      const action = args.action;
      const locator = await unique(entry.frame, action.selector, args.documentId);
      const destination = action.type === 'drag' ? await unique(entry.frame, action.destination, args.documentId) : null;
      assertDocument(entry, args.documentId);
      if (options.signal.aborted) throw failure('executor_cancelled', 'Executor action was cancelled before dispatch.');
      dispatched = true;
      switch (action.type) {
        case 'click': await locator.click(options); break;
        case 'doubleClick': await locator.dblclick(options); break;
        case 'hover': await locator.hover(options); break;
        case 'fill': await locator.fill(action.text, options); break;
        case 'type': await locator.pressSequentially(action.text, options); break;
        case 'press': await locator.press(action.text, options); break;
        case 'check': await locator.setChecked(action.checked, options); break;
        case 'select': await locator.selectOption(action.values, options); break;
        case 'scrollIntoView': await locator.scrollIntoViewIfNeeded(options); break;
        case 'drag': await locator.dragTo(destination, options); break;
        case 'upload': await locator.setInputFiles(action.files, options); break;
        default: throw failure('executor_action_unsupported', 'Unknown browser action.');
      }
      if (action.type === 'fill') {
        const value = await locator.evaluate(element => element.isContentEditable ? element.innerText : element.value);
        if (value !== action.text) throw failure('executor_postcondition_failed', 'The editor did not retain the requested value.', { observedValue: value });
      }
    }
    result = { ok: true, ...identity, targetId: args.targetId, actionId, dispatched: true, ambiguous: false,
      mechanism: args.operation === 'navigate' ? 'browser-navigation' : `playwright-${args.action.type}` };
  } catch (error) {
    result = { ok: false, ...identity, targetId: args.targetId, actionId, error: error.code || 'executor_action_failed',
      message: error.message, details: error.details, dispatched, ambiguous: dispatched };
  }
  result.timings = { executionMs: Date.now() - startedAtMs };
  let receipt;
  try { receipt = journal.finish(begun.receipt, result); }
  catch (error) { error.dispatched = dispatched; error.ambiguous = dispatched; throw error; }
  return { ...result, executionReceipt: receipt };
}

async function handle(args, controller) {
  const options = { timeout: args.timeoutMs ?? 30000, signal: controller.signal };
  if (args.operation === 'open') {
    if (browser) throw failure('executor_already_open', 'Worker already owns a browser.');
    await playwright.selectors.register('aabdocument', () => {
      const identities = new WeakMap();
      const query = (root, selector) => {
        const document = root.nodeType === 9 ? root : root.ownerDocument;
        const separator = selector.indexOf(':');
        const operation = selector.slice(0, separator), id = selector.slice(separator + 1);
        if (operation === 'bind') identities.set(document, id);
        return identities.get(document) === id ? document.documentElement : null;
      };
      return { query, queryAll: (root, selector) => { const element = query(root, selector); return element ? [element] : []; } };
    }, { contentScript: true });
    browser = await playwright[args.browser || 'chromium'].launch({ headless: args.headless ?? true, timeout: options.timeout });
    if (controller.signal.aborted) { await browser.close(); throw failure('executor_cancelled', 'Browser preparation was cancelled.'); }
    browserContext = await browser.newContext({ viewport: args.viewport || { width: 1280, height: 900 } });
    browserContext.on('page', bindPage);
    const page = await browserContext.newPage();
    const targetId = [...pages].find(([, item]) => item === page)[0];
    await page.goto(args.url, { ...options, waitUntil: 'domcontentloaded' });
    const descriptor = { schemaVersion: protocol, ...identity, targetId, engine: 'playwright', version: browser.version(),
      browser: args.browser || 'chromium', openedAtMs: Date.now(), state: 'open' };
    atomicJson(path.join(sessionDirectory, 'session.json'), descriptor);
    return { ok: true, ...descriptor, capabilities: ['observe', 'act', 'navigate', 'wait', 'screenshot', 'events', 'receipt', 'close'],
      limitations: ['closed-shadow-root', 'native-operating-system-ui'], dialogDefault: 'dismiss' };
  }
  if (args.operation === 'observe') return observe(args, options);
  if (args.operation === 'act' || args.operation === 'navigate') return mutate(args, options);
  if (args.operation === 'wait') {
    const entry = documentFor(args), locator = await locate(entry.frame, args.selector, args.documentId);
    await locator.waitFor({ ...options, state: args.state || 'visible' });
    if (args.text !== undefined) {
      const deadline = Date.now() + options.timeout;
      while (await locator.textContent(options) !== args.text) {
        assertDocument(entry, args.documentId);
        if (controller.signal.aborted || Date.now() >= deadline) throw failure('executor_wait_timeout', 'Expected text was not observed.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assertDocument(entry, args.documentId);
    return { ok: true, ...identity, targetId: args.targetId, condition: 'matched', observedAtMs: Date.now() };
  }
  if (args.operation === 'screenshot') {
    const page = pageFor(args);
    const bytes = await page.screenshot({ ...options, fullPage: args.fullPage ?? false, type: 'png' });
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, bytes, { flag: 'wx', mode: 0o600 });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { ok: true, ...identity, targetId: args.targetId, outFile: args.outFile, artifact: { sha256, bytes: bytes.length },
      refs: [{ stream: 'screenshot', screenshotId: args.outFile, sha256 }] };
  }
  if (args.operation === 'events') {
    pageFor(args);
    const after = args.afterSequence ?? 0;
    const selected = events.filter(({ event }) => event.sequence > after).slice(0, args.limit ?? 100);
    return { ok: true, ...identity, items: selected.map(({ event }) => event),
      nextSequence: selected.at(-1)?.event.sequence ?? after, throughSequence: eventSequence,
      gap: events.length > 0 && after < events[0].event.sequence - 1 };
  }
  if (args.operation === 'close') { pageFor(args); await shutdown(); return { ok: true, ...identity, closed: true }; }
  throw failure('executor_operation_unsupported', 'Unknown worker operation.');
}

let shutdownPromise;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  active?.controller.abort();
  shutdownPromise = (async () => {
    await browser?.close();
    atomicJson(path.join(sessionDirectory, 'closed.json'), { ...identity, closedAtMs: Date.now() });
  })();
  return shutdownPromise;
}

process.on('message', message => {
  if (message?.protocol !== protocol) return;
  if (message.type === 'cancel') { requests.get(message.id)?.controller.abort(); return; }
  if (message.type !== 'request') return;
  const controller = new AbortController();
  const request = { id: message.id, controller, args: message.args };
  requests.set(message.id, request);
  const deadline = Date.now() + (message.args.timeoutMs ?? 30000);
  const timer = setTimeout(() => controller.abort(), message.args.timeoutMs ?? 30000);
  tail = tail.then(async () => {
    active = request;
    try {
      if (closing) throw failure('executor_closed', 'Executor worker is closing.');
      if (controller.signal.aborted || Date.now() >= deadline) throw failure('executor_cancelled', 'Executor request was cancelled while queued.');
      const result = await handle({ ...message.args, timeoutMs: Math.max(1, deadline - Date.now()) }, controller);
      if (process.connected) process.send({ protocol, id: message.id, result });
      if (message.args.operation === 'close') process.disconnect();
    } catch (error) {
      const dispatched = error.dispatched ?? (message.args.operation === 'open' && Boolean(browser));
      if (process.connected) process.send({ protocol, id: message.id, result: { ok: false, error: error.code || 'executor_failed', message: error.message,
        details: error.details, dispatched, ambiguous: error.ambiguous ?? dispatched } });
    } finally { clearTimeout(timer); requests.delete(message.id); active = null; }
  }).catch(async error => {
    if (process.connected) process.send({ protocol, id: message.id, result: { ok: false, error: error.code || 'executor_failed', message: error.message } });
  });
});
process.on('disconnect', () => { shutdown().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.send({ protocol, type: 'ready', ...identity });
