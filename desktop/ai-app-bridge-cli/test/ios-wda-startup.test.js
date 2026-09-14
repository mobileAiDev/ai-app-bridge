'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializationProof, recoverLegacySetup } = require('../bin/ios-wda-startup');
const { reconcileIOS } = require('../bin/ios-execution');
const { createDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');

function fixture() {
  return { result: 'Failed', totalTestCount: 1, failedTests: 1, passedTests: 0, skippedTests: 0, expectedFailures: 0,
    startTime: 2, finishTime: 3, devicesAndConfigurations: [{ device: { deviceId: 'udid' } }],
    testFailures: [{ targetName: 'WebDriverAgentRunner',
      failureText: 'The test runner failed to initialize for UI testing. (Underlying Error: Timed out while enabling automation mode.)' }] };
}
const invocation = { arguments: ['-scheme', 'WebDriverAgentRunner', '-destination', 'id=udid', 'test-without-building'],
  resultBundlePath: '/original/result.xcresult', startedAtMs: 1000 };

test('only the original device pre-initialization failure is a known startup outcome', () => {
  assert.equal(initializationProof(fixture(), invocation, 'udid', 4000).settled, true);
  for (const change of [
    s => { s.devicesAndConfigurations[0].device.deviceId = 'other'; },
    s => { s.devicesAndConfigurations.push(s.devicesAndConfigurations[0]); },
    s => { s.testFailures[0].failureText = 'Test timed out after a UI action'; },
    s => { s.testFailures[0].targetName = 'OtherRunner'; },
    s => { s.passedTests = 1; }, s => { s.totalTestCount = 2; },
    s => { s.startTime = 0.5; }, s => { s.finishTime = 5; },
    s => { s.finishTime = 1; }, s => { s.result = 'Passed'; },
  ]) { const summary = fixture(); change(summary); assert.equal(initializationProof(summary, invocation, 'udid', 4000), null); }
  assert.equal(initializationProof(fixture(), { ...invocation, arguments: ['test-without-building'] }, 'udid'), null);
});

test('a new Host recovers the exact durable WDA invocation without restarting XCTest', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wda-recovery-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lease = createDeviceMutationLease({ directory });
  let starts = 0;
  await lease.run('ios:udid', () => runDeviceEffect({ kind: 'ios-wda-start', invocation,
    target: { deviceId: 'udid', bundleId: 'sample.app' } }, async () => {
    starts++; return { ok: false, dispatched: true, ambiguous: true };
  }));
  const fresh = createDeviceMutationLease({ directory });
  const recover = readWdaTestSummary => reconcileIOS({ lease: fresh, device: { udid: 'udid' },
    args: { bundleId: 'sample.app' }, readWdaTestSummary });
  assert.equal((await recover(async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); })).error, 'device_ownership_unresolved');
  const wrong = fixture(); wrong.devicesAndConfigurations[0].device.deviceId = 'other';
  assert.equal((await recover(async () => wrong)).error, 'device_ownership_unresolved');
  const result = await recover(async filename => { assert.equal(filename, invocation.resultBundlePath); return fixture(); });
  assert.equal(result.recovered, true); assert.equal(result.executionReceipt.kind, 'ios-wda-start');
  assert.equal(fresh.status('ios:udid').phase, 'idle'); assert.equal(starts, 1);
});

test('legacy setup recovery binds the public response, retained Host fact and original XCTest result', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wda-legacy-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const results = path.join(directory, 'build', 'Logs', 'Test'); fs.mkdirSync(results, { recursive: true });
  fs.mkdirSync(path.join(results, 'original.xcresult'));
  const pending = { kind: 'ios-command', command: 'ios-setup', id: 'original-pending', preparedAtMs: 1500,
    target: { deviceId: 'udid', bundleId: 'sample.app' } };
  const owner = { pid: 123, acquiredAtMs: 1200 };
  const report = { error: 'ios_wda_xcodebuild_exited', device: { udid: 'udid', identifier: 'device' },
    steps: [{ name: 'start-wda', phase: 'device-test', exitCode: 65, logFile: path.join(directory, 'xcodebuild.log'),
      prepared: { projectPath: path.join(directory, 'source', 'WebDriverAgent.xcodeproj') } }],
    _feedback: { dispatch: { command: 'ios-setup' }, target: { bundleId: 'sample.app' },
      timings: { startedAtMs: 1000, completedAtMs: 4000 },
      evidence: [{ partition: 'action', stored: true, globalSeq: 42, actionId: 'host-action-123-999-1' }] } };
  const fact = { actionId: 'host-action-123-999-1', globalSeq: 42,
    timestamps: { occurredAtMs: 1000, observedAtMs: 4000 }, payload: { command: 'ios-setup', status: 'failed',
      args: { startWda: true, deviceId: 'device', bundleId: 'sample.app' }, result: { error: report.error } } };
  const resultPath = path.join(directory, 'original.json');
  const save = value => fs.writeFileSync(resultPath, JSON.stringify({ kind: 'json', value })); save(report);
  const recover = (readAction = () => ({ ok: true, items: [fact] })) => recoverLegacySetup({ pending, owner, resultPath,
    device: { udid: 'udid' }, readSummary: async () => fixture(), readAction });
  assert.equal((await recover()).originalSetup.pendingId, pending.id);
  assert.equal(await recover(() => ({ ok: true, items: [] })), null);
  for (const change of [
    r => { r.device.udid = 'other'; }, r => { r._feedback.timings.startedAtMs = 2000; },
    r => { r._feedback.evidence[0].actionId = 'host-action-456-999-1'; },
    r => { r._feedback.evidence[0].globalSeq = 41; }, r => { r.steps[0].exitCode = null; },
    r => { r.steps[0].logFile = '/other/log'; },
  ]) { const copy = structuredClone(report); change(copy); save(copy); assert.equal(await recover(), null); }
});
