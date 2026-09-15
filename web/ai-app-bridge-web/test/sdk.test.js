const assert = require('assert/strict');
const test = require('node:test');

const { createAiAppBridge, snapshotDom } = require('../src/index.js');

test('UI observation does no idle DOM work and releases listeners on expiry', async () => {
  let scans = 0;
  const document = fakeEventTarget({ body: { innerText: '20' },
    querySelectorAll() { scans++; return []; } });
  const bridge = createAiAppBridge({ endpoint: 'ws://example.test', sessionId: 'bounded-ui',
    WebSocket: createFakeWebSocket(), capture: { ui: { document } } });
  bridge.start();
  await wait(20);
  assert.equal(scans, 0);
  assert.equal(document.listenerCount('click'), 0);
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5001 }).ok, false);
  const lease = bridge.uiObservation({ operation: 'start', durationMs: 100 });
  assert.equal(lease.active, true);
  assert.ok(scans > 0);
  assert.equal(document.listenerCount('click'), 1);
  assert.equal(bridge.uiObservation({ operation: 'stop', leaseId: 'other-owner' }).ok, false);
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 100 }).error, 'ui_observation_busy');
  await wait(160);
  assert.equal(bridge.uiObservation({ operation: 'status' }).active, false);
  assert.equal(document.listenerCount('click'), 0);
  const count = scans;
  await wait(30);
  assert.equal(scans, count);
  bridge.stop(); bridge.start();
  assert.equal(bridge.uiObservation({ operation: 'status' }).active, false);
  bridge.stop();
});

function fakeElement(overrides = {}) {
  const attrs = overrides.attrs || {};
  return {
    tagName: overrides.tagName || 'BUTTON',
    type: attrs.type || 'text',
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
      const hello = this.sent.find(message => message.type === 'hello');
      this.binding = { schemaVersion: 'aab.web/v2', providerEpoch: 'test-provider', connectionId: 'test-connection',
        sessionId: hello.sessionId, runtimeEpoch: hello.runtimeEpoch, targetId: hello.targetId };
      this.onmessage({ data: JSON.stringify({ type: 'helloAck', ok: true, binding: this.binding }) });
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.readyState = 3;
      this.onclose && this.onclose();
    }

    async command(name, args, actionId = 'action-1') {
      const target = { sessionId: this.binding.sessionId, runtimeEpoch: this.binding.runtimeEpoch, targetId: this.binding.targetId };
      this.onmessage({ data: JSON.stringify({ type: 'command', requestId: 'request-1', binding: this.binding,
        payload: { actionId, target, command: { name, args }, execution: {
          schemaVersion: 'aab.web-execution/v1', runtimeEpoch: target.runtimeEpoch, actionId, timeoutMs: 1000 } } }) });
      await wait(5);
      return this.sent.find(message => message.type === 'completion' && message.result.actionId === actionId)?.result;
    }

    async barrier(stream) {
      const requestId = `barrier-${this.sent.length}`;
      this.onmessage({ data: JSON.stringify({ type: 'read', requestId, binding: this.binding,
        payload: { name: 'captureBarrier', args: { stream } } }) });
      await wait(0);
      return this.sent.find(message => message.type === 'response' && message.requestId === requestId)?.result;
    }
  };
}

