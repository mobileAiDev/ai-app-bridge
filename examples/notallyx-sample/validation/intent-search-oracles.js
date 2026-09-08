'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PACKAGE } = require('./collector');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const id = name => PACKAGE + ':id/' + name;

function verifyForegroundXml(xml) {
  assert(typeof xml === 'string' && xml.startsWith('<?xml') && xml.endsWith('</hierarchy>'), 'complete_uia_xml_required');
  const nodes = xml.match(/<node\b[^>]*>/g) || [];
  assert(nodes.length > 0, 'uia_nodes_required');
  for (const node of nodes) {
    const packageName = node.match(/\bpackage="([^"]*)"/);
    assert(packageName && packageName[1] === PACKAGE, 'external_foreground_window');
  }
  return { ok: true, packageName: PACKAGE, nodeCount: nodes.length };
}

// Uses the raw windows contract preserved in the frozen Intent observations.
// The duplicate top-level root is deliberately not another observed window.
function screen(raw) {
  assert.equal(raw.ok, true, 'tree_not_ok');
  assert.equal(raw.activity, 'com.philkes.notallyx.presentation.activity.main.MainActivity');
  assert.equal(raw.windows.length, 1, 'unexpected_foreground_window');
  const window = raw.windows[0];
  assert.equal(window.index, 0); assert.equal(window.type, 'activity');
  const nodes = [], ancestors = new Map();
  function walk(node, parentVisible, parents) {
    ancestors.set(node, parents);
    const visible = parentVisible && node.visible === true && node.effectiveVisible === true;
    if (visible) nodes.push(node);
    if (node.children !== undefined) {
      assert(Array.isArray(node.children));
      node.children.forEach(child => walk(child, visible, [...parents, node]));
    }
  }
  walk(window.root, true, []);
  const one = name => {
    const matches = nodes.filter(n => n.resourceName === id(name));
    assert(matches.length <= 1, 'duplicate_control:' + name);
    return matches[0];
  };
  const input = one('EnterSearchKeyword'), list = one('MainListView');
  const inside = (inner, outer) => inner.left >= outer.left && inner.right <= outer.right
    && inner.top >= outer.top && inner.bottom <= outer.bottom && inner.width > 0 && inner.height > 0;
  const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const externalControls = list ? nodes.filter(n => n.clickable === true && n !== list
    && !ancestors.get(n).includes(list) && !ancestors.get(list).includes(n)) : [];
  const titles = list ? nodes.filter(n => n.resourceName === id('Title')
    && ancestors.get(n).includes(list) && ancestors.get(n).every(parent => inside(n.bounds, parent.bounds))
    && inside(n.bounds, window.bounds) && !externalControls.some(control => overlap(n.bounds, control.bounds))).map(n => n.text) : [];
  assert(titles.every(title => typeof title === 'string'));
  assert.equal(new Set(titles).size, titles.length, 'duplicate_result_title');
  const titleOrder = [...titles];
  return { query: input ? input.text : undefined, inputVisible: Boolean(input), titles: titles.sort(), titleOrder,
    emptyIllustration: nodes.some(n => n.resourceName === id('ImageView') && n.contentDescription === 'Background'),
    home: !input && nodes.some(n => n.contentDescription === '搜索')
      && nodes.some(n => n.contentDescription === '打开抽屉式导航栏'),
    listBounds: list ? list.bounds : null };
}

