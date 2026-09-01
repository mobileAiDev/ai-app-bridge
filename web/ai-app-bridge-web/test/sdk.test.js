const assert = require('assert/strict');
const test = require('node:test');

const { createAiAppBridge, snapshotDom } = require('../src/index.js');

function fakeElement(overrides = {}) {
  const attrs = overrides.attrs || {};
  return {
    tagName: overrides.tagName || 'BUTTON',
    id: overrides.id || '',
    innerText: overrides.innerText || '',
    value: overrides.value || '',
    title: overrides.title || '',
    disabled: Boolean(overrides.disabled),
    href: overrides.href || '',
    getAttribute(name) {
      return attrs[name] || '';
    },
    getBoundingClientRect() {
      return {
        left: 10,
        top: 20,
        right: 110,
        bottom: 60,
        width: 100,
        height: 40,
      };
    },
  };
}

function fakeEventTarget(properties = {}) {
  const listeners = new Map();
  return Object.assign(properties, {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      listeners.set(type, entries.filter((entry) => entry !== listener));
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) {
        listener({ type, ...event });
      }
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  });
}

function createFakeWebSocket() {
  return class FakeWebSocket {
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    open() {
      this.readyState = 1;
      this.onopen && this.onopen();
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.readyState = 3;
      this.onclose && this.onclose();
    }
  };
}

function createFakeMutationObserver() {
  return class FakeMutationObserver {
    static instances = [];

    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      FakeMutationObserver.instances.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    emit(records) {
      this.callback(records, this);
    }

    disconnect() {
      this.disconnected = true;
    }
  };
}

function wait(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventCaptures(socket) {
  return socket.sent.filter((message) => message.type === 'capture' && message.stream === 'events');
}

function setFakeLocation(location, href) {
  const parsed = new URL(href, location.href);
  location.href = parsed.href;
  location.origin = parsed.origin;
  location.pathname = parsed.pathname;
  location.search = parsed.search;
  location.hash = parsed.hash;
}

test('snapshotDom shapes controls from a supplied document', () => {
  const button = fakeElement({
    id: 'save',
    innerText: 'Save changes',
    attrs: { role: 'button', 'aria-label': 'Save' },
  });
  const input = fakeElement({
    tagName: 'INPUT',
    id: 'email',
    value: 'agent@example.test',
    attrs: { name: 'email', type: 'email', placeholder: 'Email' },
  });
  const password = fakeElement({
    tagName: 'INPUT',
    id: 'password',
    value: 'snapshot-secret-marker',
    attrs: { name: 'password', type: 'password', placeholder: 'Password' },
  });
  const document = {
    title: 'Bridge Demo',
    readyState: 'complete',
    body: { innerText: 'Save changes Email' },
    querySelectorAll(selector) {
      assert.equal(selector, 'button,input');
      return [button, input, password];
    },
  };

  const dom = snapshotDom({ document, selector: 'button,input' });

  assert.equal(dom.ok, true);
  assert.equal(dom.title, 'Bridge Demo');
  assert.equal(dom.readyState, 'complete');
  assert.equal(dom.controlCount, 3);
  assert.deepEqual(dom.controls.map((control) => control.id), ['save', 'email', 'password']);
  assert.equal(dom.controls[0].text, 'Save changes');
  assert.equal(dom.controls[0].bounds.width, 100);
  assert.equal(dom.controls[1].name, 'email');
  assert.equal(dom.controls[1].type, 'email');
  assert.equal(dom.controls[2].sensitive, true);
  assert.equal(dom.controls[2].valueLength, 22);
  assert.equal(JSON.stringify(dom).includes('snapshot-secret-marker'), false);
});

test('password input command returns only length metadata', async (t) => {
  const password = fakeElement({
    tagName: 'INPUT',
    id: 'password',
    attrs: { name: 'password', type: 'password' },
  });
  password.focus = () => {};
  password.dispatchEvent = () => {};
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  globalThis.document = {
    title: 'Sensitive Input',
    querySelector(selector) {
      return selector === '#password' ? password : null;
    },
  };
  globalThis.window = { Event: class FakeEvent {} };
  globalThis.location = {
    href: 'https://example.test/login',
    origin: 'https://example.test',
    pathname: '/login',
    search: '',
    hash: '',
  };
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.location = originalLocation;
  });
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'privacy-command',
    reconnect: false,
    WebSocket,
  });
  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  await socket.onmessage({
    data: JSON.stringify({
      type: 'command',
      commandId: 'input-1',
      command: {
        name: 'input',
        args: { selector: '#password', value: 'command-secret-marker' },
      },
    }),
  });
  await wait(0);

  const commandResult = socket.sent.find((message) => message.type === 'commandResult');
  assert.equal(commandResult.ok, true);
  assert.equal(commandResult.result.sensitive, true);
  assert.equal(commandResult.result.valueLength, 21);
  assert.equal(commandResult.result.value, undefined);
  assert.equal(JSON.stringify(commandResult).includes('command-secret-marker'), false);
  bridge.stop();
});

