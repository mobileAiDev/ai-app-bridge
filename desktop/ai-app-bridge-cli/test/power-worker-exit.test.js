'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createPowerManager } = require('../bin/power');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Real pipes/process exits, never PowerShell, Win32, ADB or an attached phone.
const worker = `
const send = value => console.log(JSON.stringify({protocol:'aab.power/v1',...value}));
send({type:'ready',ok:true,coverage:{scope:'node-protocol-fixture'}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line); send({type:'observed',operation:x.operation});
 if(x.operation==='exit'){process.stderr.write('fixture worker ended');process.exit(23)}
 if(x.operation==='malformed'){console.log('broken after ready');return}
 if(x.operation==='release'){send({type:'released',ok:true,released:true,requestId:x.requestId});process.exit(0)}
 if(x.operation==='renew'&&process.env.HOLD_RENEW==='1')return;
 send({ok:true,requestId:x.requestId,coverage:{scope:'node-protocol-fixture'}});
}).on('close',()=>process.exit(0));
`;

function fixture(t, { remote = false, holdRenew = false, replaceHandle = false } = {}) {
  let time = 0, nextTimer = 0;
  const records = [], timers = new Map();
  const adapter = createPlatformAdapter({ platform: 'win32', run: async () => ({ stdout: '' }),
    spawnChild(_command, _args, options) {
      const child = spawn(process.execPath, ['-e', worker], {
        ...options, env: { ...options.env, HOLD_RENEW: holdRenew ? '1' : '0' },
      });
      const record = { child, operations: [], releaseCalls: 0, waiters: new Map(),
        closed: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) };
      let bytes = '';
      child.stdout.on('data', data => {
        bytes += data; let end;
        while ((end = bytes.indexOf('\n')) >= 0) {
          const line = bytes.slice(0, end); bytes = bytes.slice(end + 1);
          let value; try { value = JSON.parse(line); } catch { continue; }
          if (value.type !== 'observed') continue;
          record.operations.push(value.operation); record.waiters.get(value.operation)?.();
        }
      });
      records.push(record); return child;
    } });
  const manager = createPowerManager({ assertionTtlMs: 60000, refreshMs: 15000,
    now: () => time, wallNow: () => 100000 + time,
    schedule: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: time + delay }); return id; },
    unschedule: id => timers.delete(id),
    acquireAdapter: async options => {
      const handle = await adapter(replaceHandle ? { ...options, target: { platform: 'host' } } : options);
      const record = records.at(-1), release = handle.release;
      handle.release = async () => { record.releaseCalls++; return release(); };
      // Only the existing explicit SDK-ended policy replaces a handle. Its
      // delayed termination below is still delivered by an actual Node child.
      if (replaceHandle && records.length === 1) handle.renew = async () => {
        throw Object.assign(new Error('The selected SDK assertion ended'), { code: 'power_lease_ended' });
      };
      return handle;
    } });
  t.after(async () => {
    await manager.close();
    for (const record of records) {
      if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
      await record.closed;
    }
  });
  const target = replaceHandle ? { platform: 'ios', deviceId: 'fixture-ios', bundleId: 'fixture.app' }
    : remote ? { platform: 'android', serial: 'fixture-android' } : { platform: 'host' };
  return { manager, records, timers,
    acquire: (ownerId = 'work', leaseMs = 120000) => manager.acquire({ ownerId, target,
      mode: replaceHandle ? 'display' : 'both', leaseMs, recovery: replaceHandle ? 'reacquire-ended' : 'manual' }),
    async end(record, operation = 'exit') {
      record.child.stdin.write(JSON.stringify({ operation }) + '\n');
      const result = await record.closed; await flush(); return result;
    },
    observed(record, operation) {
      return record.operations.includes(operation) ? Promise.resolve()
        : new Promise(resolve => record.waiters.set(operation, resolve));
    },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

for (const remote of [false, true]) test(`${remote ? 'Android transport' : 'Windows adapter'} close invalidates only its lease before any heartbeat`, { timeout: 10000 }, async t => {
  const f = fixture(t, { remote });
  const lost = await f.acquire('lost'), survivor = await f.acquire('survivor');
  assert.deepEqual(await f.end(f.records[0]), { code: 23, signal: null });
  const status = f.manager.status({ leaseId: lost.leaseId });
  assert.equal(status.state, 'failed');
  assert.equal(status.error.code, 'power_worker_closed');
  assert.deepEqual(status.error.details, { code: 23, signal: null, stderr: 'fixture worker ended' });
  assert.equal(status.remainingMs, 0);
  assert.equal(f.records[0].releaseCalls, 1);
  assert.equal(f.records[0].operations.includes('renew'), false);
  assert.equal(f.records.length, 2, 'worker exit must not reacquire');
  assert.equal(f.manager.status({ leaseId: survivor.leaseId }).state, 'active');
  assert.equal(f.records[1].releaseCalls, 0);
  assert.equal(f.timers.size, 1, 'only the surviving lease retains its heartbeat');
  assert.deepEqual(status.release, remote
    ? { released: false, reason: 'transport_closed_without_device_confirmation', boundedByPlatformExpiry: true }
    : { released: true, reason: 'worker_exited', confirmed: false });
});

test('a protocol fault after ready retains its original reason when the worker closes', { timeout: 10000 }, async t => {
  const f = fixture(t), lease = await f.acquire();
  await f.end(f.records[0], 'malformed');
  const status = f.manager.status({ leaseId: lease.leaseId });
  assert.equal(status.state, 'failed');
  assert.equal(status.error.code, 'power_worker_protocol');
  assert.equal(status.error.details.line, 'broken after ready');
  assert.equal(f.records[0].releaseCalls, 1);
});

test('close during renewal drains through the lease queue and releases only once', { timeout: 10000 }, async t => {
  const f = fixture(t, { holdRenew: true }), lease = await f.acquire();
  const renewed = f.manager.renew({ leaseId: lease.leaseId, leaseMs: 120000 });
  await f.observed(f.records[0], 'renew');
  f.records[0].child.kill('SIGKILL'); await f.records[0].closed;
  assert.equal((await renewed).state, 'failed'); await flush();
  const status = f.manager.status({ leaseId: lease.leaseId });
  assert.equal(status.error.code, 'power_worker_closed');
  assert.equal(status.error.details.signal, 'SIGKILL');
  assert.equal(f.records[0].releaseCalls, 1);
  assert.equal(f.records.length, 1);
});

for (const ending of ['release', 'expiry', 'manager close']) test(`${ending} keeps its intended terminal state after the worker exit notification`, { timeout: 10000 }, async t => {
  const f = fixture(t), lease = await f.acquire('normal', 1000);
  if (ending === 'release') await f.manager.release({ leaseId: lease.leaseId });
  else if (ending === 'expiry') { await f.advance(1000); await f.records[0].closed; }
  else await f.manager.close();
  await flush();
  const status = f.manager.status({ leaseId: lease.leaseId });
  assert.equal(status.state, ending === 'expiry' ? 'expired' : 'released');
  assert.equal(status.error, undefined);
  assert.equal(status.release.released, true);
  assert.equal(f.records[0].releaseCalls, 1);
  assert.equal(f.records.length, 1);
  assert.equal(f.timers.size, 0);
});

test('a replaced handle closing later cannot fail or release the current handle', { timeout: 10000 }, async t => {
  const f = fixture(t, { replaceHandle: true }), lease = await f.acquire();
  const recovered = await f.manager.renew({ leaseId: lease.leaseId, leaseMs: 120000 });
  assert.equal(recovered.state, 'active'); assert.equal(recovered.assertionRecovery.attempts, 1);
  assert.equal(f.records.length, 2);
  await f.end(f.records[0]);
  const current = f.manager.status({ leaseId: lease.leaseId });
  assert.equal(current.state, 'active'); assert.equal(current.error, undefined);
  assert.equal(f.records[1].releaseCalls, 0);
  assert.equal(f.records.length, 2, 'a late old-handle exit cannot reenter recovery');
  await f.manager.release({ leaseId: lease.leaseId });
  assert.equal(f.records[1].releaseCalls, 1);
});
