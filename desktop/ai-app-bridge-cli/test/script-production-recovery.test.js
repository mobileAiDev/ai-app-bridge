'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost, handle } = require('../bin/script/script-entry');

function spec(source, policy = {}) {
  return {
    schemaVersion: 'aab.code-script/v1', name: 'production-recovery', language: 'javascript', source,
    target: { platform: 'android', serial: 'host-only-device', packageName: 'example.host.only' },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 2000, ...policy },
  };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-production-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { reopen: () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) }) };
}
function supervisor() { return createScriptSupervisor({ createHost: createProductionHost }); }
async function run(sup, args) {
  const started = await handle({ supervisor: sup, operation: 'start', operationId: 'recovery', ...args });
  assert.equal(started.ok, true, JSON.stringify(started));
  await sup.registry.get(started.operationId).running;
  const result = await sup.handle({ operation: 'result', operationId: started.operationId, store: args.store });
  return { result, status: await handle({ supervisor: sup, operation: 'status', operationId: started.operationId }) };
}
const checkpointCrash = `module.exports.main = async ctx => {
  if (!ctx.resume()) {
    await ctx.call('tap-text', {text:'first'});
    await ctx.checkpoint('first-done', { step: 1 });
    process.exit(31);
  }
  const status = await ctx.call('status', {});
  const network = await ctx.call('network', {});
  const next = await ctx.call('tap-text', {text:'second'}, {dispatchActionId:'caller-controlled'});
  return { status:status.result, network:network.result, next:next.execution.actionId };
};`;

test('production factory and default supervisor reject absent actions instead of FakeHost', async () => {
  assert.throws(() => createProductionHost(), /host_actions_required/);
  const rejected = await handle({ operation:'start', script:spec('module.exports.main = async ctx => ctx.call("tap-text", {text:"Go"});') });
  assert.equal(rejected.error, 'host_actions_required');
  assert.equal((await createScriptSupervisor().handle({ script:spec('module.exports.main=()=>1;') })).error, 'host_actions_required');
});

test('real child restart through script entry preserves provider, query, target and durable unique IDs', async (t) => {
  const { reopen } = fixture(t);
  const calls = [];
  const queries = [];
  const actions = async (command, args) => { calls.push({ command, args }); return { ok:true, provider:'real-wired' }; };
  const query = async (args) => { queries.push(args); return { ok:true, items:[{ payload:{seen:'query'} }], refs:[], coverage:{ status:'complete', gap:false, committed:true } }; };
  const first = await run(supervisor(), { store:reopen(), script:spec(checkpointCrash), actions, query });
  assert.equal(first.status.status, 'failed');
  assert.equal(first.status.error, 'child_crashed');
  assert.equal(calls.length, 1);
  const restoredStore = reopen();
  assert.deepEqual(restoredStore.list('recovery').map(r=>r.kind), ['checkpoint','dispatch-marker','action-receipt','checkpoint','checkpoint']);
  const fresh = supervisor();
  const restored = await handle({ supervisor:fresh, operation:'resume', operationId:'recovery', store:restoredStore, actions, query, script:spec(checkpointCrash) });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  await fresh.registry.get('recovery').running;
  const result = await fresh.handle({ operation: 'result', operationId: 'recovery', store: restoredStore });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.status.provider, 'real-wired');
  assert.equal(queries.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].args.serial, 'host-only-device');
  assert.equal(calls[2].args.packageName, 'example.host.only');
  assert.equal(calls[2].args.requestId, 'recovery:action-2');
  assert.equal(result.result.next, 'recovery:action-2');
  const records = reopen().list('recovery');
  assert.equal(new Set(records.map(r=>r.evidenceId)).size, records.length);
  const latest = records.at(-1);
  assert.equal(latest.status, 'completed');
  const again = await handle({ supervisor:supervisor(), operation:'resume', operationId:'recovery', store:reopen(), actions, query });
  assert.equal(again.error, 'not_resumable');
  assert.equal(calls.length, 3);
  const status = await handle({ supervisor:supervisor(), operation:'status', operationId:'recovery', store:reopen() });
  assert.equal(status.status, 'completed');
  assert.equal(status.resumable, false);
});

test('real child restored with runner instead of query retains live capture wiring', async (t) => {
  const {reopen} = fixture(t);
  let calls=0;
  const actions=async()=>({ok:true});
  const script=spec(`module.exports.main=async ctx=>{if(!ctx.resume()){await ctx.checkpoint('read',{step:1});process.exit(31);}return (await ctx.call('network',{})).result;};`);
  await run(supervisor(), {store:reopen(), script, actions});
  const fresh=supervisor();
  const restored=await handle({supervisor:fresh,operation:'resume',operationId:'recovery',store:reopen(),actions,runner:async()=>{calls++;return {ok:true,items:[],refs:[],coverage:{status:'complete',gap:false,committed:true}};}});
  assert.equal(restored.ok,true);
  await fresh.registry.get('recovery').running;
  assert.equal(calls,1);
});

