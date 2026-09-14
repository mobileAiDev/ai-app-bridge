'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getHostFactStore } = require('./shared-kernel/host-fact-store');

const initializationFailure = 'The test runner failed to initialize for UI testing. (Underlying Error: Timed out while enabling automation mode.)';
const digest = value => createHash('sha256').update(value).digest('hex');

function initializationProof(summary, invocation, deviceId, completedAtMs = Date.now()) {
  const args = invocation?.arguments;
  if (!Array.isArray(args) || args[args.indexOf('-destination') + 1] !== `id=${deviceId}`
      || args[args.indexOf('-scheme') + 1] !== 'WebDriverAgentRunner' || !args.includes('test-without-building')
      || summary?.result !== 'Failed' || summary.totalTestCount !== 1 || summary.failedTests !== 1
      || summary.passedTests !== 0 || summary.skippedTests !== 0 || summary.expectedFailures !== 0
      || summary.devicesAndConfigurations?.length !== 1 || summary.devicesAndConfigurations[0].device?.deviceId !== deviceId
      || summary.testFailures?.length !== 1 || summary.testFailures[0].targetName !== 'WebDriverAgentRunner'
      || summary.testFailures[0].failureText !== initializationFailure
      || !Number.isFinite(summary.startTime) || !Number.isFinite(summary.finishTime)
      || summary.startTime * 1000 < invocation.startedAtMs || summary.finishTime < summary.startTime
      || summary.finishTime * 1000 > completedAtMs) return null;
  return { kind: 'ios-wda-start', settled: true, dispatched: true, ambiguous: false, invocation,
    outcome: { ok: false, error: 'ios_wda_automation_confirmation_required', settled: true, dispatched: true, ambiguous: false,
      message: 'XCTest ended before UI test initialization completed. Confirm Enable UI Automation on the iPhone, then explicitly run ios-setup again.' },
    summary, summarySha256: digest(JSON.stringify(summary)) };
}

// Old setup markers lack a test invocation. Recovery requires the original
// public response AND its retained Host action, not a newly supplied exit code.
async function recoverLegacySetup({ pending, owner, resultPath, device, readSummary, readAction }) {
  if (pending.command !== 'ios-setup' || pending.invocation || !resultPath) return null;
  const bytes = await fs.promises.readFile(resultPath);
  if (bytes.length > 4 * 1024 * 1024) return null;
  const envelope = JSON.parse(bytes.toString('utf8'));
  const result = envelope.kind === 'json' ? envelope.value : envelope;
  const feedback = result?._feedback, times = feedback?.timings;
  const evidence = feedback?.evidence?.filter(item => item.partition === 'action' && item.stored === true);
  const steps = result?.steps?.filter(item => item.name === 'start-wda');
  if (result?.error !== 'ios_wda_xcodebuild_exited' || result.device?.udid !== device.udid
      || feedback?.dispatch?.command !== 'ios-setup' || feedback.target?.bundleId !== pending.target.bundleId
      || evidence?.length !== 1 || !evidence[0].actionId?.startsWith(`host-action-${owner?.pid}-`)
      || !Number.isSafeInteger(times?.startedAtMs) || !Number.isSafeInteger(times?.completedAtMs)
      || times.startedAtMs > owner.acquiredAtMs || owner.acquiredAtMs > pending.preparedAtMs
      || pending.preparedAtMs > times.completedAtMs || steps?.length !== 1
      || steps[0].phase !== 'device-test' || steps[0].exitCode !== 65) return null;
  const page = (readAction || (actionId => getHostFactStore().read({ partitions: ['action'], actionId, limit: 2 })))(evidence[0].actionId);
  const fact = page.items?.[0];
  if (page.ok !== true || page.items?.length !== 1 || fact.globalSeq !== evidence[0].globalSeq
      || fact.payload?.command !== 'ios-setup' || fact.payload.status !== 'failed' || fact.payload.args?.startWda !== true
      || fact.payload.args.deviceId !== result.device.identifier || fact.payload.args.bundleId !== pending.target.bundleId
      || fact.payload.result?.error !== result.error || fact.timestamps?.occurredAtMs !== times.startedAtMs
      || fact.timestamps.observedAtMs !== times.completedAtMs) return null;
  const project = steps[0].prepared?.projectPath;
  if (typeof project !== 'string' || path.basename(project) !== 'WebDriverAgent.xcodeproj') return null;
  const directory = path.dirname(path.dirname(project));
  if (steps[0].logFile !== path.join(directory, 'xcodebuild.log')) return null;
  const resultsDirectory = path.join(directory, 'build', 'Logs', 'Test');
  const bundles = (await fs.promises.readdir(resultsDirectory)).filter(name => name.endsWith('.xcresult'));
  if (bundles.length !== 1) return null;
  const invocation = { arguments: ['-project', project, '-scheme', 'WebDriverAgentRunner', '-destination', `id=${device.udid}`, 'test-without-building'],
    resultBundlePath: path.join(resultsDirectory, bundles[0]), startedAtMs: pending.preparedAtMs };
  const proof = initializationProof(await readSummary(invocation.resultBundlePath), invocation, device.udid, times.completedAtMs);
  return proof && { ...proof, originalSetup: { pendingId: pending.id, actionId: fact.actionId,
    globalSeq: fact.globalSeq, resultPath: path.resolve(resultPath), responseSha256: digest(bytes) } };
}

module.exports = { initializationProof, recoverLegacySetup };
