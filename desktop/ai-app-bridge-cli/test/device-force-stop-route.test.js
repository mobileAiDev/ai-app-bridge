'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { createDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');
const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
const { adbExecutableIdentity } = require('../bin/shared-kernel/android-adb-route');

async function adbNamespace(t, { failReset = false } = {}) {
  const commands = [], sockets = new Set();
  const hash = require('../runtime/uia/manifest.json').sha256;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = parseInt(buffer.subarray(0, 4).toString(), 16);
        if (buffer.length < size + 4) return;
        const service = buffer.subarray(4, size + 4).toString(); buffer = buffer.subarray(size + 4);
        commands.push(service);
        if (service === 'host:transport:emulator-5554') { socket.write('OKAY'); continue; }
        assert(service.startsWith('shell:'), service);
        if (failReset && service.includes(' force-reset')) { socket.destroy(); return; }
        const output = service.includes('getprop ro.build.version.sdk') ? '35'
          : service.includes(' force-reset') ? JSON.stringify({ ok: true, schemaVersion: 'aab.uia.reset.v1', stopped: true })
          : service.includes('sha256') ? hash : '';
        socket.end('OKAY' + output);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { commands, serverSocket: `tcp:127.0.0.1:${server.address().port}` };
}

function adbClient(directory) {
  const executable = path.join(directory, 'adb');
  fs.writeFileSync(executable, `#!${process.execPath}
const net=require('node:net'), args=process.argv.slice(2), serial=args[args.indexOf('-s')+1];
const shell=args.slice(args.indexOf('shell')+1).join(' '), address=process.env.ADB_SERVER_SOCKET.split(':');
const socket=net.connect({host:address[1],port:Number(address[2])});let buffer=Buffer.alloc(0),phase=0;
const send=text=>socket.write(text.length.toString(16).padStart(4,'0')+text);
socket.on('connect',()=>send('host:transport:'+serial));
socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(phase<2&&buffer.length>=4){const status=buffer.subarray(0,4).toString();buffer=buffer.subarray(4);if(status!=='OKAY'){process.exitCode=2;socket.destroy();return;}phase++;if(phase===1)send('shell:'+shell);}if(phase===2&&buffer.length){process.stdout.write(buffer);buffer=Buffer.alloc(0);}});
socket.on('error',error=>{process.stderr.write(error.message);process.exitCode=2;});
socket.on('close',()=>{if(phase<2)process.exitCode=2;});
`, { mode: 0o755 });
  return executable;
}

async function fixture(t, routes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-route-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adb = adbClient(directory), lease = createDeviceMutationLease({ directory });
  for (const [index, namespace] of routes.entries()) await lease.run('emulator-5554', () => runDeviceEffect({ kind: 'native', actionId: `unknown-${index}`,
    runtimeEpoch: `sdk-${index}`, target: { adb, packageName: `example.route${index}`, originalSdkRoute: {
      transport: 'direct', executable: adbExecutableIdentity(adb), serial: 'emulator-5554',
      server: { socket: namespace.serverSocket }, endpoint: { runtimeEpoch: `sdk-${index}`, socketName: `aab-sdk-${index}` },
    } } }, async () => ({ ok: false, dispatched: null, ambiguous: true, settled: false })));
  return { directory, lease };
}

test('forced reset uses original ADB namespace even when current server has the same serial', async t => {
  const original = await adbNamespace(t), current = await adbNamespace(t);
  const f = await fixture(t, [original]);
  const previous = process.env.ADB_SERVER_SOCKET;
  try {
    process.env.ADB_SERVER_SOCKET = current.serverSocket;
    const result = await forceStopDevice({ serial: 'emulator-5554', timeoutMs: 2000 }, { directory: f.directory, runtimeEndpoint: null, stopHost: async () => [] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(current.commands.length, 0, 'current server must receive neither UIA reset nor package stop');
    assert(original.commands.some(command => command.includes(' force-reset')));
    assert(original.commands.some(command => command.includes('am force-stop example.route0')));
    assert.equal(result.phone.routes[0].serverSocket, original.serverSocket);
  } finally { previous === undefined ? delete process.env.ADB_SERVER_SOCKET : process.env.ADB_SERVER_SOCKET = previous; }
});

test('recorded actions on different namespaces are reset in separate explicit route groups', async t => {
  const first = await adbNamespace(t), second = await adbNamespace(t);
  const f = await fixture(t, [first, second]);
  const previous = process.env.ADB_SERVER_SOCKET;
  try {
    process.env.ADB_SERVER_SOCKET = second.serverSocket;
    const result = await forceStopDevice({ serial: 'emulator-5554', timeoutMs: 2000 }, { directory: f.directory, runtimeEndpoint: null, stopHost: async () => [] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.phone.routes.length, 2);
    for (const [index, namespace] of [first, second].entries()) {
      assert(namespace.commands.some(command => command.includes(`am force-stop example.route${index}`)));
      assert(!namespace.commands.some(command => command.includes(`am force-stop example.route${1 - index}`)));
    }
  } finally { previous === undefined ? delete process.env.ADB_SERVER_SOCKET : process.env.ADB_SERVER_SOCKET = previous; }
});

test('failure of one original namespace retains retryable remote reset and per-route facts', async t => {
  const first = await adbNamespace(t), unavailable = await adbNamespace(t, { failReset: true });
  const f = await fixture(t, [first, unavailable]);
  const previous = process.env.ADB_SERVER_SOCKET;
  try {
    process.env.ADB_SERVER_SOCKET = unavailable.serverSocket;
    const result = await forceStopDevice({ serial: 'emulator-5554', timeoutMs: 2000 }, { directory: f.directory, runtimeEndpoint: null, stopHost: async () => [] });
    assert.equal(result.ok, false); assert.equal(result.remoteResetPending, true); assert.equal(result.ownershipReleased, true);
    const routes = result.remoteError.details.routes;
    assert.equal(routes.find(route => route.serverSocket === first.serverSocket).ok, true);
    assert.equal(routes.find(route => route.serverSocket === unavailable.serverSocket).ok, false);
    assert.equal(require('../bin/shared-kernel/device-ownership-store').createOwnershipStore(f.directory).read('emulator-5554').resetPending.length, 2);
  } finally { previous === undefined ? delete process.env.ADB_SERVER_SOCKET : process.env.ADB_SERVER_SOCKET = previous; }
});
