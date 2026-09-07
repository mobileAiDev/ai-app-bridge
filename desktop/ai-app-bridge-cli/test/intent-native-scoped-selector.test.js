'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { handle, resetIntentOperations } = require('../bin/intent/intent-entry');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const actualLabels = require('./fixtures/notallyx-labels-native-tree.json');
const target = { serial: 'native-scope-test', packageName: 'io.github.mobileaidev.notallyx.sample' };
const EDIT = `${target.packageName}:id/EditButton`;
const scope = () => ({ text: 'AAB扩展标签-01', ancestor: { className: 'android.widget.LinearLayout', parent: { resourceName: `${target.packageName}:id/MainListView` } } });
const selector = () => ({ resourceName: EDIT, within: scope() });
function node(extra = {}) { return { visible: true, effectiveVisible: true, enabled: true, className: 'android.view.View', bounds: { left: 10, top: 20, right: 100, bottom: 60 }, children: [], ...extra }; }
function row(text = 'AAB扩展标签-01', extra = {}) { return node({ className: 'android.widget.LinearLayout', resourceName: 'id/Row', bounds: { left: 0, top: 10, right: 500, bottom: 180 }, children: [node({ text }), node({ resourceName: EDIT, contentDescription: '编辑', bounds: { left: 150, top: 20, right: 250, bottom: 60 } })], ...extra }); }
function tree(rows = [row()]) { return { root: node({ resourceName: `${target.packageName}:id/MainListView`, bounds: { left: 0, top: 0, right: 600, bottom: 900 }, children: rows }) }; }
function harness(extra = {}) {
 const calls=[];
 const record = kind => async (...args) => { calls.push({kind,args}); return {ok:true,transport:kind === 'tap' || kind === 'input' ? 'bridge':'adb'}; };
 const adapter=createProductionIntentDeviceAdapter({ports:{createBridgeContext: args=>args,tap:record('tap'),inputText:record('input'),swipe:record('swipe'),longPress:record('longPress'),...extra}});
 return {adapter,calls};
}
const dispatch=(h,s=selector(),rawTree=tree(),extra={})=>h.adapter.action({...target,actionId:'scope-host-id',rawTree,spec:{provider:'native',action:'tap',selector:s,...extra}});

test('actual NotallyX label topology rejects global duplicate edit selectors, selects only anchored row',async()=>{
 for(const global of [{resourceName:EDIT},{contentDescription:'编辑'}]){
  const h=harness();const result=await dispatch(h,global,actualLabels);assert.equal(result.error,'native_selector_ambiguous');assert.equal(h.calls.length,0);
 }
 for(const s of [selector(),{contentDescription:'编辑',within:scope()}]){
  const h=harness(); const result=await dispatch(h,s,actualLabels); assert.equal(result.ok,true);
  assert.deepEqual(h.calls[0].args.slice(1,3),[900,392]);
  assert.equal(h.calls[0].args[3].runtimeActionId,'scope-host-id');
 }
});

test('scope requires a unique visible anchor and never searches globally when missing',async()=>{
 for(const [rawTree,error] of [
  [tree([row('Another label')]),'native_scope_anchor_not_found'],
  [tree([row(),row()]),'native_scope_anchor_ambiguous'],
  [tree([row(undefined,{visible:false})]),'native_scope_anchor_not_found'],
  [tree([row(undefined,{children:[node({text:'AAB扩展标签-01',bounds:{left:700,top:20,right:800,bottom:60}}),node({resourceName:EDIT})]})]),'native_scope_anchor_not_found'],
 ]){const h=harness();const r=await dispatch(h,selector(),rawTree);assert.equal(r.error,error);assert.equal(r.dispatched,false);assert.equal(h.calls.length,0);}
 const h=harness();assert.equal((await dispatch(h,selector(),tree([row(),row(undefined,{visible:false})]))).ok,true);
});

