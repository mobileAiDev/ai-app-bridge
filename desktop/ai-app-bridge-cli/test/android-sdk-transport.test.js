'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { openAdbSocket } = require('../bin/shared-kernel/adb-socket-transport');
const { parseAdbServer, selectSdkTransport } = require('../bin/shared-kernel/android-adb-route');
const { httpRequestBounded } = require('../bin/shared-kernel/execution-io');
const { runExecution } = require('../bin/shared-kernel/execution-scope');

async function serverFixture(t, { handler, failure, hang } = {}) {
  const services = [], requests = [], sockets = new Set();
  const httpServer = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body });
    if (handler) return handler(request, response);
    response.end(JSON.stringify({ ok: true }));
  });
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), selections = 0;
    const read = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = parseInt(buffer.subarray(0, 4).toString(), 16);
        if (buffer.length < 4 + size) return;
        const service = buffer.subarray(4, 4 + size).toString(); buffer = buffer.subarray(4 + size);
        services.push(service); selections++;
        if (hang === selections) return;
        if (failure === selections) {
          const message = Buffer.from('selected runtime is gone');
          socket.end(Buffer.concat([Buffer.from('FAIL' + message.length.toString(16).padStart(4, '0')), message])); return;
        }
        socket.write('O'); socket.write('KAY');
        if (selections === 2) {
          socket.removeListener('data', read);
          httpServer.emit('connection', socket);
          return;
        }
      }
    };
    socket.on('data', read);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); httpServer.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { services, requests, sockets, route: { serial: 'device-A', endpoint: { socketName: 'runtime-A' }, server: { socket: `tcp:127.0.0.1:${server.address().port}`, host: '127.0.0.1', port: server.address().port } } };
}

test('ADB namespaces support explicit TCP, IPv6 and filesystem sockets without conflating servers', () => {
  assert.deepEqual(parseAdbServer('tcp:5037'), { socket: 'tcp:127.0.0.1:5037', host: '127.0.0.1', port: 5037 });
  assert.deepEqual(parseAdbServer('tcp:other-host:5038'), { socket: 'tcp:other-host:5038', host: 'other-host', port: 5038 });
  assert.equal(parseAdbServer('tcp:[::1]:5037').host, '::1');
  assert.equal(parseAdbServer('localfilesystem:/tmp/adb-task.sock').path, '/tmp/adb-task.sock');
  assert.throws(() => parseAdbServer('tcp:0'), { code: 'adb_server_socket_invalid' });
});

test('transport selection is pre-dispatch: wrappers and explicit ports retain forward semantics', () => {
  const native = { nativeAdb: true };
  assert.equal(selectSdkTransport({ adbIdentity: native }).transport, 'direct');
  assert.equal(selectSdkTransport({ adbIdentity: { nativeAdb: false } }).transport, 'forward');
  assert.equal(selectSdkTransport({ adbIdentity: native, explicitPort: true }).transport, 'forward');
  assert.throws(() => selectSdkTransport({ adbIdentity: native, sdkTransport: 'direct', explicitPort: true }), { code: 'sdk_transport_conflict' });
  assert.throws(() => selectSdkTransport({ adbIdentity: { nativeAdb: false }, sdkTransport: 'direct' }), { code: 'sdk_direct_requires_native_adb' });
});

test('original route refuses a replaced executable instead of silently selecting a new wrapper', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { adbExecutableIdentity, assertOriginalExecutable } = require('../bin/shared-kernel/android-adb-route');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-adb-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'adb');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const identity = adbExecutableIdentity(executable);
  assert.equal(identity.nativeExecutable, false);
  assertOriginalExecutable({ executable: identity });
  fs.writeFileSync(executable, '#!/bin/sh\necho redirected\n');
  assert.throws(() => assertOriginalExecutable({ executable: identity }), { code: 'adb_executable_changed' });
});