test('completed operation persists terminal and cannot replay on same or fresh supervisor', async (t) => {
  const { reopen } = fixture(t); let actions = 0;
  const live=supervisor();
  await run(live, {store:reopen(),script:spec(`module.exports.main=async ctx=>{await ctx.checkpoint('before',{});await ctx.call('tap-text',{text:'Once'});return true;};`),actions:async()=>{actions++;return{ok:true};}});
  const store=reopen();
  for(const sup of [live,supervisor()]) {
    const answer=await handle({supervisor:sup,operation:'resume',operationId:'recovery',store,actions:async()=>{actions++;return{ok:true};}});
    assert.equal(answer.error,'not_resumable');
  }
  assert.equal(actions,1);
  assert.equal(store.latest('recovery','checkpoint').status,'completed');
});

test('restartPolicy none stays runtime_lost and cannot bypass with supplied source', async (t) => {
  const {reopen}=fixture(t);
  const script=spec(`module.exports.main=async ctx=>{await ctx.checkpoint('state',{});process.exit(31);};`, {restartPolicy:'none'});
  await run(supervisor(), {script,store:reopen(),actions:async()=>({ok:true})});
  const fresh=supervisor();
  const status=await handle({supervisor:fresh,operation:'status',operationId:'recovery',store:reopen()});
  assert.equal(status.status,'failed');
  assert.equal(status.resumable,false);
  const answer=await handle({supervisor:fresh,operation:'resume',operationId:'recovery',store:reopen(),script,actions:async()=>({ok:true})});
  assert.equal(answer.error,'not_resumable');
});

test('prepared write failure prevents the provider and swallowed error cannot produce completed', async (t) => {
  const {reopen}=fixture(t); const backing=reopen(); let calls=0;
  const store={...backing,persist:(kind,record)=>kind==='dispatch-marker'?{ok:false,error:'ENOSPC'}:backing.persist(kind,record)};
  const done=await run(supervisor(), {store,script:spec(`module.exports.main=async ctx=>{await ctx.call('tap-text',{text:'No'});return true;};`),actions:async()=>{calls++;return{ok:true};}});
  assert.equal(calls,0);
  assert.equal(done.status.status,'failed');
  assert.equal(done.status.error,'dispatch_marker_not_persisted');
});

test('side effect then provider throw durably records ambiguous and prohibits restart', async (t) => {
  const {reopen}=fixture(t); let effects=0;
  const done=await run(supervisor(), {store:reopen(),script:spec(`module.exports.main=async ctx=>{await ctx.checkpoint('before',{});await ctx.call('tap-text',{text:'Once'});return true;};`),actions:async()=>{effects++;throw new Error('lost_transport');}});
  assert.equal(done.status.status,'failed');
  assert.equal(done.status.error,'ambiguous');
  const store=reopen();
  assert.equal(store.latest('recovery','action-receipt').ambiguous,true);
  const answer=await handle({supervisor:supervisor(),operation:'resume',operationId:'recovery',store,actions:async()=>{effects++;return{ok:true};}});
  assert.equal(answer.error,'ambiguous');
  assert.equal(effects,1);
});

test('lost receipt prevents checkpoint and terminal success, and leaves prepared action ambiguous on reopening', async (t) => {
  const {reopen}=fixture(t); const backing=reopen(); let effects=0;
  const store={...backing,persist:(kind,record)=>kind==='action-receipt'?{ok:false,error:'ENOSPC'}:backing.persist(kind,record)};
  const done=await run(supervisor(), {store,script:spec(`module.exports.main=async ctx=>{await ctx.checkpoint('before',{});await ctx.call('tap-text',{text:'Once'});await ctx.checkpoint('after',{});return true;};`),actions:async()=>{effects++;return{ok:true};}});
  assert.equal(done.status.status,'failed');
  assert.equal(done.status.error,'action_receipt_not_persisted');
  assert.equal(reopen().latest('recovery','checkpoint').checkpoint.name,'before');
  const answer=await handle({supervisor:supervisor(),operation:'resume',operationId:'recovery',store:reopen(),actions:async()=>{effects++;return{ok:true};}});
  assert.equal(answer.error,'ambiguous');
  assert.equal(effects,1);
});