test('click command returns the component that received the click', async (t) => {
  const button = fakeElement({
    id: 'save-order',
    innerText: 'Save order',
    attrs: { role: 'button', 'aria-label': 'Save order' },
  });
  let clickCount = 0;
  button.click = () => { clickCount += 1; };
  const originalDocument = globalThis.document;
  const originalLocation = globalThis.location;
  globalThis.document = {
    title: 'Order',
    querySelector(selector) {
      return selector === '#save-order' ? button : null;
    },
  };
  globalThis.location = {
    href: 'https://example.test/order',
    origin: 'https://example.test',
    pathname: '/order',
    search: '',
    hash: '',
  };
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.location = originalLocation;
  });
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'click-target-test',
    reconnect: false,
    WebSocket,
  });
  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  await socket.onmessage({
    data: JSON.stringify({
      type: 'command',
      commandId: 'click-1',
      command: { name: 'click', args: { selector: '#save-order' } },
    }),
  });
  await wait(0);

  const commandResult = socket.sent.find((message) => message.type === 'commandResult');
  assert.equal(commandResult.ok, true);
  assert.equal(clickCount, 1);
  assert.equal(commandResult.result.target.id, 'save-order');
  assert.equal(commandResult.result.target.role, 'button');
  assert.equal(commandResult.result.target.bounds.width, 100);
  bridge.stop();
});

test('createAiAppBridge exposes a stable session API before connection', () => {
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    token: 'test-token',
    sessionId: 'test-session',
    reconnect: false,
  });

  assert.equal(typeof bridge.start, 'function');
  assert.equal(typeof bridge.recordLog, 'function');
  assert.equal(bridge.sessionId(), 'test-session');
  assert.equal(bridge.isConnected(), false);
});

test('recordNetwork reports redaction truthfully', () => {
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'network-redaction-test',
    reconnect: false,
    WebSocket,
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  bridge.recordNetwork({
    method: 'POST',
    url: 'https://example.test/orders',
    requestBody: '{"orderId":42}',
  });
  bridge.recordNetwork({
    method: 'POST',
    url: 'https://example.test/sanitized',
    requestBody: '[REDACTED]',
    redacted: true,
  });

  const captures = socket.sent.filter((message) => (
    message.type === 'capture' && message.stream === 'network'
  ));
  assert.equal(captures.length, 2);
  assert.equal(captures[0].item.redacted, false);
  assert.equal(captures[1].item.redacted, true);
  bridge.stop();
});

test('capture.ui emits batched clicks and redacts password input', async () => {
  const button = fakeElement({ id: 'save', innerText: 'Save changes' });
  const password = fakeElement({
    tagName: 'INPUT',
    id: 'password',
    value: 'secret-123',
    attrs: { name: 'password', type: 'password' },
  });
  const cardNumber = fakeElement({
    tagName: 'INPUT',
    id: 'payment-card',
    value: '4111111111111111',
    attrs: { name: 'paymentCard', type: 'text', autocomplete: 'cc-number' },
  });
  const document = fakeEventTarget({
    title: 'Settings',
    readyState: 'complete',
    body: { innerText: 'Save changes' },
    documentElement: {},
    querySelectorAll() {
      return [button, password, cardNumber];
    },
  });
  const window = fakeEventTarget({
    location: {
      href: 'https://example.test/settings',
      origin: 'https://example.test',
      pathname: '/settings',
      search: '',
      hash: '',
    },
  });
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: { document, window, debounceMs: 1 },
    },
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  document.dispatch('click', { target: button });
  document.dispatch('input', { target: password });
  document.dispatch('input', { target: cardNumber });
  await wait();

  const captures = eventCaptures(socket);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].item.category, 'ui');
  assert.equal(captures[0].item.name, 'batch');
  assert.deepEqual(captures[0].item.data.events.map((event) => event.type), [
    'interaction.click',
    'interaction.input',
    'interaction.input',
  ]);
  assert.equal(captures[0].item.data.events[0].target.id, 'save');
  assert.equal(captures[0].item.data.events[1].sensitive, true);
  assert.equal(captures[0].item.data.events[1].changed, true);
  assert.equal(captures[0].item.data.events[1].length, 10);
  assert.equal('value' in captures[0].item.data.events[1], false);
  assert.equal(captures[0].item.data.events[2].sensitive, false);
  assert.equal(captures[0].item.data.events[2].length, 16);
  assert.equal(captures[0].item.data.events[2].value, '4111111111111111');

  bridge.stop();
});

