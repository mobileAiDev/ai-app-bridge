#!/usr/bin/env node
'use strict';

// Real PackageInstaller on an authorized Android device. Fault injection is
// confined to the Host ADB client: no SDK/App changes and no installer UI rules.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main({ out, serverPath, serial, apkPath, packageName }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const report = { ok: false, serial, packageName, apkPath, serverPath, cases: [] };
  const write = (file, data) => fs.writeFileSync(path.join(out, file), JSON.stringify(data, null, 2) + '\n');
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 });
  const identity = () => {
    const file = adb(['shell', 'pm', 'path', packageName]).trim().slice('package:'.length);
    assert(file.endsWith('/base.apk')); return { path: file, sha256: adb(['shell', 'sha256sum', file]).trim().split(/\s+/)[0] };
  };
  const until = async (fn, ms = 20000) => {
    const deadline = Date.now() + ms;
    for (;;) { const value = await fn(); if (value) return value; assert(Date.now() < deadline, 'Expected validation condition did not arrive'); await delay(100); }
  };
  const clients = [];
  try {
    report.before = identity(); report.bootId = adb(['shell', 'cat', '/proc/sys/kernel/random/boot_id']).trim();
    for (const name of ['cancel-before-admission', 'cancel-after-admission', 'deadline', 'host-crash']) {
      const directory = path.join(out, name); fs.mkdirSync(directory);
      const modeFile = path.join(directory, 'mode.json'), wireFile = path.join(directory, 'wire.jsonl');
      const mode = value => fs.writeFileSync(modeFile, JSON.stringify(value));
      mode(name === 'cancel-before-admission' ? 'hold-start' : 'hold-response');
      const faultAdb = path.join(directory, 'fault-adb');
      fs.writeFileSync(faultAdb, `#!${process.execPath}\n` +
        `const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);\n` +
        `const script=args.at(-1)||'',mode=JSON.parse(fs.readFileSync(${JSON.stringify(modeFile)}));\n` +
        `const start=script.includes('mkdir "$job/launched"'),cancel=script.includes('>"$job/cancel.tmp"');\n` +
        `const query=script.includes('then cat "$job/receipt.json"; else printf');\n` +
        `const log=v=>fs.appendFileSync(${JSON.stringify(wireFile)},JSON.stringify({at:Date.now(),...v})+'\\n');\n` +
        `if(start&&mode==='hold-start'){log({kind:'held-start'});fs.writeFileSync(${JSON.stringify(path.join(directory, 'held-start.json'))},JSON.stringify(args));setInterval(()=>{},1000);}\n` +
        `else {const r=cp.spawnSync('adb',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:30000});\n` +
        `let value;try{value=JSON.parse(r.stdout);}catch(_){}\n` +
        `if(start||query||cancel)log({kind:start?'start':cancel?'cancel':'query',code:r.status,response:value});\n` +
        `if((query||cancel)&&value?.settled===true&&['hold-response','wrong-action'].includes(mode)){\n` +
        `fs.writeFileSync(${JSON.stringify(path.join(directory, 'original-terminal.json'))},JSON.stringify(value));\n` +
        `if(mode==='wrong-action')process.stdout.write(JSON.stringify({...value,actionId:'different-action'}));\n` +
        `else process.stdout.write(JSON.stringify({ok:true,settled:false}));\n` +
        `}else {process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status??1;}}\n`, { mode: 0o755 });
      const client = label => {
        const c = createMcpClient({ serverPath, transcriptPath: path.join(directory, `${label}-mcp.jsonl`), stderrPath: path.join(directory, `${label}-stderr.log`),
          env: { AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership'), AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, `${label}-facts`) } });
        clients.push(c); return c;
      };
      let seq = 0;
      const run = async (c, command, args) => {
        const value = payloadOf(await c.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
        fs.writeFileSync(path.join(directory, `${String(++seq).padStart(3, '0')}-${command}.json`), JSON.stringify(value, null, 2) + '\n');
        return value;
      };
      const owner = client('owner'), reader = client('reader'); await owner.initialize(); await reader.initialize();
      const state = { name, before: identity(), blocked: [] }; report.cases.push(state);
      const initial = await run(owner, 'install-apk', { serial, apkPath, adb: faultAdb, timeoutMs: name === 'deadline' ? 6000 : 60000 });
      assert.equal(initial.ok, true, JSON.stringify(initial)); state.operationId = initial.operationId;
      state.originalIdentity = initial.installation.process.identity;
      process.stdout.write(JSON.stringify({ name, operationId: initial.operationId, phase: 'started' }) + '\n');
      const blocked = async (c, expected) => {
        const result = await run(c, 'keyevent', { serial, keyCode: 0, feedback: 'off' });
        assert.equal(result.error, expected); assert.equal(result.dispatched, false);
        state.blocked.push({ error: result.error, dispatched: result.dispatched });
      };
      await blocked(reader, 'target_busy');
      if (name === 'cancel-before-admission') await until(() => fs.existsSync(path.join(directory, 'held-start.json')));
      else await until(() => fs.existsSync(path.join(directory, 'original-terminal.json')));
      if (name === 'host-crash') {
        process.kill(owner.pid, 'SIGKILL'); state.ownerExit = await owner.close();
        assert.deepEqual(state.ownerExit, { code: null, signal: 'SIGKILL' });
      } else {
        state.final = name === 'deadline'
          ? await until(async () => { const value = await run(owner, 'intent', { operation: 'status', operationId: initial.operationId }); return value.status === 'timeout' ? value : false; })
          : await run(owner, 'intent', { operation: 'cancel', operationId: initial.operationId });
        assert.equal(state.final.status, name === 'deadline' ? 'timeout' : 'cancelled');
        state.archive = await run(owner, 'evidence', { operation: 'export', namespace: 'intent', operationId: initial.operationId,
          outputDir: path.join(directory, 'archive'), includeRecordedPayloads: true }); assert.equal(state.archive.ok, true);
        state.ownerExit = await owner.close({ stdinEof: true }); assert.deepEqual(state.ownerExit, { code: 0, signal: null });
      }
      if (name === 'cancel-before-admission') {
        assert.equal(state.final.installation.process.executionReceipt.phase, 'not-admitted');
        assert.equal((await run(reader, 'device-ownership', { operation: 'status', serial })).active, 0);
        state.after = identity(); assert.deepEqual(state.after, state.before);
      } else {
        await blocked(reader, 'device_ownership_unresolved'); await reader.close({ stdinEof: true });
        const recovery = client('recovery'); await recovery.initialize();
        for (const fault of ['hold-response', 'wrong-action']) {
          mode(fault);
          const denied = await run(recovery, 'device-ownership', { operation: 'reconcile', serial });
          assert.equal(denied.error, 'device_ownership_unresolved'); await blocked(recovery, 'device_ownership_unresolved');
        }
        if (name === 'host-crash') {
          for (const language of ['javascript', 'python']) {
            const source = language === 'javascript'
              ? "module.exports.main=async ctx=>{const r=await ctx.call('keyevent',{keyCode:0});if(r.error!=='device_ownership_unresolved'||r.dispatched!==false)throw Error(JSON.stringify(r));return r.error;};"
              : "def main(ctx):\n    r=ctx.call('keyevent',{'keyCode':0})\n    if r['error']!='device_ownership_unresolved' or r['dispatched'] is not False: raise Exception(str(r))\n    return r['error']\n";
            const start = await run(recovery, 'script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language, source, target: { platform: 'android', serial, packageName } } });
            assert.equal(start.ok, true);
            const ended = await until(async () => { const s = await run(recovery, 'script', { operation: 'wait', operationId: start.operationId, waitMs: 100 });
              return ['completed', 'failed'].includes(s.status) ? s : false; });
            assert.equal(ended.status, 'completed');
            const resultEnvelope = await run(recovery, 'script', { operation: 'result', operationId: start.operationId });
            assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
            assert.equal(resultEnvelope.result, 'device_ownership_unresolved');
            const archive = await run(recovery, 'evidence', { operation: 'export', namespace: 'script', operationId: start.operationId,
              outputDir: path.join(directory, `${language}-archive`), includeRecordedPayloads: true }); assert.equal(archive.ok, true);
            state.blocked.push({ language, operationId: start.operationId, error: 'device_ownership_unresolved', archive });
          }
          state.interrupted = await run(recovery, 'intent', { operation: 'status', operationId: initial.operationId });
          // Intent history belongs to the original FactStore; this fresh store
          // must not fabricate an operation from device ownership alone.
          assert.equal(state.interrupted.error, 'unknown_operation');
        }
        mode('normal');
        state.recovery = await run(recovery, 'device-ownership', { operation: 'reconcile', serial });
        assert.equal(state.recovery.ok, true, JSON.stringify(state.recovery)); assert.equal(state.recovery.recovered, true);
        assert.equal(state.recovery.executionReceipt.actionId, state.originalIdentity.actionId);
        assert.equal(state.recovery.executionReceipt.jobId, state.originalIdentity.jobId);
        assert.equal(state.recovery.executionReceipt.requestSucceeded, true);
        assert.equal(state.recovery._history.status, 'stored');
        state.after = identity(); assert.equal(state.after.sha256, state.before.sha256); assert.notEqual(state.after.path, state.before.path);
        assert.equal((await run(recovery, 'device-ownership', { operation: 'status', serial })).active, 0);
      }
      const wire = fs.readFileSync(wireFile, 'utf8').trim().split('\n').map(JSON.parse);
      state.actualStarts = wire.filter(r => r.kind === 'start').length;
      assert.equal(state.actualStarts, name === 'cancel-before-admission' ? 0 : 1);
      mode('normal'); await reader.close({ stdinEof: true });
      state.ok = true; process.stdout.write(JSON.stringify({ name, ok: true, actualStarts: state.actualStarts }) + '\n');
    }
    report.after = identity(); assert.equal(report.after.sha256, report.before.sha256); report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally { report.exits = await Promise.all(clients.map(c => c.close({ stdinEof: true }))); write('report.json', report); }
  return report;
}

if (require.main === module) main(JSON.parse(process.argv[2])).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { main };