function compileNativeAdb(t, directory, { installedPath, endpoint, endpointFile, log } = {}) {
  const fs = require('node:fs'), path = require('node:path');
  const executable = path.join(directory, process.platform === 'win32' ? 'adb.exe' : 'adb');
  const source = `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  ${log ? `FILE *calls=fopen(${JSON.stringify(log)},"a"); if(!calls)return 3; for(int i=1;i<argc;i++)fprintf(calls,"%s%s",i>1?"|":"",argv[i]); fputc('\\n',calls); fclose(calls);` : ''}
  if(argc==2 && strcmp(argv[1],"version")==0) { puts("Android Debug Bridge version 1.0.41"); puts(${JSON.stringify('Installed as ' + (installedPath || executable))}); return 0; }
  ${endpoint ? `for(int i=1;i<argc;i++)if(strcmp(argv[i],"files/ai_app_bridge_endpoint.json")==0) { puts(${JSON.stringify(JSON.stringify(endpoint))}); return 0; }` : ''}
  ${endpointFile ? `for(int i=1;i<argc;i++)if(strcmp(argv[i],"files/ai_app_bridge_endpoint.json")==0) { FILE *f=fopen(${JSON.stringify(endpointFile)},"r"); if(!f)return 4; char text[4096]; while(fgets(text,sizeof(text),f))fputs(text,stdout); fclose(f); return 0; }` : ''}
  return 2;
}`;
  const build = require('node:child_process').spawnSync(process.env.CC || 'cc', ['-x', 'c', '-o', executable, '-'], { input: source, encoding: 'utf8' });
  if (build.error?.code === 'ENOENT') { t.skip('native ADB compatibility fixture requires a C compiler'); return null; }
  assert.equal(build.status, 0, build.stderr || build.error?.message);
  return executable;
}

test('a working native delegate named adb retains forward when version identifies another binary', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { adbExecutableIdentity, standardAdbIdentity } = require('../bin/shared-kernel/android-adb-route');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-native-wrapper-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = compileNativeAdb(t, directory, { installedPath: process.execPath });
  if (!executable) return;
  const binding = { executable: adbExecutableIdentity(executable), server: parseAdbServer('tcp:5037') };
  assert.equal(binding.executable.nativeExecutable, true, 'exercise a running native delegate, not a script wrapper');
  const identity = await standardAdbIdentity({ adb: executable, adbTimeoutMs: 5000 }, binding);
  assert.equal(identity.nativeAdb, false);
  assert.equal(identity.reason, 'custom_adb_executable', 'distinguish a working delegate from an unavailable provenance probe');
  assert.equal(selectSdkTransport({ adbIdentity: identity }).transport, 'forward');
});

test('ordinary public auto selects a verified native installation and discovers its direct endpoint', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const provider = require('../bin/device-provider');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-native-adb-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtimeEpoch = '1788970540000-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41';
  const endpoint = { schema: 'ai-app-bridge.android-endpoint.v1', ok: true, packageName: 'example.app',
    transport: 'localabstract', runtimeEpoch, socketName: `aab-sdk-${runtimeEpoch}`, updatedAtMs: 1, version: 'test' };
  const log = path.join(directory, 'calls.txt');
  const executable = compileNativeAdb(t, directory, { endpoint, log });
  if (!executable) return;
  const fixture = await serverFixture(t, { handler: (request, response) => response.end(JSON.stringify({ ok: true, app: { packageName: 'example.app' } })) });
  for (let i = 0; i < 2; i++) {
    const result = await provider.executeProviderCommand('status', { adb: executable, serial: 'native-device', packageName: 'example.app', adbServerSocket: fixture.route.server.socket, timeoutMs: 10000 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sdkConnection.transport, 'direct'); assert.equal(result.sdkConnection.selection, 'native_adb');
  }
  assert.deepEqual(fixture.services, ['host:transport:native-device', `localabstract:${endpoint.socketName}`, 'host:transport:native-device', `localabstract:${endpoint.socketName}`]);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => line.split('|'));
  assert.equal(calls.filter(args => args.includes('version')).length, 1, 'native provenance is reused for the unchanged executable');
  assert.equal(calls.filter(args => args.includes('files/ai_app_bridge_endpoint.json')).length, 1, 'endpoint discovery is reused');
  assert.equal(calls.filter(args => args.includes('forward')).length, 0, 'normal direct requests never inspect or create forwards');
});

test('Host identity distinguishes ADB server namespaces and honors explicit socket precedence', () => {
  const { runtimeIdentity } = require('../bin/runtime-directory');
  const names = ['ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.ADB_SERVER_SOCKET = 'tcp:server-a:5037';
    const first = runtimeIdentity().config;
    process.env.ADB_SERVER_SOCKET = 'tcp:server-b:5037';
    assert.notEqual(runtimeIdentity().config, first);
    process.env.ANDROID_ADB_SERVER_ADDRESS = 'ignored-by-explicit-socket';
    const explicit = runtimeIdentity().config;
    process.env.ANDROID_ADB_SERVER_PORT = '5039';
    assert.equal(runtimeIdentity().config, explicit);
    delete process.env.ADB_SERVER_SOCKET;
    assert.notEqual(runtimeIdentity().config, explicit);
  } finally { for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name]; }
});