test('capture.ui observes focus and change without exposing sensitive values', async () => {
  const password = fakeElement({
    tagName: 'INPUT',
    id: 'account-secret',
    value: 'top-secret',
    attrs: { name: 'accountSecret', type: 'text', autocomplete: 'current-password' },
  });
  const document = fakeEventTarget({
    title: 'Sign in',
    readyState: 'complete',
    body: { innerText: 'Sign in' },
    documentElement: {},
    querySelectorAll() {
      return [password];
    },
  });
  const window = fakeEventTarget({
    location: {
      href: 'https://example.test/sign-in',
      origin: 'https://example.test',
      pathname: '/sign-in',
      search: '',
      hash: '',
    },
  });
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-focus-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: { document, window, debounceMs: 1 },
    },
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  document.dispatch('focus', { target: password });
  document.dispatch('change', { target: password });
  await wait();

  const events = eventCaptures(socket)[0].item.data.events;
  const batch = eventCaptures(socket)[0].item.data;
  assert.equal(batch.semanticChanged, false);
  assert.equal(batch.renderChanged, false);
  assert.equal(batch.interactionObserved, true);
  assert.deepEqual(events.map((event) => event.type), [
    'interaction.focus',
    'interaction.change',
  ]);
  assert.equal(events[0].target.id, 'account-secret');
  assert.equal(events[1].sensitive, true);
  assert.equal(events[1].changed, true);
  assert.equal(events[1].length, 10);
  assert.equal('value' in events[1], false);

  bridge.stop();
});

test('capture.ui records SPA history and browser route transitions', async () => {
  const document = fakeEventTarget({
    title: 'Store',
    readyState: 'complete',
    body: { innerText: 'Store' },
    documentElement: {},
    querySelectorAll() {
      return [];
    },
  });
  const location = {
    href: 'https://example.test/home',
    origin: 'https://example.test',
    pathname: '/home',
    search: '',
    hash: '',
  };
  const history = {
    pushState(_state, _title, url) {
      setFakeLocation(location, url);
      return 'push-result';
    },
    replaceState(_state, _title, url) {
      setFakeLocation(location, url);
      return 'replace-result';
    },
  };
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  const window = fakeEventTarget({ location, history });
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-route-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: { document, window, debounceMs: 1 },
    },
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  assert.equal(history.pushState({}, '', '/orders'), 'push-result');
  assert.equal(history.replaceState({}, '', '?filter=open'), 'replace-result');
  setFakeLocation(location, '/profile');
  window.dispatch('popstate');
  setFakeLocation(location, '#details');
  window.dispatch('hashchange');
  await wait();

  const routeBatch = eventCaptures(socket)[0].item.data;
  const events = routeBatch.events;
  assert.equal(routeBatch.semanticChanged, true);
  assert.equal(routeBatch.renderChanged, false);
  assert.equal(routeBatch.interactionObserved, false);
  assert.deepEqual(events.map((event) => event.type), [
    'route.change',
    'route.change',
    'route.change',
    'route.change',
  ]);
  assert.deepEqual(events.map((event) => event.navigationType), [
    'pushState',
    'replaceState',
    'popstate',
    'hashchange',
  ]);
  assert.deepEqual(events.map((event) => [event.fromRoute, event.toRoute]), [
    ['/home', '/orders'],
    ['/orders', '/orders?filter=open'],
    ['/orders?filter=open', '/profile'],
    ['/profile', '/profile#details'],
  ]);

  bridge.stop();
  assert.equal(history.pushState, originalPushState);
  assert.equal(history.replaceState, originalReplaceState);
});

