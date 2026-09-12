'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {handle,resetIntentOperations}=require('../bin/intent/intent-entry');
const {createProductionIntentDeviceAdapter}=require('../bin/intent/intent-production-adapter');
const {createIntentEvidenceStore}=require('../bin/intent/intent-evidence-store');
const {createMemoryEvidenceAdapter}=require('../bin/shared-kernel/evidence-adapters');
const {getProcessDeviceMutationLease}=require('../bin/shared-kernel/device-mutation-lease');
const { nativeTargetRef } = require('../test-support/native-target-fixture');
const { uiaXml } = require('../test-support/uia-target-fixture');

const target={platform:'android',serial:'host-only-intent',packageName:'example.intent',port:18081,adb:'/test/adb'};
const tree={root:{targetRef:nativeTargetRef(),text:'Save',visible:true,effectiveVisible:true,enabled:true,bounds:{left:10,top:20,right:30,bottom:40},children:[]}};
function ports(tap=async()=>({ok:true})) {
  return {createBridgeContext:options=>options,bridgeTree:async()=>tree,findTappableNodeByText:raw=>({node:raw.root}),tap};
}
function store(adapter=createMemoryEvidenceAdapter()){return createIntentEvidenceStore({adapter});}
async function start(extra={}) {
  return handle({operation:'start',operationId:'intent-boundary',goal:'Save',target,store:store(),ports:ports(),...extra});
}
function decision(revision){return{decisionId:'d1',agentDecision:'act',basedOnRevision:revision,action:{action:'tap',selector: { text: 'Save' }}};}

test('Intent entry defaults to actual production ports and propagates action ID plus device context', async () => {
  resetIntentOperations(); const contexts=[];const taps=[];
  const injected=ports(async(ctx,x,y,options)=>{taps.push({ctx,x,y,options});return{ok:true,transport:'bridge'};});
  injected.createBridgeContext=options=>{contexts.push(options);return options;};
  const evidence=store();
  const first=await start({ports:injected,store:evidence});
  assert.equal(first.status,'waiting_for_decision');
  const next=await handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
  assert.equal(next.status,'waiting_for_decision');
  assert.equal(taps.length,1);
  assert.equal(taps[0].ctx.port,18081);
  assert.equal(taps[0].ctx.adb,'/test/adb');
  assert.equal(taps[0].options.runtimeActionId,'intent-boundary:d1');
  assert.equal(taps[0].options.requestId,'intent-boundary:d1');
  assert.equal(evidence.latest(first.operationId,'dispatch-marker').actionId,'intent-boundary:d1');
  assert.equal(evidence.latest(first.operationId,'action-receipt').actionId,'intent-boundary:d1');
  assert.equal(contexts.every(ctx=>ctx.serial===target.serial&&ctx.packageName===target.packageName),true);
});

test('Intent side effect then production port throw persists ambiguous receipt and never retries', async () => {
  resetIntentOperations();let effects=0;const evidence=store();
  const first=await start({store:evidence,ports:ports(async()=>{effects++;throw new Error('response_lost');})});
  const next=await handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
  assert.equal(next.status,'ambiguous');
  assert.equal(evidence.latest(first.operationId,'action-receipt').ambiguous,true);
  assert.equal(evidence.latest(first.operationId,'action-receipt').error,'response_lost');
  await handle({operation:'resume',operationId:first.operationId});
  const again=await handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
  assert.equal(again.ok,false);
  assert.equal(effects,1);
});

test('Intent undefined production return is ambiguous, never an invented successful receipt', async () => {
  resetIntentOperations();const evidence=store();
  const first=await start({store:evidence,ports:ports(async()=>undefined)});
  const next=await handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
  assert.equal(next.status,'ambiguous');
  const receipt=evidence.latest(first.operationId,'action-receipt');
  assert.equal(receipt.mechanicalStatus,'failed');
  assert.equal(receipt.error,'invalid_action_receipt');
});

