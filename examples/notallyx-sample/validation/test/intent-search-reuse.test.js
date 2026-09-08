'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { screen, verifyForegroundXml, readOutputEnvelopes, evaluateTrial } = require('../intent-search-oracles');
const { optionsOf } = require('../run-intent-search-reuse');
const prefix = 'io.github.mobileaidev.notallyx.sample:id/';
const bounds = (top, bottom) => ({ left: 0, right: 100, top, bottom, width: 100, height: bottom - top });
const node = (name, text, top, bottom) => ({ resourceName: prefix + name, text, visible: true,
  effectiveVisible: true, bounds: bounds(top, bottom) });
function rawTree() {
  const root = { visible: true, effectiveVisible: true, bounds: bounds(0, 1000), children: [
    node('EnterSearchKeyword', '', 100, 150),
    { ...node('MainListView', undefined, 200, 900), children: [
      node('Title', 'clipped-by-toolbar', 170, 210), node('Title', 'fully-visible', 400, 450),
      node('Title', 'below-viewport', 890, 950),
    ] },
  ] };
  return { ok: true, activity: 'com.philkes.notallyx.presentation.activity.main.MainActivity',
    windows: [{ index: 0, type: 'activity', bounds: bounds(0, 1000), root }], root: structuredClone(root) };
}

test('counts readable titles once despite duplicate roots and optimistic visible flags', () => {
  const result = screen(rawTree());
  assert.deepEqual(result.titles, ['fully-visible']);
  assert.equal(result.query, '');
});

test('does not coerce null input to an empty query or accept a hidden ancestor', () => {
  const raw = rawTree(); raw.windows[0].root.children[0].text = null;
  raw.windows[0].root.children[1].visible = false;
  const result = screen(raw); assert.equal(result.query, null); assert.deepEqual(result.titles, []);
});

test('excludes a title covered by a floating control outside the scrolling list', () => {
  const raw = rawTree();
  raw.windows[0].root.children.push({ ...node('MakeList', '', 430, 470), clickable: true });
  assert.deepEqual(screen(raw).titles, []);
});

test('rejects an unaccounted foreground dialog', () => {
  const raw = rawTree(); raw.windows.push({ index: 1, type: 'dialog', root: raw.root });
  assert.throws(() => screen(raw), /unexpected_foreground_window/);
});

test('rejects system overlays or incomplete UIA evidence despite an App SDK tree', () => {
  const xml = packageName => '<?xml version="1.0"?><hierarchy><node package="' + packageName + '"/></hierarchy>';
  assert.equal(verifyForegroundXml(xml('io.github.mobileaidev.notallyx.sample')).ok, true);
  assert.throws(() => verifyForegroundXml(xml('com.android.systemui')), /external_foreground_window/);
  assert.throws(() => verifyForegroundXml('<?xml version="1.0"?><hierarchy><node/></hierarchy>'), /external_foreground_window/);
  assert.throws(() => verifyForegroundXml('<hierarchy>'), /complete_uia_xml_required/);
});

test('controller requires complete explicit options and rejects duplicates', () => {
  assert.throws(() => optionsOf([]), /missing_argument/);
  assert.throws(() => optionsOf(['--serial', 'one', '--serial', 'two']), /explicit_unique_arguments/);
});

test('a completed execution cannot make a wrong-expectation control pass', () => {
  assert.throws(() => evaluateTrial({ kind: 'wrong-expectation', status: 'completed',
    evidence: { treeCalls: [], screenshots: [], assertions: [] }, expected: { title: { query: 'q', titles: ['x'] }, body: { query: 'body' } }, events: [] }), /wrong_expectation_did_not_stop/);
});