test('explicit ancestor must be unique; wrong or multiple matching ancestors never widen scope',async()=>{
 const nested=tree([row(undefined,{children:[row()]})]);
 const cases=[
  [{...selector(),within:{...scope(),ancestor:{className:'android.widget.FrameLayout'}}},tree(),'native_scope_ancestor_not_found'],
  [{...selector(),within:{...scope(),ancestor:{className:'android.widget.LinearLayout'}}},nested,'native_scope_ancestor_ambiguous'],
  [{...selector(),within:{...scope(),ancestor:{className:'android.widget.LinearLayout',parent:{resourceName:'id/MissingParent'}}}},tree(),'native_scope_ancestor_not_found'],
 ];
 for(const [s,t,error]of cases){const h=harness();const r=await dispatch(h,s,t);assert.equal(r.error,error);assert.equal(r.dispatched,false);assert.equal(h.calls.length,0);}
 const onlyRow=tree([node({className:'android.widget.LinearLayout',bounds:{left:0,top:0,right:600,bottom:900},children:[row(undefined,{resourceName:'id/ExactRow'})]})]);
 const h=harness();const r=await dispatch(h,{resourceName:EDIT,within:{text:'AAB扩展标签-01',ancestor:{resourceName:'id/ExactRow'}}},onlyRow);assert.equal(r.ok,true);
});

test('scope rejects invalid grammar, unknown fields and missing explicit ancestor',async()=>{
 for(const within of [null,{},'row',[],{text:'AAB扩展标签-01'},{...scope(),index:0},{...scope(),text:''},{...scope(),resourceName:'id/Label'},
  {...scope(),ancestor:{}},{...scope(),ancestor:{className:'android.widget.LinearLayout',resourceName:'id/Row'}},{...scope(),ancestor:{text:'row'}},
  {...scope(),ancestor:{className:'android.widget.LinearLayout',parent:null}},{...scope(),ancestor:{className:'android.widget.LinearLayout',parent:{text:'Main list'}}},{...scope(),ancestor:{className:'android.widget.LinearLayout',parent:{resourceName:'id/List',className:'RecyclerView'}}},{...scope(),ancestor:{className:''}},{...scope(),ancestor:{className:7}},
 ]){const h=harness();const r=await dispatch(h,{resourceName:EDIT,within});assert.equal(r.error,'invalid_native_scope');assert.equal(r.dispatched,false);assert.equal(h.calls.length,0);}
});

test('target must be unique and centered inside the selected row and current window',async()=>{
 const missing=row(undefined,{children:[node({text:'AAB扩展标签-01'})]});
 const duplicated=row(undefined,{children:[node({text:'AAB扩展标签-01'}),node({resourceName:EDIT}),node({resourceName:EDIT})]});
 const outside=row(undefined,{children:[node({text:'AAB扩展标签-01'}),node({resourceName:EDIT,bounds:{left:510,top:20,right:590,bottom:60}})]});
 for(const [r,error]of [[missing,'native_selector_not_found'],[duplicated,'native_selector_ambiguous'],[outside,'native_selector_not_found']]){
  const h=harness();const result=await dispatch(h,selector(),tree([r,row('Other label')]));assert.equal(result.error,error);assert.equal(result.dispatched,false);assert.equal(h.calls.length,0);
 }
 const covered=tree();covered.windows=[{root:covered.root},{root:node({bounds:{left:0,top:0,right:600,bottom:900},children:[]})}];
 const h=harness();assert.equal((await dispatch(h,selector(),covered)).error,'native_scope_anchor_not_found');assert.equal(h.calls.length,0);
});

test('scoped selection applies consistently to explicit longPress, swipe and editable input',async()=>{
 for(const extra of [{action:'longPress',durationMs:700},{action:'swipe',deltaX:50,deltaY:0,durationMs:700},{action:'inputText',value:'Renamed'}]){
  const h=harness();const t=tree([row(undefined,{children:[node({text:'AAB扩展标签-01'}),node({resourceName:EDIT,editable:true,bounds:{left:150,top:20,right:250,bottom:60}})]})]);
  const r=await dispatch(h,selector(),t,extra);assert.equal(r.ok,true);assert.equal(h.calls.length,1);
  if(extra.action==='inputText'){assert.equal(h.calls[0].args[2].tapX,200);assert.equal(h.calls[0].args[2].tapY,40);}
  else assert.deepEqual(h.calls[0].args.slice(1,3),[200,40]);
 }
});