test('Intent direct adapter throw is durably ambiguous and retains unresolved device ownership', async () => {
  resetIntentOperations();const evidence=store();
  const adapter={observe:async({provider,rawTreeId})=>({ok:true,provider,rawTreeId,rawTree:tree}),action:async()=>{throw new Error('adapter_threw');}};
  const first=await start({store:evidence,adapter});
  const next=await handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
  assert.equal(next.status,'ambiguous');
  assert.equal(evidence.latest(first.operationId,'action-receipt').ambiguous,true);
  const lease=getProcessDeviceMutationLease().acquire(target.serial);
  assert.equal(lease.error,'device_ownership_unresolved');
});

test('Intent receipt persistence failure remains ambiguous after provider success', async () => {
  resetIntentOperations();let effects=0;const backing=createMemoryEvidenceAdapter();
  const evidence=store({...backing,record:envelope=>envelope.kind==='action-receipt'?{ok:false,error:'ENOSPC'}:backing.record(envelope)});
  const first=await start({store:evidence,ports:ports(async()=>{effects++;return{ok:true};})});
  const next=await handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
  assert.equal(next.status,'ambiguous');
  assert.equal(evidence.latest(first.operationId,'dispatch-marker').state,'prepared');
  assert.equal(evidence.latest(first.operationId,'action-receipt'),null);
  assert.equal(effects,1);
});

test('Intent target lease denial does not leave an unmatched prepared marker', async () => {
  resetIntentOperations();const evidence=store();let effects=0;
  const first=await start({store:evidence,ports:ports(async()=>{effects++;return{ok:true};})});
  const held=getProcessDeviceMutationLease().acquire(target.serial);
  try{
    const next=await handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
    assert.equal(next.error,'target_busy');
    assert.equal(evidence.latest(first.operationId,'dispatch-marker'),null);
    assert.equal(effects,0);
  }finally{held.release();}
});

test('Intent UIA forwards its original action ID to the node runtime without claiming SDK event correlation', async () => {
  const calls=[];
  const rawTree=uiaXml(`<hierarchy><node package="${target.packageName}" text="Save" enabled="true" clickable="true" bounds="[0,0][20,20]"/></hierarchy>`);
  const adapter=createProductionIntentDeviceAdapter({ports:{createBridgeContext:options=>options,uiaTreeOnce:async()=>rawTree,
    uiaTap:async(...args)=>{calls.push(args);return{ok:true,transport:'uia-node-runtime'};},tap:async()=>assert.fail('No coordinate tap')}});
  const receipt=await adapter.action({...target,actionId:'host-receipt-only',spec:{provider:'uia',action:'tap',text:'Save'},rawTree});
  assert.equal(receipt.ok,true);
  assert.equal(calls[0][0].runtimeActionId,'host-receipt-only');
  assert.deepEqual(calls[0][1].target.selector,{kind:'text',value:'Save',exact:true,packageName:target.packageName});
  assert.equal(receipt.providerResult.transport,'uia-node-runtime');
});

test('Intent cancellation while prepared durability waits never dispatches a late side effect', { timeout: 3000 }, async () => {
  resetIntentOperations();let effects=0;let release;let offered;
  const reached=new Promise(resolve=>{offered=resolve;});
  const backing=createMemoryEvidenceAdapter();
  const evidence=store({...backing,record:envelope=>{
    if(envelope.kind==='dispatch-marker'){offered();return new Promise(resolve=>{release=()=>resolve(backing.record(envelope));});}
    return backing.record(envelope);
  }});
  const first=await start({store:evidence,ports:ports(async()=>{effects++;return{ok:true};})});
  const deciding=handle({operation:'decide',operationId:first.operationId,decision:decision(first.revision)});
  await reached;
  const cancelled=handle({operation:'cancel',operationId:first.operationId});
  assert.equal(handle({operation:'status',operationId:first.operationId}).status,'cancelling');
  await release();
  assert.equal((await cancelled).status,'cancelled');
  const done=await deciding;
  assert.equal(done.status,'cancelled');
  assert.equal(effects,0);
  const receipt=evidence.latest(first.operationId,'action-receipt');
  assert.equal(receipt.dispatched,false);
  assert.equal(receipt.ambiguous,false);
});