function readOutputEnvelopes(directory, operationId, events) {
  const calls = new Map(), artifacts = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.execution?.executionId === operationId && typeof value.execution.callId === 'string'
      && typeof value.command === 'string' && Object.hasOwn(value, 'result') && value.evidence) {
      const previous = calls.get(value.execution.callId);
      if (previous) assert.deepEqual(value, previous, 'conflicting_call_copy');
      else calls.set(value.execution.callId, value);
      return;
    }
    Object.values(value).forEach(visit);
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        assert(entry.isFile(), 'regular_artifact_required');
        const bytes = fs.readFileSync(file);
        artifacts.push({ path: path.relative(directory, file), bytes: bytes.length, sha256: sha(bytes) });
        if (entry.name.endsWith('.json')) visit(JSON.parse(bytes.toString('utf8')));
      }
    }
  }
  walk(directory);
  const ordered = [...calls.values()].sort((a, b) => Number(a.execution.callId.slice(5)) - Number(b.execution.callId.slice(5)));
  assert(ordered.length > 0, 'saved_call_envelopes_required');
  const readEvent = call => {
    const matching = events.filter(event => event.type === 'call_completed' && event.command === call.command
      && event.callId === call.execution.callId && event.observationId === call.evidence.observationId);
    assert.equal(matching.length, 1, call.command + '_not_bound_to_host_event');
    const event = matching[0];
    for (const field of ['source', 'window', 'coverage']) assert.deepEqual(event[field], call.evidence[field], 'host_read_metadata_mismatch:' + field);
    return event;
  };
  const treeCalls = ordered.filter(call => call.command === 'tree' && call.ok === true);
  for (const call of ordered.filter(call => ['tree', 'keyboard-state', 'status'].includes(call.command) && call.ok === true)) {
    assert.deepEqual(call.evidence.coverage, { status: 'complete', gap: false, committed: true });
    assert.equal(call.evidence.source.command, call.command);
    assert.equal(call.evidence.source.payloadSha256, sha(JSON.stringify(call.result)), call.command + '_payload_changed');
    readEvent(call);
    if (call.command === 'keyboard-state') {
      assert.equal(call.result.ok, true); assert.equal(typeof call.result.visible, 'boolean', 'keyboard_visibility_contract');
    }
  }
  const screenshots = ordered.filter(call => call.command === 'screenshot' && call.ok === true);
  for (const call of screenshots) {
    const event = readEvent(call);
    const ref = call.evidence.refs.find(item => item.stream === 'screenshot');
    assert(ref, 'screenshot_ref_required');
    const file = path.resolve(ref.screenshotId);
    assert(file.startsWith(path.resolve(directory) + path.sep), 'screenshot_outside_trial');
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(sha(bytes), ref.sha256, 'screenshot_hash_changed');
    assert.equal(call.evidence.source.payloadSha256, sha(JSON.stringify(call.result)), 'screenshot_payload_changed');
    assert(event.evidenceRefs.some(item => item.screenshotId === ref.screenshotId && item.sha256 === ref.sha256), 'screenshot_not_bound_to_host_event');
  }
  const assertions = events.filter(e => e.type.startsWith('assertion_'));
  for (const event of assertions.filter(e => e.scope === 'device')) {
    assert([...treeCalls, ...screenshots].some(call => call.evidence.observationId === event.observationId
      && call.evidence.source.payloadSha256 === event.source?.payloadSha256), 'device_assertion_tree_missing');
  }
  return { calls: ordered, treeCalls, screenshots, assertions, artifacts };
}

