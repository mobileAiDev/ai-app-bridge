'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseForegroundWindow, tap } = require('../bin/device-provider');

const main = 'Window{aaa u0 com.example.main/.MainActivity}';
const other = 'Window{bbb u0 com.example.other/.MainActivity}';
const display = (id, focus) => `  Display: mDisplayId=${id} stacks=1\n  mCurrentFocus=${focus}`;

test('foreground parsing skips null focus records in either display order (YIC)', () => {
  for (const blocks of [[display(1, 'null'), display(0, main)], [display(0, main), display(1, 'null')]]) {
    const result = parseForegroundWindow(`${blocks.join('\n')}\n  mTopFocusedDisplayId=0`);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'mCurrentFocus');
    assert.equal(result.packageName, 'com.example.main');
  }
});

test('foreground parsing skips indexed null focus records in either order (K2)', () => {
  const records = [`  mCurrentFocus[0]=${main}`, '  mCurrentFocus[1]=null'];
  for (const lines of [records, [...records].reverse()]) {
    const result = parseForegroundWindow(lines.join('\n'));
    assert.equal(result.ok, true);
    assert.equal(result.packageName, 'com.example.main');
  }
});

test('foreground parsing uses the sole valid window even without display metadata', () => {
  const expected = parseForegroundWindow(`mCurrentFocus=${main}`);
  assert.deepEqual(parseForegroundWindow(`mCurrentFocus=null\r\nmCurrentFocus=${main}\r\nmCurrentFocus=null`), expected);
});

test('multiple focus windows follow the system focused display regardless of record order', () => {
  for (const focusedDisplayId of [0, 1]) {
    for (const blocks of [[display(0, main), display(1, other)], [display(1, other), display(0, main)]]) {
      for (const lines of [[`mTopFocusedDisplayId=${focusedDisplayId}`, ...blocks], [...blocks, `mTopFocusedDisplayId=${focusedDisplayId}`]]) {
        const result = parseForegroundWindow(lines.join('\n'));
        assert.equal(result.ok, true);
        assert.equal(result.packageName, focusedDisplayId === 0 ? 'com.example.main' : 'com.example.other');
      }
    }
  }
});

test('indexed focus display IDs take precedence over preceding display sections', () => {
  const result = parseForegroundWindow(`Display: mDisplayId=9\nmCurrentFocus[0]=${main}\nmCurrentFocus[1]=${other}\nmTopFocusedDisplayId=1`);
  assert.equal(result.ok, true);
  assert.equal(result.packageName, 'com.example.other');
});

for (const [name, suffix] of [
  ['missing', ''],
  ['unmatched', 'mTopFocusedDisplayId=2'],
  ['conflicting', 'mTopFocusedDisplayId=0\nmTopFocusedDisplayId=1'],
]) {
  test(`multiple focus windows report ambiguity with ${name} focused display metadata`, () => {
    const result = parseForegroundWindow(`${display(0, main)}\n${display(1, other)}\n${suffix}\nmFocusedApp=ActivityRecord{ccc u0 com.example.main/.MainActivity}`);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'foreground_ambiguous');
    assert.equal(result.source, 'mCurrentFocus');
    assert.equal(result.candidates.length, 2);
  });
}

test('two distinct windows on the focused display remain ambiguous even for the same component', () => {
  const second = main.replace('aaa', 'bbb');
  const result = parseForegroundWindow(`${display(0, main)}\nmCurrentFocus=${second}\nmTopFocusedDisplayId=0`);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'foreground_ambiguous');
});

test('an unrelated window mDisplayId field cannot assign a focus record to a display', () => {
  const result = parseForegroundWindow(`mDisplayId=0 rootTaskId=1\nmCurrentFocus=${main}\nmDisplayId=1 rootTaskId=2\nmCurrentFocus=${other}\nmTopFocusedDisplayId=0`);
  assert.equal(result.error, 'foreground_ambiguous');
});

test('display context ends at the next dumpsys section', () => {
  const result = parseForegroundWindow(`${display(0, 'null')}\nWINDOW MANAGER WINDOWS (dumpsys window windows)\nmCurrentFocus=${main}\n${display(1, other)}\nmTopFocusedDisplayId=0`);
  assert.equal(result.error, 'foreground_ambiguous');
});

test('repeated identical focus records represent one window', () => {
  const result = parseForegroundWindow(`mCurrentFocus=${main}\nmCurrentFocus=${main}`);
  assert.equal(result.ok, true);
  assert.equal(result.packageName, 'com.example.main');
});

test('existing marker priority is retained and later valid activity records are considered', () => {
  const resumed = 'mResumedActivity: ActivityRecord{ccc u0 com.example.other/.MainActivity}';
  const result = parseForegroundWindow(`mCurrentFocus=null\nmResumedActivity: null\n${resumed}`);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'mResumedActivity');
  assert.equal(parseForegroundWindow(`${resumed}\nmCurrentFocus=${main}`).packageName, 'com.example.main');
});

test('empty and null-only dumps still report foreground_not_found', () => {
  for (const raw of ['', null, 'mCurrentFocus=null\nmFocusedApp=null']) {
    assert.deepEqual(parseForegroundWindow(raw), { ok: false, error: 'foreground_not_found' });
  }
});

test('tap retains package and ambiguity checks after parsing all focus records', async () => {
  for (const raw of [
    `${display(1, 'null')}\n${display(0, other)}`,
    `${display(0, main)}\n${display(1, other)}`,
  ]) {
    const foreground = parseForegroundWindow(raw);
    const result = await tap({ explicitPackageName: true, packageName: 'com.example.main' }, 10, 10, { scope: 'device' }, {
      foregroundWindow: async () => foreground,
      adb: async () => assert.fail('Rejected focus must not dispatch input'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.deepEqual(result.targetFeedback.foreground, foreground);
    assert.equal(result.error, foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed');
  }
});