test('receipt after last user checkpoint requires reconciliation instead of repeating a confirmed effect', async (t) => {
  const {reopen}=fixture(t); let effects=0;
  await run(supervisor(), {store:reopen(),script:spec(`module.exports.main=async ctx=>{await ctx.checkpoint('before',{});await ctx.call('tap-text',{text:'Once'});process.exit(31);};`),actions:async()=>{effects++;return{ok:true};}});
  const answer=await handle({supervisor:supervisor(),operation:'resume',operationId:'recovery',store:reopen(),actions:async()=>{effects++;return{ok:true};}});
  assert.equal(answer.error,'ambiguous');
  assert.equal(effects,1);
});

for (const [command, args, permission] of [
  ['permission-grant', { permission: 'android.permission.CAMERA' }, 'app.permissions'],
  ['permission-revoke', { permission: 'android.permission.CAMERA' }, 'app.permissions'],
  ['appops-set', { op: 'CAMERA', mode: 'allow' }, 'app.permissions'],
  ['clear-app-data', {}, 'app.lifecycle'],
]) {
  test(`${command} persists its effect before crash and cannot replay from an earlier checkpoint`, async (t) => {
    const { reopen } = fixture(t);
    let effects = 0;
    const actions = async (_command, bound) => {
      effects++;
      assert.equal(bound.requestId, 'recovery:action-1');
      assert.equal(reopen().latest('recovery', 'dispatch-marker').state, 'prepared');
      return { ok: true, dispatched: true };
    };
    const script = {
      ...spec(`module.exports.main = async ctx => {
        await ctx.checkpoint('before', {});
        await ctx.call(${JSON.stringify(command)}, ${JSON.stringify(args)});
        process.exit(31);
      };`),
      permissions: [permission],
    };
    const done = await run(supervisor(), { store: reopen(), script, actions });
    assert.equal(done.status.status, 'failed');
    const receipt = reopen().latest('recovery', 'action-receipt');
    assert.equal(receipt.actionId, 'recovery:action-1');
    assert.equal(receipt.dispatched, true);
    assert.equal(receipt.ambiguous, false);
    const restored = await handle({ supervisor: supervisor(), operation: 'resume', operationId: 'recovery', store: reopen(), actions });
    assert.equal(restored.error, 'ambiguous');
    assert.equal(effects, 1);
  });
}

test('terminal disk write must complete before completed can be observed', async (t) => {
  const {reopen}=fixture(t); const backing=reopen(); let release; let observed;
  const pending=new Promise(resolve=>{observed=resolve;});
  const store={...backing,persist:(kind,record)=>{
    if(record.status==='completed'){observed();return new Promise(resolve=>{release=()=>resolve(backing.persist(kind,record));});}
    return backing.persist(kind,record);
  }};
  const sup=supervisor();
  const running=run(sup, {store,script:spec('module.exports.main=()=>true;'),actions:async()=>({ok:true})});
  await pending;
  const blocked=await handle({supervisor:sup,operation:'status',operationId:'recovery'});
  assert.equal(blocked.status,'finishing');
  assert.equal(blocked.events.some(e=>e.type==='script_completed'),false);
  await release();
  assert.equal((await running).status.status,'completed');
});

test('terminal disk failure cannot report completed', async (t) => {
  const {reopen}=fixture(t); const backing=reopen();
  const store={...backing,persist:(kind,record)=>record.status==='completed'?{ok:false,error:'ENOSPC'}:backing.persist(kind,record)};
  const done=await run(supervisor(), {store,script:spec('module.exports.main=()=>true;'),actions:async()=>({ok:true})});
  assert.equal(done.status.status,'failed');
  assert.equal(done.status.error,'terminal_not_persisted');
  assert.equal(done.status.events.some(e=>e.type==='script_completed'),false);
});