test('capture.ui summarizes DOM mutations and dialog-like transitions', async () => {
  const button = fakeElement({ id: 'delete', innerText: 'Delete item' });
  const dialog = fakeElement({
    tagName: 'DIALOG',
    id: 'confirm-delete',
    innerText: 'Confirm deletion',
    attrs: { role: 'dialog', 'aria-label': 'Confirm deletion' },
  });
  const dom = {
    elements: [button],
    dialogs: [],
  };
  const body = { innerText: 'Delete item' };
  const documentElement = {};
  const document = fakeEventTarget({
    title: 'Items',
    readyState: 'complete',
    body,
    documentElement,
    querySelectorAll(selector) {
      if (selector === '*') return dom.elements;
      if (selector.includes('dialog')) return dom.dialogs;
      return [button];
    },
  });
  const window = fakeEventTarget({
    location: {
      href: 'https://example.test/items',
      origin: 'https://example.test',
      pathname: '/items',
      search: '',
      hash: '',
    },
  });
  const MutationObserver = createFakeMutationObserver();
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-mutation-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: { document, window, MutationObserver, debounceMs: 1 },
    },
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  const observer = MutationObserver.instances[0];
  assert.equal(observer.target, documentElement);
  assert.deepEqual(observer.options, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  dom.elements = [button, dialog];
  dom.dialogs = [dialog];
  body.innerText = 'Delete item Confirm deletion';
  observer.emit([{ type: 'childList', addedNodes: [dialog], removedNodes: [] }]);
  dom.elements = [button];
  dom.dialogs = [];
  body.innerText = 'Delete item';
  observer.emit([{ type: 'childList', addedNodes: [], removedNodes: [dialog] }]);
  await wait();

  const dialogBatch = eventCaptures(socket)[0].item.data;
  const events = dialogBatch.events;
  assert.equal(dialogBatch.semanticChanged, true);
  assert.equal(dialogBatch.renderChanged, true);
  assert.equal(dialogBatch.interactionObserved, false);
  assert.deepEqual(events.map((event) => event.type), [
    'dom.mutation',
    'dialog.open',
    'dom.mutation',
    'dialog.close',
  ]);
  assert.equal(events[0].mutations.addedNodes, 1);
  assert.equal(events[0].mutations.removedNodes, 0);
  assert.equal(events[0].fingerprint.changed, true);
  assert.notEqual(events[0].fingerprint.beforeHash, events[0].fingerprint.afterHash);
  assert.equal(events[0].diff.elementCount, 1);
  assert.equal(events[0].diff.dialogCount, 1);
  assert.equal(events[1].dialog.id, 'confirm-delete');
  assert.equal(events[2].mutations.removedNodes, 1);
  assert.equal(events[2].diff.elementCount, -1);
  assert.equal(events[2].diff.dialogCount, -1);
  assert.equal(events[3].dialog.id, 'confirm-delete');

  bridge.stop();
  assert.equal(observer.disconnected, true);
});

test('capture.ui fingerprints visual-state attributes used by animations', async () => {
  const panelAttrs = { style: 'opacity: 0', 'aria-hidden': 'true' };
  const panel = fakeElement({
    tagName: 'SECTION',
    id: 'animated-panel',
    innerText: 'Panel',
    attrs: panelAttrs,
  });
  const document = fakeEventTarget({
    title: 'Animation',
    readyState: 'complete',
    body: { innerText: 'Panel' },
    documentElement: {},
    querySelectorAll(selector) {
      if (selector.includes('dialog')) return [];
      return [panel];
    },
  });
  const window = fakeEventTarget({
    location: {
      href: 'https://example.test/animation',
      origin: 'https://example.test',
      pathname: '/animation',
      search: '',
      hash: '',
    },
  });
  const MutationObserver = createFakeMutationObserver();
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-animation-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: { document, window, MutationObserver, debounceMs: 1 },
    },
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  panelAttrs.style = 'opacity: 1; transform: translateX(20px)';
  MutationObserver.instances[0].emit([
    { type: 'attributes', target: panel, attributeName: 'style' },
  ]);
  await wait();

  const batch = eventCaptures(socket)[0].item.data;
  const mutation = batch.events[0];
  assert.equal(mutation.type, 'dom.mutation');
  assert.equal(mutation.mutations.attributeChanges, 1);
  assert.deepEqual(mutation.mutations.attributeNames, ['style']);
  assert.equal(mutation.fingerprint.changed, true);
  assert.notEqual(mutation.fingerprint.beforeHash, mutation.fingerprint.afterHash);
  assert.match(mutation.fingerprint.beforeHash, /^ui-fp-/);
  assert.match(mutation.fingerprint.afterHash, /^ui-fp-/);
  assert.equal(batch.semanticChanged, false);
  assert.equal(batch.renderChanged, true);
  assert.equal(batch.interactionObserved, false);

  bridge.stop();
});

