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
  const document = {
    title: 'Bridge Demo',
    readyState: 'complete',
    body: { innerText: 'Save changes Email' },
    querySelectorAll(selector) {
      assert.equal(selector, 'button,input');
      return [button, input];
    },
  };

  const dom = snapshotDom({ document, selector: 'button,input' });

  assert.equal(dom.ok, true);
  assert.equal(dom.title, 'Bridge Demo');
  assert.equal(dom.readyState, 'complete');
  assert.equal(dom.controlCount, 2);
  assert.deepEqual(dom.controls.map((control) => control.id), ['save', 'email']);
  assert.equal(dom.controls[0].text, 'Save changes');
  assert.equal(dom.controls[0].bounds.width, 100);
  assert.equal(dom.controls[1].name, 'email');
  assert.equal(dom.controls[1].type, 'email');
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