function installDocument(t, elements, url) {
  const original = { document: globalThis.document, window: globalThis.window, location: globalThis.location };
  class Input {
    get value() { return this._value; }
    set value(value) { this._value = value; }
  }
  const window = fakeEventTarget({ HTMLInputElement: Input, HTMLTextAreaElement: Input,
    Event: class Event {}, InputEvent: class InputEvent {}, innerWidth: 1024, innerHeight: 768,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
  const document = { title: 'Controls', defaultView: window, activeElement: null,
    querySelectorAll: css => css.startsWith('#') ? elements.filter(element => element.id === css.slice(1)) : elements,
    elementFromPoint: () => elements[0] };
  for (const element of elements) {
    element.ownerDocument = document; element.isConnected = true; element.contains = () => false;
    element.focus = () => { document.activeElement = element; }; element.dispatchEvent = () => {};
    if (element.tagName === 'INPUT') {
      element._value = element.value; delete element.value; Object.setPrototypeOf(element, Input.prototype);
    }
  }
  globalThis.document = document; globalThis.window = window; globalThis.location = new URL(url);
  t.after(() => Object.assign(globalThis, original));
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

test('DOM checked state reads live native properties and explicit ARIA state without inventing unchecked values', t => {
  const native = fakeElement({ tagName: 'INPUT', attrs: { type: 'checkbox', checked: 'checked' } });
  native.checked = false; native.indeterminate = false;
  const radio = fakeElement({ tagName: 'INPUT', attrs: { type: 'radio' } }); radio.checked = true;
  const tri = fakeElement({ tagName: 'INPUT', attrs: { type: 'checkbox' } }); tri.checked = false; tri.indeterminate = true;
  const custom = fakeElement({ tagName: 'SPAN', attrs: { role: 'checkbox', 'aria-checked': 'false' } });
  const mixed = fakeElement({ tagName: 'SPAN', attrs: { role: 'checkbox', 'aria-checked': 'mixed' } });
  const missing = fakeElement({ tagName: 'SPAN', attrs: { role: 'checkbox' } });
  const invalid = fakeElement({ tagName: 'SPAN', attrs: { role: 'checkbox', 'aria-checked': 'yes' } });
  const switchMixed = fakeElement({ tagName: 'SPAN', attrs: { role: 'switch', 'aria-checked': 'mixed' } });
  const textInput = fakeElement({ tagName: 'INPUT', attrs: { type: 'text', 'aria-checked': 'true' } });
  installDocument(t, [native, radio, tri, custom, mixed, missing, invalid, switchMixed, textInput], 'https://example.test/');
  const initial = snapshotDom();
  assert.deepEqual(initial.controls.map(node => node.checked), [false, true, 'mixed', false, 'mixed', null, null, false, null]);
  assert.equal(initial.controls[6].ariaChecked, 'yes');
  assert.equal(initial.controls[7].ariaChecked, 'mixed');
  native.checked = true;
  const changed = snapshotDom();
  assert.equal(changed.controls[0].checked, true);
  assert.equal(changed.controls[0].elementId, initial.controls[0].elementId);
});

test('a managed checkbox click observes the actual resulting property', async t => {
  const checkbox = fakeElement({ tagName: 'INPUT', id: 'task', attrs: { type: 'checkbox' } });
  checkbox.checked = false; checkbox.indeterminate = false;
  checkbox.click = () => { checkbox.checked = !checkbox.checked; };
  installDocument(t, [checkbox], 'https://example.test/');
  const FakeWebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({ endpoint: 'ws://example.test', token: 'test-token', WebSocket: FakeWebSocket,
    sessionId: 'checkbox-page', capture: { console: false, errors: false, fetch: false, xhr: false, ui: false } });
  t.after(() => bridge.stop());
  bridge.start(); const socket = FakeWebSocket.instances[0]; socket.open();
  const before = bridge.snapshotDom();
  const result = await socket.command('click', { selector: { elementId: before.controls[0].elementId } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.settled, true);
  assert.equal(bridge.snapshotDom().controls[0].checked, true);
});

test('password input command returns only length metadata', async (t) => {
  const password = fakeElement({
    tagName: 'INPUT',
    id: 'password',
    attrs: { name: 'password', type: 'password' },
  });
  installDocument(t, [password], 'https://example.test/login');
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
  const commandResult = await socket.command('input', { selector: { css: '#password' }, value: 'command-secret-marker' });
  assert.equal(commandResult.ok, true);
  assert.equal(commandResult.sensitive, true);
  assert.equal(commandResult.valueLength, 21);
  assert.equal(commandResult.value, undefined);
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
  installDocument(t, [button], 'https://example.test/order');
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
  const commandResult = await socket.command('click', { selector: { css: '#save-order' } });
  assert.equal(commandResult.ok, true);
  assert.equal(clickCount, 1);
  assert.equal(commandResult.resolved.element.id, 'save-order');
  assert.equal(commandResult.resolved.element.role, 'button');
  assert.equal(commandResult.resolved.pageRef.url, 'https://example.test/order');
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

test('fetch capture keeps its dispatch origin when a slower response arrives after another action', async t => {
  const button = fakeElement({ id: 'save' });
  installDocument(t, [button], 'https://example.test/memos');
  let finishSlow;
  window.fetch = url => url === '/slow'
    ? new Promise(resolve => { finishSlow = resolve; }) : Promise.resolve(new Response('fast'));
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({ endpoint: 'ws://example.test/', sessionId: 'causal-fetch', WebSocket,
    capture: { fetch: true }, captureRequestBodies: true, captureResponseBodies: true }).start();
  t.after(() => bridge.stop());
  const socket = WebSocket.instances[0]; socket.open();
  button.click = () => { void window.fetch('/slow', { method: 'POST', body: '{"memo":"first"}' }); };
  assert.equal((await socket.command('click', { selector: { css: '#save' } }, 'first')).ok, true);
  assert.equal((await socket.barrier('network')).pending, 1);
  socket.onmessage({ data: JSON.stringify({ type: 'completionAck', binding: socket.binding, actionId: 'first', stored: true }) });
  button.click = () => { void window.fetch('/fast'); };
  assert.equal((await socket.command('click', { selector: { css: '#save' } }, 'second')).ok, true);
  finishSlow(new Response('slow'));
  await wait(20);
  const captures = socket.sent.filter(message => message.type === 'capture' && message.stream === 'network');
  assert.equal(captures.length, 2);
  assert.deepEqual(captures.map(value => [value.item.url, value.actionId, value.item.association]),
    [['/fast', 'second', 'synchronous'], ['/slow', 'first', 'synchronous']]);
  assert.equal(captures[1].item.requestBody, '{"memo":"first"}');
  assert.equal(captures[1].item.responseBody, 'slow');
  assert.deepEqual(captures.map(value => value.sequence), [1, 2]);
  assert.equal((await socket.barrier('network')).pending, 0);
});

test('binary request and response bytes survive capture without consuming the App response', async t => {
  installDocument(t, [], 'https://example.test/memos');
  const bytes = Uint8Array.from({ length: 12000 }, (_, index) => index % 256);
  window.fetch = async () => new Response(bytes);
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({ endpoint: 'ws://example.test/', sessionId: 'binary-fetch', WebSocket,
    capture: { fetch: true }, captureRequestBodies: true, captureResponseBodies: true }).start();
  t.after(() => bridge.stop());
  const socket = WebSocket.instances[0]; socket.open();
  const response = await window.fetch('/protobuf', { method: 'POST', body: bytes });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  await wait(20);
  const captured = socket.sent.find(message => message.type === 'capture' && message.stream === 'network').item;
  for (const side of ['request', 'response']) {
    assert.equal(captured[`${side}BodyState`], 'complete');
    assert.equal(captured[`${side}BodyEncoding`], 'base64');
    assert.deepEqual(new Uint8Array(Buffer.from(captured[`${side}Body`], 'base64')), bytes);
  }
});

test('XHR body capture is opt-in and retains the request origin', async t => {
  const button = fakeElement({ id: 'save' });
  installDocument(t, [button], 'https://example.test/memos');
  class Xhr {
    constructor() { fakeEventTarget(this); this.responseType = ''; this.responseText = 'saved'; this.status = 200; }
    open() {}
    send() {}
  }
  window.XMLHttpRequest = Xhr;
  for (const enabled of [false, true]) {
    const WebSocket = createFakeWebSocket();
    const bridge = createAiAppBridge({ endpoint: 'ws://example.test/', sessionId: 'xhr-bodies', WebSocket,
      capture: { xhr: true }, captureRequestBodies: enabled, captureResponseBodies: enabled }).start();
    const socket = WebSocket.instances[0]; socket.open();
    let request;
    button.click = () => { request = new Xhr(); request.open('PATCH', '/memo'); request.send('draft'); };
    assert.equal((await socket.command('click', { selector: { css: '#save' } }, 'xhr-save')).ok, true);
    assert.equal((await socket.barrier('network')).pending, 1);
    request.dispatch('loadend');
    await wait(1);
    const capture = socket.sent.find(message => message.type === 'capture' && message.stream === 'network');
    assert.equal(capture.actionId, 'xhr-save');
    assert.equal(capture.item.association, 'synchronous');
    assert.equal(capture.item.requestBody, enabled ? 'draft' : undefined);
    assert.equal(capture.item.responseBody, enabled ? 'saved' : undefined);
    assert.equal(capture.item.requestBodyState, enabled ? 'complete' : 'disabled');
    assert.equal((await socket.barrier('network')).pending, 0);
    bridge.stop();
  }
});

test('native await continuations and unrelated fetches remain unattributed', async t => {
  const button = fakeElement({ id: 'save' });
  installDocument(t, [button], 'https://example.test/memos');
  window.fetch = () => Promise.resolve(new Response('ok'));
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({ endpoint: 'ws://example.test/', sessionId: 'async-fetch', WebSocket,
    capture: { fetch: true } }).start();
  t.after(() => bridge.stop());
  const socket = WebSocket.instances[0]; socket.open();
  button.click = () => { void (async () => { await Promise.resolve(); await window.fetch('/awaited'); })(); };
  assert.equal((await socket.command('click', { selector: { css: '#save' } })).ok, true);
  await window.fetch('/background'); await wait(5);
  const captures = socket.sent.filter(message => message.type === 'capture');
  assert.equal(captures.length, 2);
  assert.equal(captures.every(value => value.actionId === null && value.item.association === 'unattributed'), true);
});

test('capture barriers expose rejected records and queue loss instead of silently reporting completeness', async t => {
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({ endpoint: 'ws://example.test/', sessionId: 'capture-loss', WebSocket }).start();
  t.after(() => bridge.stop());
  for (let index = 0; index < 101; index++) bridge.recordEvent('test', 'queued', { index });
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(bridge.recordEvent('test', 'invalid', cyclic).accepted, false);
  const socket = WebSocket.instances[0]; socket.open();
  const barrier = await socket.barrier('events');
  assert.equal(barrier.sequence, 102);
  assert.equal(barrier.losses, 2);
  assert.equal(barrier.pending, 0);
  assert.equal(socket.sent.filter(message => message.type === 'capture').length, 100);
});

test('response-body capture is bounded and does not consume the App response', async t => {
  installDocument(t, [], 'https://example.test/memos');
  const content = 'a'.repeat(20000);
  window.fetch = () => Promise.resolve(new Response(content));
  const WebSocket = createFakeWebSocket();
  const bridge = createAiAppBridge({ endpoint: 'ws://example.test/', sessionId: 'body-limit', WebSocket,
    capture: { fetch: true }, captureResponseBodies: true }).start();
  t.after(() => bridge.stop());
  const socket = WebSocket.instances[0]; socket.open();
  assert.equal(await (await window.fetch('/large')).text(), content);
  await wait(10);
  const capture = socket.sent.find(message => message.type === 'capture');
  assert.equal(capture.item.responseBody, undefined);
  assert.equal(capture.item.responseBodyState, 'too-large');
  assert.equal((await socket.barrier('network')).pending, 0);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
  bridge.start();
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).error, 'ui_observation_busy');
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
  assert.equal(bridge.uiObservation({ operation: 'start', durationMs: 5000 }).active, true);
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