test('capture.ui observes dialogs toggled in place without node replacement', async () => {
  const dialog = fakeElement({
    tagName: 'DIALOG',
    id: 'preferences',
    innerText: 'Preferences',
    attrs: { role: 'dialog', 'aria-label': 'Preferences' },
  });
  dialog.open = false;
  const document = fakeEventTarget({
    title: 'Dialog toggle',
    readyState: 'complete',
    body: { innerText: 'Preferences' },
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === '*') return [dialog];
      if (selector.includes('dialog')) return [dialog];
      return [dialog];
    },
  });
  const window = fakeEventTarget({
    location: {
      href: 'https://example.test/preferences',
      origin: 'https://example.test',
      pathname: '/preferences',
      search: '',
      hash: '',
    },
  });
  const MutationObserver = createFakeMutationObserver();
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-dialog-toggle-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: { document, window, MutationObserver, debounceMs: 1 },
    },
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  const observer = MutationObserver.instances[0];
  dialog.open = true;
  observer.emit([{ type: 'attributes', target: dialog, attributeName: 'open' }]);
  dialog.open = false;
  observer.emit([{ type: 'attributes', target: dialog, attributeName: 'open' }]);
  await wait();

  const events = eventCaptures(socket)[0].item.data.events;
  assert.deepEqual(events.map((event) => event.type), [
    'dom.mutation',
    'dialog.open',
    'dom.mutation',
    'dialog.close',
  ]);
  assert.equal(events[1].dialog.id, 'preferences');
  assert.equal(events[3].dialog.id, 'preferences');

  bridge.stop();
});

test('capture.ui bounds pending events and emits size-limited batches', async () => {
  const buttons = Array.from({ length: 5 }, (_, index) => fakeElement({
    id: `button-${index}`,
    innerText: `Button ${index}`,
  }));
  const document = fakeEventTarget({
    title: 'Busy page',
    readyState: 'complete',
    body: { innerText: 'Buttons' },
    documentElement: {},
    querySelectorAll(selector) {
      return selector === '*' ? buttons : buttons;
    },
  });
  const window = fakeEventTarget({
    location: {
      href: 'https://example.test/busy',
      origin: 'https://example.test',
      pathname: '/busy',
      search: '',
      hash: '',
    },
  });
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-backpressure-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: {
        document,
        window,
        debounceMs: 5,
        maxBatchSize: 2,
        maxPendingEvents: 3,
      },
    },
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  for (const button of buttons) document.dispatch('click', { target: button });
  await wait(40);

  const captures = eventCaptures(socket);
  assert.equal(captures.length, 2);
  assert.equal(captures.every((capture) => capture.item.data.batchSize <= 2), true);
  assert.equal(captures.reduce((total, capture) => total + capture.item.data.droppedEvents, 0), 2);
  assert.deepEqual(captures.flatMap((capture) => (
    capture.item.data.events.map((event) => event.target.id)
  )), ['button-2', 'button-3', 'button-4']);

  bridge.stop();
});

test('capture.ui installs once, flushes on stop, and cleanly restarts', () => {
  const button = fakeElement({ id: 'save', innerText: 'Save' });
  const document = fakeEventTarget({
    title: 'Lifecycle',
    readyState: 'complete',
    body: { innerText: 'Save' },
    documentElement: {},
    querySelectorAll() {
      return [button];
    },
  });
  const window = fakeEventTarget({
    location: {
      href: 'https://example.test/lifecycle',
      origin: 'https://example.test',
      pathname: '/lifecycle',
      search: '',
      hash: '',
    },
  });
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'ui-lifecycle-test',
    reconnect: false,
    WebSocket,
    capture: {
      ui: { document, window, debounceMs: 1000 },
    },
  });

  bridge.start();
  bridge.start();
  assert.equal(WebSocket.instances.length, 1);
  assert.equal(document.listenerCount('click'), 1);
  const firstSocket = WebSocket.instances[0];
  firstSocket.open();
  document.dispatch('click', { target: button });
  bridge.stop();
  assert.equal(eventCaptures(firstSocket).length, 1);
  assert.equal(document.listenerCount('click'), 0);

  document.dispatch('click', { target: button });
  assert.equal(eventCaptures(firstSocket).length, 1);

  bridge.start();
  assert.equal(WebSocket.instances.length, 2);
  assert.equal(document.listenerCount('click'), 1);
  const secondSocket = WebSocket.instances[1];
  secondSocket.open();
  document.dispatch('click', { target: button });
  bridge.disconnect();
  assert.equal(eventCaptures(secondSocket).length, 1);
  assert.equal(document.listenerCount('click'), 0);
});

test('stop cancels a reconnect that was already scheduled by a remote close', async () => {
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({
    endpoint: 'ws://127.0.0.1:18180/ai-app-bridge-web',
    sessionId: 'reconnect-cancel-test',
    reconnectDelayMs: 1,
    WebSocket,
  });

  bridge.start();
  const socket = WebSocket.instances[0];
  socket.open();
  socket.onclose();
  bridge.stop();
  await wait(10);

  assert.equal(WebSocket.instances.length, 1);
  assert.equal(bridge.isConnected(), false);
});
