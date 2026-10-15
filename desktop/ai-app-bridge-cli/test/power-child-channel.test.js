'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openChildChannel } = require('../bin/power/child-channel');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');
const { spawn } = require('node:child_process');

// A protocol worker verifies pipe/ownership semantics. It does not emulate an OS power API.
const worker = `
const readline = require('node:readline');
const send = value => console.log(JSON.stringify({protocol:'aab.power/v1',...value}));
let timer;
function arm(ttlMs) {clearTimeout(timer);timer=setTimeout(()=>process.exit(0),ttlMs)}
arm(Number(process.env.AAB_POWER_TTL_MS || 5000));
send({type:'ready',ok:true,coverage:{scope:'protocol-test',mode:process.env.AAB_POWER_MODE}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.operation==='release'){send({ok:true,requestId:x.requestId});process.exit(0)}
 arm(x.ttlMs);send({ok:true,requestId:x.requestId,coverage:{scope:'protocol-test'}});
}).on('close',()=>process.exit(0));
`;

test('worker renews, explicitly releases and exits; pipe EOF and native TTL also end ownership', async () => {
  const channel = await openChildChannel(process.execPath, ['-e', worker]);
  assert.equal((await channel.request('renew', { ttlMs: 5000 })).ok, true);
  assert.equal((await channel.release()).released, true);
  assert.equal((await channel.release()).reason, 'worker_exited');
  const disconnected = await openChildChannel(process.execPath, ['-e', worker]);
  disconnected.child.stdin.end();
  assert.equal((await disconnected.exit).code, 0);
  const expiring = await openChildChannel(process.execPath, ['-e', worker], { env: { ...process.env, AAB_POWER_TTL_MS: '100' } });
  assert.equal((await expiring.exit).code, 0);
  await assert.rejects(expiring.request('renew', { ttlMs: 1000 }), { code: 'power_worker_closed' });
});

test('Windows adapter launches an isolated API worker and does not change execution policy', async () => {
  let invocation;
  const adapter = createPlatformAdapter({ platform: 'win32', spawnChild(command, args, options) {
    invocation = { command, args, options };
    return spawn(process.execPath, ['-e', worker], options);
  } });
  const handle = await adapter({ target: { platform: 'host' }, leaseId: 'lease-1', mode: 'both', ttlMs: 5000 });
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.args.includes('-ExecutionPolicy'), false);
  assert.equal(invocation.options.env.AAB_POWER_MODE, 'both');
  assert.equal(invocation.options.env.AAB_POWER_TTL_MS, '5000');
  assert.match(invocation.args.at(-1), /SetThreadExecutionState/);
  await handle.renew({ ttlMs: 1000 });
  assert.equal((await handle.release()).released, true);
});

test('malformed startup and unacknowledged release fail with bounded cleanup', async () => {
  await assert.rejects(openChildChannel(process.execPath, ['-e', 'console.log("broken");setInterval(()=>{},100)']), { code: 'power_worker_protocol' });
  const channel = await openChildChannel(process.execPath, ['-e', `
    console.log(JSON.stringify({protocol:'aab.power/v1',type:'ready',ok:true,coverage:{}}));
    process.stdin.resume();setInterval(()=>{},100);
  `], { timeoutMs: 1000 });
  await assert.rejects(channel.release(), { code: 'power_worker_timeout' });
  assert.equal((await channel.exit).signal, 'SIGTERM');
});

test('an Android transport exit is not proof that its remote wake lock was released', async () => {
  let child;
  const adapter = createPlatformAdapter({ run: async () => ({ stdout: '' }), spawnChild(command, args, options) {
    child = spawn(process.execPath, ['-e', worker], options); return child;
  } });
  const handle = await adapter({ target: { platform: 'android', serial: 'test-only' }, leaseId: 'test', mode: 'both', ttlMs: 1000 });
  const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed;
  assert.deepEqual(await handle.release(), { released: false, reason: 'transport_closed_without_device_confirmation', boundedByPlatformExpiry: true });
});
