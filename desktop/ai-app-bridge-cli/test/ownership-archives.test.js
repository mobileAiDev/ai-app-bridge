'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createOwnershipStore, schemaVersion } = require('../bin/shared-kernel/device-ownership-store');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { deviceOwnership } = require('../bin/shared-kernel/device-ownership-recovery');
const { createArchiveStore } = require('../bin/shared-kernel/ownership-archives');
const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
const { validateCommandArguments, isMutationCommand } = require('../bin/command-registry');
const shell = require('../bin/shared-kernel/android-shell-execution');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-archive-test-'));
  const owners = [];
  t.after(() => { for (const owner of owners) owner.release(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = createOwnershipStore(directory), lease = createDeviceMutationLease({ directory });
  const archives = createArchiveStore(directory), serial = 'archive-phone';
  const pending = (kind = 'native', actionId = randomUUID()) => ({ id: randomUUID(), kind, actionId,
    runtimeEpoch: randomUUID(), target: { serial, packageName: 'example.app', adb: '/unused-adb' } });
  const save = (entry = pending(), targetSerial = serial) => {
    store.write(targetSerial, { schemaVersion, serial: targetSerial, phase: 'unresolved', owner: null,
      pending: entry, reservations: [], pendingAcknowledgements: [] });
    return { ...store.archive(targetSerial), entry };
  };
  const args = (operation, more = {}) => ({ operation, serial, ...more });
  const hold = () => { const owner = lease.acquire(serial); owners.push(owner); return owner; };
  return { directory, store, archives, lease, serial, pending, save, args, hold };
}

test('archive pages and action filters retain every original record while another action owns the device', async t => {
  const f = fixture(t), ids = [];
  for (let i = 0; i < 37; i++) ids.push(f.save(f.pending('native', `action-${i}`)).archiveId);
  f.hold();
  ids.push(f.lease.status(f.serial).ownership.lastUnknown.archiveId);
  const before = fs.readFileSync(f.store.paths(f.serial).journal), seen = [];
  let cursor;
  do {
    const args = f.args('archives', { limit: 7, ...(cursor ? { cursor } : {}) });
    validateCommandArguments('device-ownership', args);
    const page = await deviceOwnership(args, { lease: f.lease });
    seen.push(...page.items.map(item => item.archiveId)); cursor = page.nextCursor;
    for (const item of page.items) validateCommandArguments(item.read.command, item.read.arguments);
  } while (cursor);
  assert.deepEqual(seen, ids.sort());
  const filtered = await f.archives.handle(f.args('archives', { actionId: 'action-3' }));
  assert.equal(filtered.items.length, 1); assert.equal(filtered.items[0].entries[0].actionId, 'action-3');
  const full = await f.archives.handle(filtered.items[0].read.arguments);
  assert.equal(full.journal.pending.actionId, 'action-3'); assert.equal(full.outcome, 'unknown');
  assert.deepEqual(fs.readFileSync(f.store.paths(f.serial).journal), before);
  assert.equal(f.lease.status(f.serial).active, 1);
});

test('original shell reconciliation queries once, persists its proof and never cancels or changes current ownership', async t => {
  const f = fixture(t), entry = { ...f.pending('android-shell'), schemaVersion: shell.schema,
    jobId: randomUUID(), commandSha256: 'a'.repeat(64), deadlineUptimeMs: 1000 };
  const archive = f.save(entry), bytes = fs.readFileSync(archive.archivePath);
  f.hold();
  const current = fs.readFileSync(f.store.paths(f.serial).journal); let queries = 0;
  const dependencies = { lease: f.lease, shellPortFactory: () => ({
    query: async identity => { queries++; assert.equal(identity.actionId, entry.actionId);
      return { ...entry, ok: true, settled: true, dispatched: true, ambiguous: false, exitCode: 7 }; },
    cancel: () => assert.fail('archive query cancelled an action'), acknowledge: () => assert.fail('archive query retired evidence'),
  }) };
  const args = f.args('reconcile-archive', { archiveId: archive.archiveId, entryId: entry.id });
  validateCommandArguments('device-ownership', args);
  const result = await deviceOwnership(args, dependencies);
  assert.equal(result.ok, true); assert.equal(result.result.exitCode, 7); assert.equal(result.result.settled, true);
  const saved = await createArchiveStore(f.directory).handle(f.args('archive', { archiveId: archive.archiveId }));
  assert.equal(saved.reconciliation.results[entry.id].exitCode, 7);
  assert.equal((await deviceOwnership(args, dependencies)).cached, true); assert.equal(queries, 1);
  assert.deepEqual(fs.readFileSync(archive.archivePath), bytes);
  assert.deepEqual(fs.readFileSync(f.store.paths(f.serial).journal), current);
  assert.equal(f.lease.status(f.serial).active, 1);
});

test('Native archive queries use original identities without cancellation and retain unsupported or unknown outcomes', async t => {
  const f = fixture(t), archive = f.save(), args = f.args('reconcile-archive', { archiveId: archive.archiveId, entryId: archive.entry.id });
  let calls = 0;
  const ports = { createBridgeContext: value => value, nativeCompletion: async (ctx, identity, options) => {
    calls++; assert.equal(ctx.serial, f.serial); assert.equal(identity.actionId, archive.entry.actionId);
    assert.equal(options.cancel, false);
    return { ok: false, error: calls === 1 ? 'completion_query_unavailable' : 'native_action_pending', message: 'Original action has not settled.' };
  } };
  const first = await deviceOwnership(args, { lease: f.lease, ports });
  assert.equal(first.result.settled, false); assert.equal(first.result.error, 'completion_query_unavailable');
  const second = await deviceOwnership(args, { lease: f.lease, ports });
  assert.equal(second.result.settled, false); assert.equal(calls, 2);
});

test('install and UIA archive reads never request cancellation or retire the original receipt', async t => {
  const f = fixture(t), { identityFor, resultFor } = require('../test-support/android-install-fixture');
  const install = { ...f.pending('android-install'), ...identityFor({ packageName: 'example.app', sha256: 'a'.repeat(64), bytes: 128, path: '/unused.apk' }, 'install-original', { adb: '/unused-adb', serial: f.serial }) };
  const archivedInstall = f.save(install); let installReads = 0;
  const installed = await deviceOwnership(f.args('reconcile-archive', { archiveId: archivedInstall.archiveId, entryId: install.id }), {
    lease: f.lease, installPortFactory: () => ({ read: async (identity, cancel) => {
      installReads++; assert.equal(cancel, false); return resultFor(identity);
    }, acknowledge: () => assert.fail('retired install receipt'), cancelInstall: () => assert.fail('cancelled install') }),
  });
  assert.equal(installed.result.requestSucceeded, true); assert.equal(installReads, 1);
  const protocol = require('../bin/shared-kernel/uia-protocol');
  const { request, requestJson, requestSha256 } = protocol.actionRequest({ bootId: randomUUID(), runtimeEpoch: randomUUID(),
    target: { snapshotId: randomUUID(), ref: randomUUID(), selector: { kind: 'text', value: 'Agree', exact: true, packageName: 'example.app' } } },
  { actionId: 'uia-original', timeoutMs: 1000 });
  const uia = { ...f.pending('uia-node'), schemaVersion: protocol.schema, bootId: request.bootId,
    runtimeEpoch: request.runtimeEpoch, actionId: request.actionId, requestJson, requestSha256,
    target: { adb: '/unused-adb', serial: f.serial, root: protocol.rootDirectory,
      sessionPath: `${protocol.rootDirectory}/sessions/${request.runtimeEpoch}`, dexSha256: 'a'.repeat(64) } };
  const archivedUia = f.save(uia); let queries = 0;
  const unknown = await deviceOwnership(f.args('reconcile-archive', { archiveId: archivedUia.archiveId, entryId: uia.id }), {
    lease: f.lease, uiaPortFactory: () => ({ recover: async (_identity, options) => {
      queries++; assert.equal(options.cancel, false); return { ok: false, settled: false, error: 'uia_original_completion_unavailable' };
    }, acknowledge: () => assert.fail('retired UIA receipt') }),
  });
  assert.equal(unknown.result.settled, false); assert.equal(queries, 1);
});

test('the actual Android SDK recovery port uses read-only HTTP query and explains an older SDK without calling cancel', async t => {
  const f = fixture(t), http = require('node:http');
  const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
  const { nativeRuntimeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');
  let supported = false; const posts = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/status') {
      const status = nativeRuntimeStatus('example.app'); status.debugBridge.originalCompletionQuery = supported;
      return response.end(JSON.stringify(status));
    }
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes); posts.push(request.url);
    assert.equal(request.url, '/v1/action/query');
    response.end(JSON.stringify({ ok: true, ...body,
      executionResult: nativeExecutionReceipt({ execution: { ...body, schemaVersion: 'aab.native-execution/v1' } }) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const adb = createAdbHttpFixture({ directory: f.directory, serial: f.serial, port, foregroundPackage: 'example.app' });
  const archive = f.save({ ...f.pending(), runtimeEpoch: 'fixture-epoch', target: { serial: f.serial, packageName: 'example.app', adb, port } });
  const args = f.args('reconcile-archive', { archiveId: archive.archiveId, entryId: archive.entry.id });
  const old = await deviceOwnership(args, { lease: f.lease });
  assert.equal(old.result.error, 'completion_query_unavailable'); assert.match(old.result.message, /Update/); assert.deepEqual(posts, []);
  supported = true;
  const current = await deviceOwnership(args, { lease: f.lease });
  assert.equal(current.result.settled, true); assert.equal(current.result.actionId, archive.entry.actionId);
  assert.deepEqual(posts, ['/v1/action/query']);
});

test('force-stopped corrupt bytes remain discoverable after a new current journal, and deletion is confined to the chosen archive', async t => {
  const f = fixture(t), retained = f.save();
  fs.writeFileSync(f.store.paths(f.serial).journal, 'invalid original bytes');
  const reset = await forceStopDevice(f.args('force-stop'), { directory: f.directory, runtimeEndpoint: null,
    stopHost: async () => [], stopDevice: async () => ({ ok: true }) });
  assert.equal(reset.ok, true);
  f.save(f.pending('native', 'new-action'));
  const before = fs.readFileSync(f.store.paths(f.serial).journal);
  const read = await f.archives.handle(f.args('archive', { archiveId: reset.archiveId }));
  assert.equal(read.rawText, 'invalid original bytes'); assert.ok(read.parseError);
  assert.ok((await f.archives.handle(f.args('archives'))).items.some(item => item.archiveId === reset.archiveId));
  const deleted = await f.archives.handle(f.args('delete-archive', { archiveId: reset.archiveId }));
  assert.equal(deleted.deleted, true); assert.equal(fs.existsSync(reset.archivePath), false);
  assert.equal(fs.existsSync(retained.archivePath), true);
  assert.deepEqual(fs.readFileSync(f.store.paths(f.serial).journal), before);
  await assert.rejects(f.archives.handle(f.args('archive', { archiveId: reset.archiveId })), { code: 'ownership_archive_not_found' });
});

test('an oversized corrupt archive does not hide other records and still has an explicit deletion path', async t => {
  const f = fixture(t), good = f.save(), oversized = f.save();
  fs.writeFileSync(oversized.archivePath, 'x'.repeat(4 * 1024 * 1024 + 1));
  const page = await f.archives.handle(f.args('archives'));
  assert.ok(page.items.some(item => item.archiveId === good.archiveId && !item.error));
  assert.equal(page.items.find(item => item.archiveId === oversized.archiveId).error, 'ownership_archive_too_large');
  assert.equal((await f.archives.handle(f.args('delete-archive', { archiveId: oversized.archiveId }))).deleted, true);
  assert.equal(fs.existsSync(good.archivePath), true);
});

test('archive IDs cannot escape their source directory, and public CLI/MCP archive reads do not start a Runtime', async t => {
  const f = fixture(t), archive = f.save();
  for (const archiveId of ['../../other', 'unresolved:../../other', `force-stopped:${randomUUID()}/../x`])
    assert.throws(() => validateCommandArguments('device-ownership', f.args('archive', { archiveId })));
  assert.equal(isMutationCommand('device-ownership', f.args('delete-archive')), true);
  assert.equal(isMutationCommand('device-ownership', f.args('reconcile-archive')), false);
  const env = { ...process.env, ADB: '/unavailable-adb', AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: f.directory,
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(f.directory, 'runtime'), AI_APP_BRIDGE_FACT_STORE_DIR: path.join(f.directory, 'facts') };
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/ai-app-bridge.js'), 'device-ownership',
    '--operation', 'archive', '--serial', f.serial, '--archive-id', archive.archiveId, '--extract', '{"mode":"select","path":"/journal/pending/actionId"}'],
  { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout); assert.equal(JSON.parse(cli.stdout).value, archive.entry.actionId);
  const { createMcpClient } = require('../scripts/validation/mcp-jsonrpc-client');
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'), env,
    transcriptPath: path.join(f.directory, 'mcp.jsonl'), stderrPath: path.join(f.directory, 'mcp.stderr') });
  try {
    await client.initialize();
    const result = await client.request('tools/call', { name: 'run', arguments: { command: 'device-ownership', arguments: f.args('archives') } });
    assert.equal(JSON.parse(result.result.content[0].text).value.items.length, 1);
  } finally { await client.close({ stopRuntime: false }); }
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_RUNTIME_HOME), false);
});
