'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identityFor, resultFor } = require('../test-support/android-install-fixture');
const { uiaXml } = require('../test-support/uia-target-fixture');
const { createInstallIntent, installerDeviceAdapter, inspectApk, installedIdentity } = require('../bin/intent/install-intent');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { getProcessDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { createCommandRouter } = require('../bin/command-router');
const { validateCommandArguments, commandContract } = require('../bin/command-registry');

const artifact = { path: '/private/verified.apk', packageName: 'example.installed', versionName: '2', versionCode: '12', certificates: ['a'.repeat(64)], sha256: 'b'.repeat(64), bytes: 42 };
const success = { code: 0, stdout: 'Success\n', stderr: '', dispatched: true, startedAtMs: 10, completedAtMs: 20 };
const present = { known: true, installed: true, identityMatches: true, sha256: artifact.sha256 };
const terminal = async workflow => {
  for (let i = 0; i < 100 && !workflow.isFinished(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(workflow.isFinished(), true); return workflow.status();
};

async function fixture(t, options = {}) {
  const serial = `install-${Math.random()}`;
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  let done; let jobs = 0; let releases = 0; let queries = 0; let pkg = 'vendor.dynamic';
  const calls = [];
  const label = 'Proceed with version 2 — continuar';
  const ports = {
    createBridgeContext: value => value,
    foregroundWindow: async () => ({ ok: true, packageName: pkg, component: `${pkg}/.Screen`, activity: '.Screen', source: 'test' }),
    uiaTreeOnce: async () => uiaXml(`<hierarchy><node package="${pkg}" class="FrameLayout" bounds="[0,0][400,800]"><node package="${pkg}" text="${label}" resource-id="${pkg}:id/next" enabled="true" clickable="true" bounds="[20,100][380,180]"/></node></hierarchy>`),
    uiaTap: async (ctx, binding) => { calls.push({ packageName: ctx.packageName, actionId: ctx.runtimeActionId, binding }); return { ok: true }; },
    tap: async () => assert.fail('Installer text choices must use a bound UIA node'),
  };
  const identity = identityFor(artifact, `${serial}:install`, { adb: 'adb', serial });
  const job = { identity, done: new Promise(resolve => { done = value => resolve(resultFor(identity, value)); }),
    start() { jobs++; return job.done; }, status: () => ({ identity }),
    cancel() { done({ code: null, cancelled: true }); return job.done; }, acknowledge: async () => ({ ok: true }) };
  const workflow = await createInstallIntent({ args: { serial }, operationId: serial, store, dependencies: {
    prepareApk: async () => ({ artifact, release: () => { releases++; } }),
    adapter: installerDeviceAdapter({ serial }, ports),
    installedIdentity: async () => { queries++; if (queries === 1) await options.before?.(); return queries === 1 ? present : (options.after || present); },
    prepareJob: async () => job,
  } });
  t.after(async () => { if (!workflow.isFinished()) await workflow.cancel(); });
  return { serial, store, workflow, calls, label, finish: done, get jobs() { return jobs; }, get queries() { return queries; }, get releases() { return releases; }, setForeground(value) { pkg = value; } };
}

test('install starts an Intent operation and routes its controls through the existing entry', async () => {
  const seen = [];
  const router = createCommandRouter({ loadIntent: () => ({ handle: args => { seen.push(args); return { ok: true, command: 'intent', operationId: 'install' }; } }), dispatchCommon: () => assert.fail('install must not reach the primitive dispatcher') });
  const args = { serial: 'device', apkPath: '/app.apk' };
  const result = await router.route('install-apk', args);
  assert.equal(result.value.operationId, 'install');
  assert.deepEqual(seen[0].install, args);
  assert.equal(commandContract('install-apk').role, 'execution');
  assert.deepEqual(commandContract('install-apk').entrypoints, { mcp: true, cli: true, script: false });
  for (const field of ['installerTimeoutMs', 'installTimeoutMs', 'buttonText', 'requestId', 'streaming']) {
    assert.throws(() => validateCommandArguments('install-apk', { ...args, [field]: 10 }), error => error.code === 'unsupported_argument');
  }
});

test('cancel before installation start releases ownership without submitting an APK', async t => {
  const h = await fixture(t);
  const state = await h.workflow.cancel();
  assert.equal(state.status, 'cancelled'); assert.equal(h.jobs, 0); assert.equal(h.releases, 1);
  assert.equal(getProcessDeviceMutationLease().status(h.serial).active, 0);
  const receipt = h.store.latest(h.serial, 'action-receipt');
  assert.equal(receipt.dispatched, false); assert.equal(receipt.ambiguous, false);
  assert.equal((await h.workflow.start()).error, 'operation_stopped'); assert.equal(h.jobs, 0);
});

test('cancel drains the initial installed-identity query and prevents a late install submission', { timeout: 3000 }, async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { before: async () => { entered(); await gate; } });
  const starting = h.workflow.start(); await ready;
  let settled = false;
  const cancelling = h.workflow.cancel().then(state => { settled = true; return state; });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    assert.equal(h.jobs, 0); assert.equal(h.releases, 0);
  } finally { release(); }
  await starting;
  assert.equal((await cancelling).status, 'cancelled'); assert.equal(h.jobs, 0); assert.equal(h.releases, 1);
  assert.equal(h.store.list(h.serial).some(record => record.kind === 'dispatch-marker'), false);
  assert.equal(h.store.latest(h.serial, 'action-receipt').dispatched, false);
});