test('all native action centers must stay inside every ancestor viewport, even when effectiveVisible is true',async()=>{
 const viewport=child=>node({resourceName:'id/Viewport',bounds:{left:0,top:312,right:600,bottom:900},children:[child]});
 const clippedTitle=node({text:'Partial note',editable:true,bounds:{left:100,top:199,right:300,bottom:287}});
 const s={text:'Partial note'};
 for(const extra of [{action:'tap'},{action:'longPress',durationMs:700},{action:'swipe',deltaX:20,deltaY:0,durationMs:700},{action:'inputText',value:'new'}]){
  const h=harness();const r=await dispatch(h,s,tree([viewport(clippedTitle)]),extra);
  assert.equal(r.error,'native_selector_not_found');assert.equal(r.dispatched,false);assert.equal(h.calls.length,0);
 }
 // A partially clipped node is eligible only if the actual chosen center is inside the viewport.
 const h=harness();const r=await dispatch(h,s,tree([viewport({...clippedTitle,bounds:{left:100,top:300,right:300,bottom:380}})]));
 assert.equal(r.ok,true);assert.deepEqual(h.calls[0].args.slice(1,3),[200,340]);
 for(const bounds of [null,{left:0,top:0,right:0,bottom:0},{left:NaN,top:0,right:600,bottom:900}]){
  const missing=harness();const t=tree([node({bounds,children:[node({text:'Partial note'})]})]);
  assert.equal((await dispatch(missing,s,t)).error,'native_selector_not_found');assert.equal(missing.calls.length,0);
 }
});

test('scoped anchor and target centers also respect clipping ancestors above the row',async()=>{
 const clipped=row(undefined,{bounds:{left:0,top:200,right:500,bottom:450},children:[
  node({text:'AAB扩展标签-01',bounds:{left:20,top:200,right:100,bottom:270}}),
  node({resourceName:EDIT,bounds:{left:200,top:330,right:280,bottom:400}}),
 ]});
 const t=tree([node({resourceName:`${target.packageName}:id/MainListView`,bounds:{left:0,top:312,right:600,bottom:900},children:[clipped]})]);
 const h=harness();assert.equal((await dispatch(h,selector(),t)).error,'native_scope_anchor_not_found');assert.equal(h.calls.length,0);
 clipped.children[0].bounds={left:20,top:330,right:100,bottom:400};
 clipped.children[1].bounds={left:200,top:200,right:280,bottom:270};
 assert.equal((await dispatch(h,selector(),t)).error,'native_selector_not_found');assert.equal(h.calls.length,0);
});

test('real Intent executor persists scoped decision and dispatches observed row once, stale revision is rejected',async()=>{
 resetIntentOperations();let observes=0;
 const h=harness({bridgeTree:async()=>{observes+=1;return actualLabels;}});
 const store=createIntentEvidenceStore({adapter:createMemoryEvidenceAdapter()});
 const start=await handle({operation:'start',operationId:'scoped-label-edit',goal:'Edit one label',target,adapter:h.adapter,store});
 assert.equal(start.status,'waiting_for_decision');const observed=store.latest(start.operationId,'observation');
 const decision={decisionId:'edit-exact-row',agentDecision:'act',basedOnRevision:start.revision,action:{provider:'native',action:'tap',selector:selector()}};
 const next=await handle({operation:'decide',operationId:start.operationId,decision});assert.equal(next.status,'waiting_for_decision');assert.equal(h.calls.length,1);assert.equal(observes,2);
 const receipt=store.latest(start.operationId,'action-receipt');assert.deepEqual(receipt.action.selector,selector());assert.equal(receipt.rawTreeId,observed.rawTreeId);assert.equal(receipt.mechanicalStatus,'ok');
 const stale=await handle({operation:'decide',operationId:start.operationId,decision:{...decision,decisionId:'stale-edit'}});assert.equal(stale.error,'reobserve_required');assert.equal(h.calls.length,1);
});
