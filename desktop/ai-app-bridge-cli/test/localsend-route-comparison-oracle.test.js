'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCommandArguments } = require('../bin/command-registry');
const { evaluateOracle, EXPECTATION, NEGATIVE_EXPECTATION, PACKAGE, schedule, parseArgs, buildSteps } = require('../scripts/validation/localsend-route-comparison');

function phase(labels) {
  return {
    nodes: { nodes: labels.map((text) => ({ text })) },
    screenshot: { validPng: true, sha256: 'test-only-image-hash', foregroundPackageName: PACKAGE, ocr: { status: 'ok', texts: labels.slice() } },
  };
}
function evidence() {
  return { before: phase(EXPECTATION.homeLabels), opened: phase([EXPECTATION.openLabel, '返回']), returned: phase(EXPECTATION.homeLabels) };
}

test('shared external oracle requires opened and restored state in both independent sources', () => {
  assert.equal(evaluateOracle(evidence()).verdict, 'passed');
  const wrong = evidence();
  wrong.opened.nodes = { nodes: [{ text: '仅执行结束，没有打开目标页' }] };
  wrong.scriptCompleted = true;
  assert.equal(evaluateOracle(wrong).verdict, 'failed');
});

test('screenshot content contradicting good nodes fails the same oracle', () => {
  const input = evidence();
  input.opened.screenshot.ocr.texts = ['首页'];
  assert.equal(evaluateOracle(input).verdict, 'failed');
});

test('returned state must lose the unique page label even if navigation labels remain', () => {
  const input = evidence();
  input.returned.nodes.nodes.push({ text: EXPECTATION.openLabel });
  input.returned.screenshot.ocr.texts.push(EXPECTATION.openLabel);
  assert.equal(evaluateOracle(input).verdict, 'failed');
});

test('missing a required home navigation label cannot pass', () => {
  const input = evidence();
  input.returned.nodes.nodes = input.returned.nodes.nodes.filter((node) => node.text !== '设置');
  assert.equal(evaluateOracle(input).verdict, 'failed');
});

test('OCR error, missing screenshot and wrong foreground package stay inconclusive', () => {
  const unavailable = evidence();
  unavailable.opened.screenshot.ocr = { status: 'error', texts: [] };
  assert.equal(evaluateOracle(unavailable).verdict, 'inconclusive');
  const missing = evidence();
  delete missing.before.screenshot;
  assert.equal(evaluateOracle(missing).verdict, 'inconclusive');
  const otherApp = evidence();
  otherApp.returned.screenshot.foregroundPackageName = 'unrelated.package';
  assert.equal(evaluateOracle(otherApp).verdict, 'inconclusive');
});

test('deliberately wrong expectation is rejected against evidence that passes the positive oracle', () => {
  const input = evidence();
  assert.equal(evaluateOracle(input).verdict, 'passed');
  const negative = evaluateOracle(input, NEGATIVE_EXPECTATION);
  assert.equal(negative.verdict, 'failed');
  assert.equal(negative.checks.filter((check) => check.phase === 'opened').every((check) => check.verdict === 'failed'), true);
});

test('interleaving balances both supported methods across the two positions', () => {
  const plan = schedule(2);
  assert.deepEqual(plan.map((item) => item.mode), ['plain-js','script','script','plain-js']);
});

test('device serial and exact package must both be explicitly selected', () => {
  assert.throws(() => parseArgs([]), /Explicit --serial/);
  assert.throws(() => parseArgs(['--serial','device','--packageName','other']), /Explicit --serial/);
  const options = parseArgs(['--serial','device','--packageName',PACKAGE,'--plan-only']);
  assert.equal(options.serial, 'device');
  assert.equal(options['plan-only'], true);
  assert.equal(parseArgs(['--serial','device','--packageName',PACKAGE,'--rounds','1']).rounds, 1);
});

test('all modes share explicit target, waits, screenshot paths and Flutter-node evidence commands', () => {
  const target = { serial:'explicit-device', packageName:PACKAGE };
  const steps = buildSteps(target, '/tmp/does-not-execute-any-device-command');
  assert.equal(steps.length, 11);
  assert.equal(steps.filter((step) => step.command === 'flutter-nodes').length, 3);
  assert.equal(steps.filter((step) => step.command === 'screenshot').length, 3);
  assert.equal(steps.every((step) => step.arguments.serial === target.serial && step.arguments.packageName === PACKAGE), true);
  assert.equal(steps.find((step) => step.id === 'open').arguments.targetText, '通过链接接收');
  assert.deepEqual(steps.find((step) => step.id === 'returned-wait').arguments.absentText, [EXPECTATION.openLabel]);
  for (const step of steps) assert.doesNotThrow(() => validateCommandArguments(step.command, step.arguments));
});

test('the receive link cannot impersonate the separate receive navigation tab', () => {
  const input = evidence();
  input.returned.nodes.nodes = input.returned.nodes.nodes.filter((node) => node.text !== '接收');
  assert.equal(evaluateOracle(input).verdict, 'failed');
});

test('OCR may group the complete bottom navigation line without weakening node identity', () => {
  const input = evidence();
  input.returned.screenshot.ocr.texts = ['通过链接接收', '接收 发送 设置'];
  assert.equal(evaluateOracle(input).verdict, 'passed');
});