test('an unknown installer language/package is observed; only a revision-bound Agent decision dispatches', async t => {
  const h = await fixture(t);
  const started = await h.workflow.start();
  assert.equal(started.ok, true); assert.equal(started.command, 'intent'); assert.equal(started.status, 'waiting_for_observation');
  assert.equal(h.jobs, 1); assert.equal(h.queries, 1); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.store.list(h.serial).map(x => x.kind), ['plan', 'dispatch-marker']);
  const lease = getProcessDeviceMutationLease();
  assert.equal(lease.acquire(h.serial).error, 'target_busy');
  const observed = await h.workflow.observe();
  assert.equal(observed.summary.nodes.some(node => node.text === h.label), true);
  assert.equal(h.calls.length, 0, 'observation must not infer a hard-coded positive button');
  assert.equal((await h.workflow.decide({ decisionId: 'force-pass', agentDecision: 'complete' })).error, 'installation_requires_package_verification');
  assert.equal((await h.workflow.decide({ decisionId: 'stale', basedOnRevision: observed.revision - 1, agentDecision: 'act', action: { action: 'tap', selector: { text: h.label } } })).error, 'reobserve_required');
  assert.equal(h.calls.length, 0);
  const acted = await h.workflow.decide({ decisionId: 'observed-choice', basedOnRevision: observed.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: h.label } } });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].packageName, 'vendor.dynamic');
  assert.equal(h.calls[0].actionId, `${h.serial}:observed-choice`);
  assert.deepEqual(h.calls[0].binding.target.selector, { kind: 'text', value: h.label, exact: true, packageName: 'vendor.dynamic' });
  assert.equal(lease.acquire(h.serial).error, 'target_busy', 'nested Intent action must not release installation ownership');
  h.finish(success);
  const ended = await terminal(h.workflow);
  assert.equal(ended.status, 'completed'); assert.equal(ended.installation.verified, true); assert.equal(h.queries, 2);
  assert.equal(h.releases, 1); assert.equal(lease.status(h.serial).active, 0);
  const proof = h.store.read(ended.installation.verificationEvidenceId);
  assert.equal(proof.ok, true); assert.equal(proof.record.payloadSummary.installation.after.sha256, artifact.sha256);
  const action = h.store.latest(h.serial, 'action-receipt');
  assert.equal(action.settled, true); assert.deepEqual(action.executionReceipt, ended.installation.process.executionReceipt);
});

test('foreground change cannot reuse coordinates from the previously observed installer', async t => {
  const h = await fixture(t); await h.workflow.start();
  const observed = await h.workflow.observe(); h.setForeground('another.window');
  const result = await h.workflow.decide({ decisionId: 'moved', basedOnRevision: observed.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: h.label } } });
  assert.equal(result.error, 'reobserve_required'); assert.equal(h.calls.length, 0);
  const next = await h.workflow.observe(); assert.equal(next.summary.foreground.packageName, 'another.window');
});

test('ADB success cannot pass when the installed bytes differ, or when verification is unavailable', async t => {
  for (const after of [{ ...present, identityMatches: false, sha256: 'c'.repeat(64) }, { known: false, installed: null, identityMatches: false }]) {
    const h = await fixture(t, { after }); await h.workflow.start(); h.finish(success);
    const ended = await terminal(h.workflow);
    assert.equal(ended.status, after.known ? 'failed' : 'ambiguous');
    assert.equal(ended.installation.verified, false); assert.equal(ended.installation.requestSucceeded, true);
  }
});

test('an already installed matching APK cannot turn a failed, timed-out or cancelled request into success', async t => {
  for (const result of [{ ...success, code: 1, stdout: '' }, { ...success, code: null, timedOut: true }]) {
    const h = await fixture(t); await h.workflow.start(); h.finish(result);
    const ended = await terminal(h.workflow);
    assert.equal(ended.status, result.timedOut ? 'timeout' : 'ambiguous');
    assert.equal(ended.installation.after.identityMatches, true); assert.equal(ended.installation.verified, false);
  }
  const h = await fixture(t); await h.workflow.start();
  const ended = await h.workflow.cancel();
  assert.equal(ended.status, 'cancelled'); assert.equal(h.workflow.isFinished(), true);
  assert.equal(h.queries, 2); assert.equal(h.calls.length, 0); assert.equal(h.releases, 1);
  const ownership = getProcessDeviceMutationLease().status(h.serial);
  assert.equal(ownership.phase, 'unresolved');
  assert.equal(ownership.ownership.reservations[0].actionId, `${h.serial}:install`);
});