test('binds saved tree bytes to Host-issued read events and rejects changed payloads', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-search-oracle-'));
  try {
    const result = rawTree();
    const payloadSha256 = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
    const call = { ok: true, command: 'tree', result, execution: { executionId: 'trial', callId: 'call-1' },
      evidence: { observationId: 'obs', source: { command: 'tree', payloadSha256 }, coverage: { status: 'complete', gap: false, committed: true },
        refs: [{ hostObservationId: 'obs', payloadSha256 }] } };
    const events = [{ type: 'call_completed', command: 'tree', callId: 'call-1', observationId: 'obs', source: call.evidence.source,
      coverage: call.evidence.coverage, evidenceRefs: [{ hostObservationId: 'obs', payloadSha256 }] }];
    const file = path.join(directory, 'tree.json'); fs.writeFileSync(file, JSON.stringify(call));
    assert.equal(readOutputEnvelopes(directory, 'trial', events).treeCalls.length, 1);
    assert.throws(() => readOutputEnvelopes(directory, 'trial', []), /tree_not_bound_to_host_event/);
    assert.throws(() => readOutputEnvelopes(directory, 'trial', [{ ...events[0], source: { ...events[0].source, payloadSha256: 'unrelated' } }]), /host_read_metadata_mismatch:source/);
    call.result.windows[0].root.children[0].text = 'changed'; fs.writeFileSync(file, JSON.stringify(call));
    assert.throws(() => readOutputEnvelopes(directory, 'trial', events), /tree_payload_changed/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

// Model asynchronous query refresh and the decision gate, not Script internals.
function trialFixture(kind = 'positive') {
  const calls = [], treeCalls = [], screenshots = [], assertions = [], events = [];
  let nextCall = 0;
  const emit = event => { const value = { ...event, sequence: events.length + 1 }; events.push(value); return value; };
  function capture(query, titles, extras = {}) {
    const raw = rawTree();
    raw.windows[0].root.children = [
      ...(query === undefined ? [
        { ...node('Search', '', 10, 50), contentDescription: '搜索' },
        { ...node('Drawer', '', 50, 90), contentDescription: '打开抽屉式导航栏' },
      ] : [node('EnterSearchKeyword', query, 100, 150)]),
      { ...node('MainListView', undefined, 200, 900), children: titles.map((title, i) => node('Title', title, 250 + i * 70, 300 + i * 70)) },
      ...(extras.empty ? [{ ...node('ImageView', '', 200, 300), contentDescription: 'Background' }] : []),
    ];
    const action = 'action-' + nextCall;
    function envelope(command) {
      const n = ++nextCall;
      return { command, execution: { callId: 'call-' + n }, evidence: { observationId: 'obs-' + n, window: { afterActionId: action } }, result: structuredClone(raw) };
    }
    const before = envelope('tree'); treeCalls.push(before);
    const keyboard = envelope('keyboard-state'); keyboard.result = { ok: true, visible: false };
    const shot = envelope('screenshot'); screenshots.push(shot);
    emit({ type: 'call_completed', command: 'screenshot', callId: shot.execution.callId,
      observationId: shot.evidence.observationId, evidenceRefs: [] });
    const after = envelope('tree'); treeCalls.push(after);
    calls.push(before, keyboard, shot, after);
    const assertion = emit({ type: 'assertion_passed', scope: 'device', observationId: after.evidence.observationId, condition: true });
    assertions.push(assertion);
    return { before, shot, after, assertion };
  }
  // The initial viewport can consist entirely of notes matching the later body query.
  if (kind === 'positive') {
    capture(undefined, ['unique', 'body-other']);
    capture('', ['unique', 'body-other']);
  }
  const title = capture('unique', ['unique']);
  const input = { kind, status: kind === 'positive' ? 'completed' : kind === 'cancel' ? 'cancelled' : 'failed',
    evidence: { calls, treeCalls, screenshots, assertions }, events,
    expected: { title: { query: 'unique', titles: ['unique'] }, body: { query: 'body', titles: ['unique', 'body-other'] }, empty: { query: 'none', titles: [] } },
    baselineTitles: ['unique', 'body-other', 'list-note'] };
  let cleared;
  if (kind === 'positive') {
    capture('body', ['unique']); capture('body', ['body-other']); capture('none', [], { empty: true });
    cleared = capture('', ['unique', 'body-other']); capture(undefined, ['unique', 'body-other']);
  } else if (kind === 'cancel') {
    emit({ type: 'progress', phase: 'title-complete' });
    emit({ type: 'agent_question_created', request: { question: 'intent-reuse cancellation checkpoint' } });
    emit({ type: 'script_cancelled' });
  } else {
    title.assertion.type = 'assertion_failed'; title.assertion.condition = false;
    emit({ type: 'script_failed' });
  }
  return { input, title, cleared };
}

test('accepts stable screenshot brackets and complete result restoration', () => {
  for (const kind of ['positive', 'wrong-expectation', 'cancel']) {
    assert.equal(evaluateTrial(trialFixture(kind).input).verdict, 'passed');
  }
});

test('rejects cleared input with stale filtered titles', () => {
  const { input, cleared } = trialFixture();
  for (const call of [cleared.before, cleared.after]) call.result.windows[0].root.children[1].children.splice(1);
  assert.throws(() => evaluateTrial(input), /empty_clear_or_home_proof_missing/);
});

test('rejects a screenshot bracket spanning a filter transition', () => {
  const { input, title } = trialFixture();
  title.before.result.windows[0].root.children[1].children[0].text = 'stale-result';
  assert.throws(() => evaluateTrial(input), /title_result_proof_missing/);
});

test('requires a fresh keyboard-hidden result in the stable screenshot bracket', () => {
  const { input, title } = trialFixture();
  input.evidence.calls.find(call => call.command === 'keyboard-state'
    && call.evidence.window.afterActionId === title.shot.evidence.window.afterActionId).result.visible = true;
  assert.throws(() => evaluateTrial(input), /title_keyboard_hidden_proof_missing/);
});

test('rejects any business action after an expected assertion failure', () => {
  const { input } = trialFixture('wrong-expectation');
  input.events.splice(-1, 0, { type: 'call_started', command: 'keyevent', actionId: 'unexpected-action', sequence: 3 });
  assert.throws(() => evaluateTrial(input), /action_after_rejected_expectation/);
});

test('rejects calls after askAgent even before the cancellation terminal event', () => {
  const { input } = trialFixture('cancel');
  input.events.splice(-1, 0, { type: 'call_started', command: 'tap', actionId: 'unexpected-action', sequence: 4.5 });
  assert.throws(() => evaluateTrial(input), /call_after_cancel_question/);
});