test('real TCP ADB selection reaches the exact serial/socket and HTTP response; all sockets close', async t => {
  const fixture = await serverFixture(t);
  for (let i = 0; i < 3; i++) {
    const socket = await openAdbSocket(fixture.route, { timeoutMs: 500 });
    assert.deepEqual(JSON.parse(await httpRequestBounded('http://adb-device/v1/status', { socket })), { ok: true });
  }
  assert.deepEqual(fixture.services, Array(3).fill(['host:transport:device-A', 'localabstract:runtime-A']).flat());
  assert.equal(fixture.requests.length, 3);
});

test('service rejection happens before any HTTP effect with a structured diagnostic', async t => {
  const fixture = await serverFixture(t, { failure: 2 });
  await assert.rejects(openAdbSocket(fixture.route, { timeoutMs: 500 }), error => {
    assert.equal(error.code, 'adb_service_failed'); assert.equal(error.adbService, 'localabstract:runtime-A');
    assert.equal(error.aiAppBridgeRequestNotStarted, true); assert.equal(error.dispatched, false); return true;
  });
  assert.equal(fixture.requests.length, 0);
});

test('cancel during ADB selection closes the connection without HTTP dispatch', async t => {
  const fixture = await serverFixture(t, { hang: 2 });
  await assert.rejects(runExecution({ timeoutMs: 60, mutation: true }, () => openAdbSocket(fixture.route, { timeoutMs: 1000 })), { code: 'deadline_exceeded', dispatched: false });
  assert.equal(fixture.requests.length, 0);
});

test('disconnect after HTTP POST stays unknown and never resends the mutation', async t => {
  const fixture = await serverFixture(t, { handler: (request) => request.socket.destroy() });
  await assert.rejects(runExecution({ timeoutMs: 1000, mutation: true }, async () => {
    const socket = await openAdbSocket(fixture.route, { timeoutMs: 500 });
    return httpRequestBounded('http://adb-device/v1/action/tap', { method: 'POST', payload: { actionId: 'once' }, socket });
  }), error => { assert.equal(error.dispatched, true); assert.equal(error.ambiguous, true); return true; });
  assert.equal(fixture.requests.length, 1);
});

function providerContext(fixture, overrides = {}) {
  const { adbExecutableIdentity } = require('../bin/shared-kernel/android-adb-route');
  const originalSdkRoute = { ...fixture.route, transport: 'direct', executable: adbExecutableIdentity(process.execPath),
    endpoint: { socketName: 'runtime-A', runtimeEpoch: 'fixture-epoch' }, ...overrides };
  return require('../bin/device-provider').createBridgeContext({ adb: process.execPath, serial: fixture.route.serial,
    packageName: 'example.app', timeoutMs: 500, originalSdkRoute });
}

test('production Native provider reuses only schemas on the same complete route and epoch', async t => {
  const provider = require('../bin/device-provider');
  const { nativeRuntimeStatus, nativeExecutionReceipt, nativeTargetRef } = require('../test-support/native-target-fixture');
  const fixture = await serverFixture(t, { handler: (request, response) => {
    const body = JSON.parse(fixture.requests.at(-1).body || '{}');
    response.end(JSON.stringify(request.url === '/v1/status' ? { ...nativeRuntimeStatus('example.app'), activity: `must-not-cache-${fixture.requests.length}` } : nativeExecutionReceipt(body)));
  } });
  for (let i = 0; i < 3; i++) {
    const result = await provider.nativeAction(providerContext(fixture), '/v1/action/tap-target', { targetRef: nativeTargetRef(`fresh-view-${i}`), actionId: `action-${i}` });
    assert.equal(result.ok, true);
  }
  assert.equal(fixture.requests.filter(r => r.path === '/v1/status').length, 1);
  assert.deepEqual(fixture.requests.filter(r => r.path.includes('/tap-target')).map(r => JSON.parse(r.body).targetRef.viewId), ['fresh-view-0', 'fresh-view-1', 'fresh-view-2']);
  await provider.nativeAction(providerContext(fixture, { endpoint: { socketName: 'other-socket', runtimeEpoch: 'fixture-epoch' } }), '/v1/action/tap-target', { targetRef: nativeTargetRef() });
  await provider.nativeAction(providerContext(fixture, { serial: 'device-B' }), '/v1/action/tap-target', { targetRef: nativeTargetRef() });
  assert.equal(fixture.requests.filter(r => r.path === '/v1/status').length, 3, 'same cloned epoch cannot cross socket or device identity');
});