test('recovery freezes sourcePath contents and permissions and rejects changing device identity', async (t) => {
  const {reopen}=fixture(t);
  const sourceFile=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'aab-frozen-source-')),'script.js');
  t.after(()=>fs.rmSync(path.dirname(sourceFile),{recursive:true,force:true}));
  const source=`module.exports.main=async ctx=>{if(!ctx.resume()){await ctx.checkpoint('read',{});process.exit(31);}return (await ctx.call('tap-text',{text:'Denied'})).error;};`;
  fs.writeFileSync(sourceFile,source);
  const { source: ignoredSource, ...base } = spec(source);
  const script={...base, sourcePath:sourceFile, permissions:['app.read']};
  await run(supervisor(),{store:reopen(),script,actions:async()=>({ok:true})});
  fs.writeFileSync(sourceFile,'throw new Error("mutated_source_must_never_execute");');
  for (const changed of [
    {...spec(source),target:{platform: 'android', serial:'other',packageName:'example.host.only'},permissions:['app.read']},
    {...spec(source),permissions:['app.read','app.interact']},
  ]) {
    const rejected=await handle({supervisor:supervisor(),operation:'resume',operationId:'recovery',store:reopen(),script:changed,actions:async()=>({ok:true})});
    assert.equal(['script_target_mismatch','script_permissions_mismatch'].includes(rejected.error),true);
  }
  const fresh=supervisor(); let dispatched=0;
  const restoredStore=reopen();
  const restored=await handle({supervisor:fresh,operation:'resume',operationId:'recovery',store:restoredStore,actions:async()=>{dispatched++;return{ok:true};}});
  assert.equal(restored.ok,true,JSON.stringify(restored));
  await fresh.registry.get('recovery').running;
  const done=await fresh.handle({operation:'result',operationId:'recovery',store:restoredStore});
  assert.equal(done.ok,true,JSON.stringify(done));
  assert.equal(done.result,'permission_not_granted');
  assert.equal(dispatched,0);
});

test('terminal pause/cancel cannot reopen completed operation and create a replay route', async (t) => {
  const {reopen}=fixture(t); const sup=supervisor(); let effects=0;
  await run(sup,{store:reopen(),script:spec(`module.exports.main=async ctx=>{await ctx.call('tap-text',{text:'Once'});await ctx.checkpoint('done',{});};`),actions:async()=>{effects++;return{ok:true};}});
  for(const operation of ['pause','cancel']) {
    const state=await handle({supervisor:sup,operation,operationId:'recovery'});
    assert.equal(state.status,'completed');
  }
  assert.equal((await handle({supervisor:sup,operation:'resume',operationId:'recovery'})).error,'not_resumable');
  assert.equal(effects,1);
});

test('code assertion counts stay separate from device acceptance in summary and ledger', async (t) => {
  const {reopen}=fixture(t);
  const done=await run(supervisor(),{store:reopen(),script:spec(`module.exports.main=async ctx=>{await ctx.assert({name:'sum',scope:'code',condition:1+1===2});return true;};`),actions:async()=>({ok:true})});
  assert.equal(done.status.rollingSummary.assertionScopes.code.passed,1);
  assert.equal(done.status.rollingSummary.assertionScopes.device.passed,0);
  const assertion=done.status.history.items.find(item=>item.kind==='assertion_passed');
  assert.equal(assertion.payloadSummary.scope,'code');
});

test('timeout during prepared durability never dispatches late after the child is stopped', { timeout: 10000 }, async (t) => {
  const {reopen}=fixture(t); const backing=reopen(); let release; let offered; let effects=0;
  const pending=new Promise(resolve=>{offered=resolve;});
  const store={...backing,persist:(kind,record)=>{
    if(kind==='dispatch-marker'){offered();return new Promise(resolve=>{release=()=>resolve(backing.persist(kind,record));});}
    return backing.persist(kind,record);
  }};
  const sup=supervisor();
  const running=run(sup,{store,script:spec(`module.exports.main=async ctx=>ctx.call('tap-text',{text:'Late'});`,{timeoutMs:1500}),actions:async()=>{effects++;return{ok:true};}});
  t.after(() => release?.());
  await pending;
  const deadline=Date.now()+3000;
  while(Date.now()<deadline && (await sup.handle({operation:'status',operationId:'recovery'})).status!=='finishing') {
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal((await sup.handle({operation:'status',operationId:'recovery'})).status,'finishing');
  await release();
  const done=await running;
  assert.equal(done.status.status,'failed');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(effects,0);
  assert.equal(reopen().latest('recovery','action-receipt').dispatched,false);
});

test('production program argument cannot replace the real runtime with a fake', async (t) => {
  const {reopen}=fixture(t); let fakeCalls=0;
  const done=await run(supervisor(),{store:reopen(),script:spec('module.exports.main=()=>({runtime:"real-child"});'),program:async()=>{fakeCalls++;return{runtime:'fake'};},actions:async()=>({ok:true})});
  assert.equal(done.result.result.runtime,'real-child');
  assert.equal(fakeCalls,0);
});

test('production agent port does not fabricate or preselect an answer', async () => {
  const {createScriptAgentPort}=require('../bin/script/script-agent-port');
  const agent=createScriptAgentPort({decisions:['forbidden-preset']});
  let answered=false;
  const pending=agent.askAgent({requestId:'question',question:'continue?'}).then(value=>{answered=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(answered,false);
  assert.equal(agent.decide('question','actual-agent-answer').ok,true);
  assert.equal(await pending,'actual-agent-answer');
});