function evaluateTrial({ kind, status, evidence, expected, baselineTitles, events }) {
  const { treeCalls, screenshots, assertions } = evidence;
  const devicePassed = new Set(assertions.filter(e => e.scope === 'device' && e.type === 'assertion_passed').map(e => e.observationId));
  const observed = treeCalls.map(call => ({ call, state: screen(call.result) }));
  const proof = observed.filter(row => devicePassed.has(row.call.evidence.observationId));
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const order = call => Number(call.execution.callId.slice(5));
  const matchingScreenshot = row => screenshots.find(shot => {
    const before = treeCalls.findLast(tree => order(tree) < order(shot));
    const after = treeCalls.find(tree => order(tree) > order(shot));
    return before && after && [before, after].includes(row.call)
      && before.evidence.window.afterActionId === shot.evidence.window.afterActionId
      && after.evidence.window.afterActionId === shot.evidence.window.afterActionId
      && JSON.stringify(before.result.windows) === JSON.stringify(after.result.windows);
  });
  const hasScreenshot = row => Boolean(matchingScreenshot(row));
  const keyboardHidden = row => {
    const shot = matchingScreenshot(row);
    const before = shot && treeCalls.findLast(tree => order(tree) < order(shot));
    return before && evidence.calls.some(call => call.command === 'keyboard-state'
      && order(call) > order(before) && order(call) < order(shot)
      && call.evidence.window.afterActionId === shot.evidence.window.afterActionId && call.result.visible === false);
  };
  const title = proof.find(row => row.state.query === expected.title.query && same(row.state.titles, expected.title.titles) && hasScreenshot(row));
  const failed = assertions.filter(e => e.type === 'assertion_failed');
  const inconclusive = assertions.filter(e => e.type === 'assertion_inconclusive');
  const bodyDispatched = events.some(e => e.type === 'call_started' && e.command === 'input-text' && e.args.text === expected.body.query);
  const summary = { executionStatus: status, assertions: { passed: assertions.filter(e => e.type === 'assertion_passed').length,
    failed: failed.length, inconclusive: inconclusive.length }, trees: treeCalls.length, screenshots: screenshots.length };
  if (kind === 'wrong-expectation') {
    assert.equal(status, 'failed', 'wrong_expectation_did_not_stop');
    const rejection = failed.find(e => e.scope === 'device' && e.condition === false);
    assert(rejection, 'wrong_expectation_requires_device_failure');
    const row = observed.find(row => row.call.evidence.observationId === rejection.observationId);
    assert(row && row.state.query === expected.title.query && same(row.state.titles, expected.title.titles), 'wrong_expectation_not_checked_against_actual_title');
    assert.equal(inconclusive.length, 0); assert.equal(bodyDispatched, false, 'continued_after_wrong_expectation');
    assert(!events.some(e => e.sequence > rejection.sequence && e.type === 'call_started' && typeof e.actionId === 'string'), 'action_after_rejected_expectation');
    return { ...summary, verdict: 'passed', meaning: 'negative control correctly rejected; business assertion remains failed', rejectedAssertion: rejection.name };
  }
  assert(title, 'title_result_proof_missing');
  assert(proof.some(row => row.state.query === expected.title.query && same(row.state.titles, expected.title.titles)
    && keyboardHidden(row)), 'title_keyboard_hidden_proof_missing');
  assert.equal(failed.length, 0); assert.equal(inconclusive.length, 0);
  if (kind === 'cancel') {
    assert.equal(status, 'cancelled');
    const progress = events.find(e => e.type === 'progress' && e.phase === 'title-complete');
    assert(progress, 'cancel_checkpoint_not_reached');
    const question = events.find(e => e.type === 'agent_question_created'
      && e.request.question === 'intent-reuse cancellation checkpoint');
    assert(question, 'cancel_question_missing');
    const cancellation = events.find(e => e.type === 'script_cancelled'); assert(cancellation);
    const titleAssertion = assertions.find(e => e.type === 'assertion_passed' && e.scope === 'device'
      && e.observationId === title.call.evidence.observationId);
    const shot = matchingScreenshot(title);
    const shotEvent = events.find(e => e.type === 'call_completed' && e.command === 'screenshot'
      && e.callId === shot.execution.callId && e.observationId === shot.evidence.observationId);
    assert(shotEvent && titleAssertion.sequence < progress.sequence && shotEvent.sequence < progress.sequence
      && progress.sequence < question.sequence && question.sequence < cancellation.sequence, 'cancel_checkpoint_order_mismatch');
    assert.equal(bodyDispatched, false, 'body_started_after_cancel_gate');
    assert(!events.some(e => e.sequence > question.sequence && e.type === 'call_started'), 'call_after_cancel_question');
    return { ...summary, verdict: 'passed', meaning: 'cancelled at explicit decision checkpoint; no subsequent business action' };
  }
  assert.equal(status, 'completed');
  assert(!events.some(e => e.type === 'agent_question_created'), 'positive_run_needed_agent');
  const body = proof.filter(row => row.state.query === expected.body.query && keyboardHidden(row));
  const union = [...new Set(body.flatMap(row => row.state.titles))].sort();
  assert(same(union, expected.body.titles), 'body_result_set_mismatch');
  const empty = proof.find(row => row.state.query === expected.empty.query && row.state.titles.length === 0 && row.state.emptyIllustration && keyboardHidden(row));
  assert(Array.isArray(baselineTitles) && baselineTitles.length > 0, 'baseline_titles_required');
  const initialHome = proof.find(row => row.state.home && order(row.call) < order(title.call) && keyboardHidden(row));
  assert(initialHome && initialHome.state.titles.every(title => baselineTitles.includes(title)), 'initial_home_results_required');
  const anchors = initialHome.state.titleOrder.slice(0, 2);
  assert.equal(anchors.length, 2, 'two_initial_note_anchors_required');
  const restored = row => row.state.titles.length > 0 && row.state.titles.every(title => baselineTitles.includes(title))
    && anchors.every(title => row.state.titles.includes(title));
  const cleared = proof.find(row => empty && order(row.call) > order(empty.call)
    && row.state.inputVisible && row.state.query === '' && restored(row) && keyboardHidden(row));
  const home = proof.findLast(row => row.state.home && restored(row) && keyboardHidden(row));
  assert(empty && cleared && home, 'empty_clear_or_home_proof_missing');
  const rowOrder = row => order(row.call);
  assert(rowOrder(title) < Math.min(...body.map(rowOrder)) && Math.max(...body.map(rowOrder)) < rowOrder(empty)
    && rowOrder(empty) < rowOrder(cleared) && rowOrder(cleared) < rowOrder(home), 'phase_order_mismatch');
  return { ...summary, verdict: 'passed', meaning: 'independent UI and Host evidence checks passed',
    observed: { title: title.state.titles, body: union, empty: [], cleared: true, restoredAnchors: anchors, home: true } };
}

module.exports = { screen, verifyForegroundXml, readOutputEnvelopes, evaluateTrial };