test('same epoch on another ADB server gets its own capability observation', async t => {
  const provider = require('../bin/device-provider');
  const { nativeRuntimeStatus, nativeExecutionReceipt, nativeTargetRef } = require('../test-support/native-target-fixture');
  for (let i = 0; i < 2; i++) {
    const fixture = await serverFixture(t, { handler: (request, response) => response.end(JSON.stringify(request.url === '/v1/status'
      ? nativeRuntimeStatus('example.app') : nativeExecutionReceipt(JSON.parse(fixture.requests.at(-1).body)))) });
    assert.equal((await provider.nativeAction(providerContext(fixture), '/v1/action/tap-target', { targetRef: nativeTargetRef() })).ok, true);
    assert.equal(fixture.requests.filter(r => r.path === '/v1/status').length, 1);
  }
});

test('lost action response, cancellation and later original query stay on the saved route', async t => {
  const provider = require('../bin/device-provider');
  const { nativeRuntimeStatus, nativeExecutionReceipt, nativeTargetRef } = require('../test-support/native-target-fixture');
  let original, query = false;
  const fixture = await serverFixture(t, { handler: (request, response) => {
    const body = JSON.parse(fixture.requests.at(-1).body || '{}');
    if (request.url === '/v1/status') return response.end(JSON.stringify({ ...nativeRuntimeStatus('example.app'), debugBridge: { ...nativeRuntimeStatus('example.app').debugBridge, originalCompletionQuery: true } }));
    if (request.url === '/v1/action/tap-target') { original = body; request.socket.destroy(); return; }
    if (!query) return response.end(JSON.stringify({ ok: false, error: 'still_pending' }));
    response.end(JSON.stringify({ ok: true, ...body, executionResult: nativeExecutionReceipt(original) }));
  } });
  const ctx = providerContext(fixture), saved = structuredClone(ctx.sdkRoute);
  const first = await runExecution({ timeoutMs: 1000, mutation: true }, () => provider.nativeAction(ctx, '/v1/action/tap-target', { targetRef: nativeTargetRef(), actionId: 'original-once' }));
  assert.equal(first.ambiguous, true); assert.equal(first.settled, false);
  query = true;
  const restored = provider.createBridgeContext({ serial: fixture.route.serial, packageName: 'example.app', originalSdkRoute: saved,
    adbServerSocket: 'tcp:unrelated-server:5037', timeoutMs: 500 });
  // Direct recovery does not execute adb. An upgrade/removal of the original
  // binary is irrelevant to the original server + serial + epoch socket.
  restored.sdkRoute.executable = { path: '/removed/or/upgraded/adb', unavailable: true, nativeAdb: false };
  const result = await provider.nativeCompletion(restored, { actionId: 'original-once', runtimeEpoch: 'fixture-epoch' }, { cancel: false });
  assert.equal(result.executionResult.settled, true);
  assert.equal(fixture.requests.filter(r => r.path === '/v1/action/tap-target').length, 1);
  assert.equal(fixture.requests.filter(r => r.path === '/v1/action/cancel').length, 1);
  assert.equal(fixture.requests.filter(r => r.path === '/v1/action/query').length, 1);
  assert(fixture.services.filter(s => s.startsWith('localabstract:')).every(s => s === 'localabstract:runtime-A'));
});

test('malformed or mismatched capabilities never enter the cache or submit an action', async t => {
  const provider = require('../bin/device-provider');
  const { nativeRuntimeStatus, nativeExecutionReceipt, nativeTargetRef } = require('../test-support/native-target-fixture');
  let valid = false;
  const fixture = await serverFixture(t, { handler: (request, response) => response.end(JSON.stringify(request.url === '/v1/status'
    ? valid ? nativeRuntimeStatus('example.app') : { ok: false, error: 'status_incomplete', details: { source: 'sdk' } }
    : nativeExecutionReceipt(JSON.parse(fixture.requests.at(-1).body)))) });
  await assert.rejects(provider.nativeAction(providerContext(fixture), '/v1/action/tap-target', { targetRef: nativeTargetRef() }), { code: 'status_incomplete', dispatched: false });
  assert.equal(fixture.requests.length, 1);
  valid = true;
  assert.equal((await provider.nativeAction(providerContext(fixture), '/v1/action/tap-target', { targetRef: nativeTargetRef() })).ok, true);
  assert.equal(fixture.requests.filter(r => r.path === '/v1/status').length, 2);
});

