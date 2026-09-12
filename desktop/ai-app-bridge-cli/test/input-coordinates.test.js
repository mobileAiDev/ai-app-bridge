'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inputText, inputTextBridgePayload } = require('../bin/device-provider');
const { parseArgs } = require('../bin/ai-app-bridge');

const invalidCases = [
  [{ tapX: 10 }, 'x_y_must_be_provided_together'],
  [{ tapY: 20 }, 'x_y_must_be_provided_together'],
  ...[undefined, null, '', '   ', '\t\n', NaN, Infinity, -Infinity, 'NaN', 'Infinity', '1e309', 'not-a-number', true, false, [], {}, Number.MAX_VALUE, 1e40]
    .flatMap((value) => [
      [{ tapX: value, tapY: 20 }, 'invalid_input_coordinates'],
      [{ tapX: 10, tapY: value }, 'invalid_input_coordinates'],
    ]),
];

test('input payload permits focused input only when both coordinate keys are absent', () => {
  assert.deepEqual(inputTextBridgePayload('focus'), { text: 'focus' });
  assert.deepEqual(inputTextBridgePayload('', { runtimeActionId: 'clear-1' }), { text: '', actionId: 'clear-1' });
  assert.deepEqual(inputTextBridgePayload('focus', { hideKeyboard: true }), { text: 'focus' });
});

test('input payload preserves complete finite coordinates including zero and numeric CLI strings', () => {
  assert.deepEqual(inputTextBridgePayload('text', { tapX: 0, tapY: 0 }), { text: 'text', x: 0, y: 0 });
  assert.deepEqual(inputTextBridgePayload('内容', { tapX: '12.5', tapY: ' 80 ', requestId: 'typed-1' }), {
    text: '内容', actionId: 'typed-1', x: 12.5, y: 80,
  });
  const { options } = parseArgs(['input-text', '--text', '', '--tap-x', '12', '--tap-y', '34']);
  assert.deepEqual(inputTextBridgePayload(options.text, options), { text: '', x: 12, y: 34 });
});

test('input payload rejects partial, nonfinite, null and blank coordinates explicitly', () => {
  for (const [options, code] of invalidCases) {
    assert.throws(() => inputTextBridgePayload('do not edit focus', options), (error) => error.code === code && error.message.includes(code));
  }
  for (const argv of [
    ['input-text', '--tap-x', '12'],
    ['input-text', '--tap-x', '12', '--tap-y'],
    ['input-text', '--tap-x', '', '--tap-y', '20'],
  ]) {
    const { options } = parseArgs(argv);
    assert.throws(() => inputTextBridgePayload('text', options));
  }
});

test('input rejects invalid coordinates before reading dispatch context or reaching HTTP/ADB fallback', async () => {
  for (const [options, code] of invalidCases) {
    const dispatchReads = [];
    const ctx = new Proxy({}, { get(_target, key) { dispatchReads.push(key); throw new Error('dispatch context must not be read'); } });
    await assert.rejects(inputText(ctx, 'ASCII would otherwise allow ADB fallback', options), (error) => error.code === code);
    assert.deepEqual(dispatchReads, [], 'validation occurs before any bridge or ADB operation');
  }
});
