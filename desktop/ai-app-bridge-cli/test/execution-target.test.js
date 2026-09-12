'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExecutionTarget, bindCommandTarget, targetIdentity, targetFingerprint } = require('../bin/shared-kernel/execution-target');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const intent = require('../bin/intent/intent-entry');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createFactStore } = require('../bin/fact-store');
const { createSegmentedEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const archive = require('../bin/shared-kernel/evidence-archive');

const android = { platform: 'android', serial: 'target-contract-phone', packageName: 'com.example.app', adb: '/test/adb', port: 40123 };
const ios = { platform: 'ios', deviceId: 'ios-target-contract', bundleId: 'com.example.app', runtimeUrl: 'http://127.0.0.1:40234', wdaUrl: 'http://127.0.0.1:40235' };
const source = 'module.exports.main = async () => ({ ok: true });';

test('relative transport executables in frozen targets stay bound to the originating request directory', () => {
  const { inRequestDirectory } = require('../bin/shared-kernel/request-context');
  const compiled = inRequestDirectory('/original/task', () => compileScriptSpec({
    schemaVersion: 'aab.code-script/v1', language: 'javascript', source,
    target: { ...android, adb: './tools/adb' },
  }));
  assert.equal(compiled.ok, true);
  assert.equal(compiled.spec.target.adb, '/original/task/tools/adb');
  inRequestDirectory('/another/client', () => {
    assert.equal(bindCommandTarget('tap-text', { targetText: 'Save' }, compiled.spec.target).args.adb, '/original/task/tools/adb');
  });
});

test('explicit platform targets preserve all declared identity and connection fields in the Script hash', () => {
  for (const target of [android, ios, { platform: 'web', sessionId: 'session', runtimeEpoch: 'document-1', targetId: 'page' }]) {
    const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript', source, target });
    assert.equal(compiled.ok, true, JSON.stringify(compiled));
    assert.deepEqual(compiled.spec.target, target);
    const changed = { ...target, [target.platform === 'android' ? 'port' : target.platform === 'ios' ? 'wdaUrl' : 'targetId']: target.platform === 'android' ? 40124 : 'http://localhost/changed' };
    const second = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript', source, target: changed });
    assert.equal(second.ok, true);
    assert.notEqual(compiled.hash, second.hash);
  }
});

test('missing platform and mixed-platform fields fail without silent Android normalization', () => {
  for (const target of [{ serial: 's', packageName: 'pkg' }, { ...android, deviceId: 'ios' }, { ...ios, serial: 'android' }, { platform: 'ios', bundleId: 'com.app' }, { platform: 'web', serial: 's' }]) {
    assert.throws(() => normalizeExecutionTarget(target));
  }
  assert.throws(() => normalizeExecutionTarget({ ...ios, iosPort: 1234 }), { code: 'target_connection_conflict' });
  assert.throws(() => normalizeExecutionTarget({ ...ios, runtimeUrl: 'file:///tmp/wrong' }), { code: 'invalid_target_url' });
  assert.equal(compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript', source }).spec.target, null);
});

test('target snapshots are immutable and app identity is separate from connection fingerprints', () => {
  const input = { ...android, foregroundPackages: ['com.android.settings'] };
  const frozen = normalizeExecutionTarget(input, { intent: true });
  input.serial = 'changed'; input.foregroundPackages.push('com.other');
  assert.equal(frozen.serial, android.serial);
  assert.deepEqual(frozen.foregroundPackages, ['com.android.settings']);
  assert.equal(Object.isFrozen(frozen.foregroundPackages), true);
  assert.equal(targetIdentity(android), targetIdentity({ ...android, port: 49999 }));
  assert.notEqual(targetFingerprint(android), targetFingerprint({ ...android, port: 49999 }));
  assert.notEqual(targetIdentity(android), targetIdentity(ios));
});

test('binding carries target transports and explicit cross-App/phone overrides into actual arguments', () => {
  const bound = bindCommandTarget('tap-text', { targetText: 'Save', packageName: 'com.example.other' }, android);
  assert.equal(bound.args.serial, android.serial); assert.equal(bound.args.port, android.port);
  assert.equal(bound.args.adb, android.adb); assert.equal(bound.args.packageName, 'com.example.other');
  assert.equal(Object.hasOwn(bound.args, 'platform'), false);
  const changed = bindCommandTarget('tap', { tapX: 1, tapY: 2 }, android, { ...android, serial: 'other-phone' });
  assert.equal(changed.args.serial, 'other-phone');
  assert.throws(() => bindCommandTarget('tap', { serial: 'conflicting' }, android, android), { code: 'target_argument_conflict' });
});

test('an incomplete cross-platform call never borrows a device identity from the default target', () => {
  assert.throws(() => bindCommandTarget('ios-events', { bundleId: ios.bundleId }, android), { code: 'target_platform_mismatch' });
  const explicit = bindCommandTarget('ios-events', { deviceId: ios.deviceId, bundleId: ios.bundleId, runtimeUrl: ios.runtimeUrl }, android);
  assert.equal(explicit.target.platform, 'ios');
  assert.equal(explicit.args.runtimeUrl, ios.runtimeUrl);
  assert.equal(Object.hasOwn(explicit.args, 'serial'), false);
  assert.equal(Object.hasOwn(explicit.args, 'adb'), false);
  const webview = bindCommandTarget('webview-console', { targetId: 'android-webview-page' }, android);
  assert.equal(webview.args.targetId, 'android-webview-page');
  assert.deepEqual(webview.target, android);
});

test('WDA session lifecycle receives only target defaults accepted by its explicit operation', () => {
  const target = { ...ios, wdaRunnerBundleId: 'sample.runner', wdaSessionId: 'old-session' };
  const { validateCommandArguments } = require('../bin/command-registry');
  for (const operation of ['status', 'create', 'close']) {
    const { args } = bindCommandTarget('ios-wda-session', { operation }, target);
    validateCommandArguments('ios-wda-session', args);
    assert.equal(args.bundleId, operation === 'status' ? undefined : target.bundleId);
    assert.equal(args.wdaSessionId, operation === 'close' ? target.wdaSessionId : undefined);
    assert.equal(args.wdaRunnerBundleId, target.wdaRunnerBundleId);
  }
  const explicitConflict = bindCommandTarget('ios-wda-session', { operation: 'create', wdaSessionId: 'explicitly-wrong' }, target);
  assert.throws(() => validateCommandArguments('ios-wda-session', explicitConflict.args), 'explicit wrong arguments are never silently removed');
});

test('Script call result records its actual complete target and serial-scoped action identity', async () => {
  let received;
  const host = createScriptHostPort({ target: android, executionId: 'target-contract-script',
    actions: async (command, args) => { received = args; return { ok: true, dispatched: true, ambiguous: false }; } });
  const result = await host.call('tap-text', { targetText: 'Save' }, { target: { ...android, serial: 'target-contract-other', packageName: 'com.example.other' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(received.serial, 'target-contract-other'); assert.equal(received.adb, android.adb);
  assert.equal(result.execution.target.serial, received.serial);
  assert.equal(result.execution.target.packageName, received.packageName);
  assert.equal(result.execution.target.platform, 'android');
  assert.equal(received.requestId, result.execution.actionId);
});

test('native iOS requires an explicit WDA session before creating an Intent or contacting an adapter', async () => {
  let contacted = false;
  const result = await intent.handle({ operation: 'start', goal: 'observe app', target: ios,
    adapter: { observe: async () => { contacted = true; return { ok: true }; } } });
  assert.equal(result.error, 'ios_wda_session_required');
  assert.equal(result.dispatched, false); assert.equal(contacted, false);
  const host = createScriptHostPort({ target: ios, actions: async () => { contacted = true; } });
  assert.equal((await host.call('web-click', { selector: '#save' })).error, 'target_platform_mismatch');
  assert.equal(contacted, false);
});

for (const language of ['javascript', 'python']) {
  test(`${language} child binds cross-App and transport targets through dispatch, durable history and offline archive`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-platform-target-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'facts');
    const facts = createFactStore({ directory, profile: '64mb' });
    t.after(() => facts.close());
    const store = createScriptEvidenceStore({ adapter: createSegmentedEvidenceAdapter(facts) });
    const target = { ...android, serial: `target-child-${language}` };
    const actual = { ...target, packageName: 'com.example.picker', adb: '/second/adb', port: 40222 };
    const calls = [];
    const supervisor = createScriptSupervisor();
    const source = language === 'javascript'
      ? `exports.main = async ctx => ctx.call('tap-text', {targetText:'Save'}, {target:ctx.inputs.target});`
      : `def main(ctx):\n    return ctx.call('tap-text', {'targetText':'Save'}, {'target':ctx.inputs['target']})\n`;
    const started = await supervisor.handle({ operation: 'start', store, recordingDir: path.join(root, 'recording'),
      script: { schemaVersion: 'aab.code-script/v1', language, source, target, inputs: { target: actual } },
      actions: async (command, args) => { calls.push({ command, args }); return { ok: true, dispatched: true, ambiguous: false }; },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    await supervisor.registry.get(started.operationId).running;
    const state = supervisor.handle({ operation: 'status', operationId: started.operationId, limit: 100 });
    assert.equal(state.status, 'completed', JSON.stringify(state));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.serial, actual.serial);
    assert.equal(calls[0].args.packageName, actual.packageName);
    assert.equal(calls[0].args.adb, actual.adb);
    assert.equal(calls[0].args.port, actual.port);
    const result = supervisor.handle({ operation: 'result', operationId: started.operationId }).result;
    assert.deepEqual(result.execution.target, actual);
    assert.equal(result.execution.actionId, calls[0].args.requestId);
    for (const row of state.history.items.filter(row => ['call_started', 'call_completed', 'action_receipt'].includes(row.kind))) {
      assert.deepEqual(row.target, actual);
    }
    const marker = store.latest(started.operationId, 'dispatch-marker');
    const receipt = store.latest(started.operationId, 'action-receipt');
    assert.deepEqual(marker.target, actual);
    assert.deepEqual(receipt.target, actual);
    assert.equal(marker.actionId, receipt.actionId);
    assert.equal(receipt.actionId, result.execution.actionId);
    const exported = await archive.handle({ operation: 'export', namespace: 'script', operationId: started.operationId,
      outputDir: path.join(root, 'archive'), includeRecordedPayloads: true }, { getFactStore: () => facts });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.recordedPayloads.counts.scriptCalls, 1);
    facts.close();
    // A new process reads the original committed facts after the writer closes.
    const cold = JSON.parse(execFileSync(process.execPath, ['-e', `
      const {createFactStore}=require('./bin/fact-store');
      const {createSegmentedEvidenceAdapter}=require('./bin/shared-kernel/evidence-adapters');
      const {createScriptEvidenceStore}=require('./bin/script/script-evidence-store');
      const facts=createFactStore({directory:process.argv[1],profile:'64mb'});
      try { const store=createScriptEvidenceStore({adapter:createSegmentedEvidenceAdapter(facts)});
        process.stdout.write(JSON.stringify(store.list(process.argv[2]).filter(r=>['dispatch-marker','action-receipt'].includes(r.kind))));
      } finally { facts.close(); }
    `, directory, started.operationId], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
    assert.equal(cold.length, 2);
    for (const row of cold) assert.deepEqual(row.target, actual);
    fs.rmSync(directory, { recursive: true });
    fs.rmSync(path.join(root, 'recording'), { recursive: true });
    assert.equal((await archive.handle({ operation: 'verify', archiveDir: exported.archiveDir,
      manifestSha256: exported.manifestSha256 })).ok, true);
  });
}