test('Flutter Intent with an existing observation persists its route before dispatch and never cancels a replacement runtime', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const provider = require('../bin/device-provider');
  const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
  const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
  const { createOwnershipStore } = require('../bin/shared-kernel/device-ownership-store');
  const { flutterNode } = require('../test-support/flutter-target-fixture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-flutter-original-route-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const endpointFile = path.join(directory, 'endpoint.json');
  const epoch = '1788970540000-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41';
  const endpoint = { schema: 'ai-app-bridge.android-endpoint.v1', ok: true, packageName: 'example.app', version: 'test', updatedAtMs: 1,
    transport: 'localabstract', runtimeEpoch: epoch, socketName: `aab-sdk-${epoch}` };
  fs.writeFileSync(endpointFile, JSON.stringify(endpoint));
  const executable = compileNativeAdb(t, directory, { endpointFile });
  if (!executable) return;
  const lease = createDeviceMutationLease({ directory }), store = createOwnershipStore(directory);
  let original, pendingAtDispatch, completed = false;
  const fixture = await serverFixture(t, { handler: (request, response) => {
    const body = JSON.parse(fixture.requests.at(-1).body || '{}');
    if (request.url === '/v1/status') return response.end(JSON.stringify({ ok: true, app: { packageName: 'example.app' }, debugBridge: { originalCompletionQuery: true } }));
    if (request.url === '/v1/flutter/action') {
      original = body; pendingAtDispatch = store.read('flutter-intent-device').pending;
      const replacement = '1788970540001-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41';
      fs.writeFileSync(endpointFile, JSON.stringify({ ...endpoint, runtimeEpoch: replacement, socketName: `aab-sdk-${replacement}` }));
      request.socket.destroy(); return;
    }
    if (!completed) return response.end(JSON.stringify({ ok: false, error: 'still_pending' }));
    response.end(JSON.stringify({ ok: true, ...body, executionResult: { ok: true, settled: true, dispatched: true, ambiguous: false,
      actionId: original.actionId, runtimeEpoch: original.execution.runtimeEpoch,
      execution: { ...original.execution, settled: true } } }));
  } });
  const unrelated = await serverFixture(t);
  const previous = process.env.ADB_SERVER_SOCKET;
  try {
    process.env.ADB_SERVER_SOCKET = fixture.route.server.socket;
    const adapter = createProductionIntentDeviceAdapter({ adb: executable });
    const result = await lease.run('flutter-intent-device', () => adapter.action({ serial: 'flutter-intent-device', packageName: 'example.app',
      spec: { provider: 'flutter', action: 'tap', selector: { text: 'Settings' } }, actionId: 'flutter-original-once',
      rawTree: { runtimeEpoch: 'flutter-fixture-runtime', executionSchema: 'aab.flutter-execution/v1', nodes: [flutterNode()] } }));
    assert.equal(result.ambiguous, true, JSON.stringify(result));
    assert.equal(pendingAtDispatch.target.originalSdkRoute?.endpoint.socketName, endpoint.socketName, 'the durable marker must already bind the SDK socket when HTTP is submitted');
    assert.equal(pendingAtDispatch.target.originalSdkRoute.server.socket, fixture.route.server.socket);
    process.env.ADB_SERVER_SOCKET = unrelated.route.server.socket;
    completed = true;
    const restored = provider.createBridgeContext({ ...pendingAtDispatch.target, serial: 'flutter-intent-device' });
    const queried = await provider.flutterCompletion(restored, { actionId: original.actionId, runtimeEpoch: original.execution.runtimeEpoch }, { cancel: false });
    assert.equal(queried.executionResult.settled, true);
    assert.equal(fixture.requests.filter(request => request.path === '/v1/flutter/action').length, 1);
    assert.equal(fixture.requests.filter(request => request.path === '/v1/flutter/cancel').length, 1);
    assert.equal(fixture.requests.filter(request => request.path.includes('/snapshot')).length, 0, 'Intent reuses the supplied observation');
    assert(fixture.services.filter(service => service.startsWith('localabstract:')).every(service => service === `localabstract:${endpoint.socketName}`));
    assert.equal(unrelated.services.length, 0);
  } finally { previous === undefined ? delete process.env.ADB_SERVER_SOCKET : process.env.ADB_SERVER_SOCKET = previous; }
});