test('an uncommitted dispatch marker stops installation before spawning ADB', async t => {
  const h = await fixture(t);
  const persist = h.store.persist;
  h.store.persist = (kind, record) => kind === 'dispatch-marker' ? Promise.resolve({ ok: false, error: 'disk_full' }) : persist(kind, record);
  await assert.rejects(h.workflow.start(), error => error.code === 'disk_full');
  assert.equal(h.jobs, 0); assert.equal(h.releases, 1); assert.equal(getProcessDeviceMutationLease().status(h.serial).active, 0);
});

test('package identity reads actual device APK bytes and distinguishes absence from disconnection', async () => {
  const calls = [];
  const query = async (_file, args) => { calls.push(args); return { stdout: args.includes('path') ? 'package:/data/app/hash/example/base.apk\n' : `${artifact.sha256}  /data/app/hash/example/base.apk\n` }; };
  assert.equal((await installedIdentity({ serial: 'device' }, artifact, query)).identityMatches, true);
  assert.deepEqual(calls[1].slice(0, 5), ['-s', 'device', 'shell', 'sh', '-c']);
  assert(calls[1][5].includes('aab_sha256sum'));
  assert(calls[1][5].includes('/data/app/hash/example/base.apk'));
  const absent = await installedIdentity({ serial: 'device' }, artifact, async () => { throw { code: 1, stdout: '', stderr: '' }; });
  assert.deepEqual(absent, { known: true, installed: false, identityMatches: false });
  const offline = await installedIdentity({ serial: 'device' }, artifact, async () => { throw { code: 1, stderr: 'device offline' }; });
  assert.equal(offline.known, false); assert.equal(offline.installed, null);
});

test('APK manifest and signer are inspected before accepting a supplied package name', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-inspector-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.apk'); fs.writeFileSync(file, 'controlled inspector fixture');
  const args = { apkPath: file, aaptPath: 'controlled-aapt', apksignerPath: 'controlled-apksigner' };
  const run = async name => ({ stdout: name.endsWith('aapt') ? "package: name='example.installed' versionCode='12' versionName='2'\n" : `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}\n` });
  const result = await inspectApk(args, run); assert.equal(result.versionCode, '12'); assert.equal(result.certificates[0], 'a'.repeat(64));
  for (const signer of ['V1 Signer:', 'V2 Signer:', 'V3 Signer:', 'V3.0 Signer:', 'V3.1 Signer:', 'V4 Signer:']) {
    const sdk37 = await inspectApk(args, async name => name.endsWith('aapt') ? run(name)
      : { stdout: `${signer} certificate SHA-256 digest: ${'b'.repeat(64)}\n` });
    assert.deepEqual(sdk37.certificates, ['b'.repeat(64)]);
  }
  await assert.rejects(inspectApk(args, async name => name.endsWith('aapt') ? run(name)
    : { stdout: `V3.2 Signer: certificate SHA-256 digest: ${'b'.repeat(64)}\n` }), { code: 'invalid_apk' });
  await assert.rejects(inspectApk({ ...args, packageName: 'wrong.package' }, run), error => error.code === 'apk_package_mismatch');
  await assert.rejects(inspectApk(args, async () => { throw new Error('invalid signature'); }), error => error.code === 'invalid_apk');
});

test('a PackageInstaller terminal rejection settles ownership but cannot verify the old matching APK', async t => {
  const h = await fixture(t); await h.workflow.start();
  h.finish({ code: 1, stdout: 'Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]\n' });
  const ended = await terminal(h.workflow);
  assert.equal(ended.status, 'failed'); assert.equal(ended.error, 'package_install_failed');
  assert.equal(ended.installation.after.identityMatches, true); assert.equal(ended.installation.verified, false);
  assert.equal(ended.installation.process.executionReceipt.sessionId, 42);
  assert.equal(getProcessDeviceMutationLease().status(h.serial).phase, 'idle');
});

test('ownership persistence failure releases the inspected private APK without preparing a phone job', async () => {
  let releases = 0;
  await assert.rejects(createInstallIntent({ args: { serial: 'phone' }, operationId: 'storage-failure', dependencies: {
    prepareApk: async () => ({ artifact, release() { releases++; } }),
    lease: { acquire() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } },
    prepareJob: () => assert.fail('A phone job must not be prepared'),
  } }), { code: 'ENOSPC' });
  assert.equal(releases, 1);
});
