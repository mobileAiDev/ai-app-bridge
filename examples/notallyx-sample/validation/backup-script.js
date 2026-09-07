'use strict';
// All phone interactions use the public Script SDK. ADB in the controller only provisions
// named fixtures and collects independent file/SQLite evidence while the App is stopped.
module.exports.main=async function main(ctx) {
  const fs=require('node:fs'),path=require('node:path');
  const ui=require(path.join(ctx.inputs.moduleDirectory,'backup-ui'));const {PACKAGE,PICKER,find,key,matches}=ui;
  const {parseXmlAttributes}=require(path.join(ctx.inputs.moduleDirectory,'xml-attributes'));
  const view=(result,route)=>ui.view(result,route,parseXmlAttributes);
  const {out,runId,phase,fixtureDirectory,filename,noteTitle}=ctx.inputs;
  const result={runId,phase,status:'running',mutations:0,lastActionId:null,checkpoints:[],startedAtMs:Date.now()};
  fs.mkdirSync(out,{recursive:true});
  const save=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  let lastMutationRoute=PACKAGE;
  const write=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2));
  async function call(command,args={}) {
    const r=await ctx.call(command,{feedback:'off',...args});
    fs.appendFileSync(path.join(out,'calls.jsonl'),JSON.stringify({atMs:Date.now(),command,args,response:r})+'\n');
    if(!r.ok)throw Error(`${command}:${r.error}`);
    if(r.execution?.actionId){result.mutations++;result.lastActionId=r.execution.actionId;lastMutationRoute=args.packageName||PACKAGE;save();}
    return r;
  }
  async function observe(route,predicate,label) {
    let previous; const deadline=Date.now()+20000;
    do {
      // The SDK can return the App's background tree during system activity transitions.
      // Wait for the actual foreground hierarchy before accepting any native observation.
      if(route===PACKAGE&&lastMutationRoute===PICKER){
        const guard=await call('uia-tree',{packageName:PACKAGE});
        const root=typeof guard.result==='string'?/<node\b[^>]*>/.exec(guard.result):null;
        if(!root||parseXmlAttributes(root[0]).package!==PACKAGE)continue;
        lastMutationRoute=PACKAGE;
      }
      const r=await call(route===PACKAGE?'tree':'uia-tree',{packageName:route});
      if(route===PICKER){const root=typeof r.result==='string'?/<node\b[^>]*>/.exec(r.result):null;
        if(!root||parseXmlAttributes(root[0]).package!==PICKER)continue;}
      const v=view(r.result,route),k=key(v),stable=k===previous;previous=k;
      if(stable&&predicate(v))return {r,v};
      await new Promise(resolve=>setTimeout(resolve,150));
    }while(Date.now()<deadline);
    throw Error(`observed_postcondition_timeout:${label}`);
  }
  async function target(route,selector) {const observed=await observe(route,v=>find(v,selector).length===1,JSON.stringify(selector));
    const n=find(observed.v,selector)[0];return {tapX:(n.bounds.left+n.bounds.right)/2,tapY:(n.bounds.top+n.bounds.bottom)/2,node:n};}
  async function tap(selector,route=PACKAGE) {const p=await target(route,selector);return call('tap',{packageName:route,tapX:p.tapX,tapY:p.tapY,...(route===PACKAGE?{appLocalAction:true}:{})});}
  async function checkpoint(name,route,present,absent=[]) {
    const expected={present,absent},startedAtMs=Date.now();
    const {r,v}=await observe(route,v=>matches(v,expected),name);
    const treePath=path.join(out,`${name}.tree.json`);write(`${name}.tree.json`,r);
    const assertion=await ctx.assert({name,scope:'device',condition:matches(v,expected),evidence:r.evidence,requiredEvidence:['tree'],requireCoverage:'complete'});
    if(assertion.verdict!=='passed')throw Error(`tree_evidence:${name}`);
    const screenshotPath=path.join(out,`${name}.png`);
    const screenshot=await call('screenshot',{packageName:route,outFile:screenshotPath});write(`${name}.screenshot.json`,screenshot);
    const shotProof=await ctx.assert({name:`${name}-screenshot`,scope:'device',condition:screenshot.result.foregroundMatchesPackage===true,
      evidence:screenshot.evidence,requiredEvidence:['screenshot'],requireCoverage:'complete'});
    const after=await call(route===PACKAGE?'tree':'uia-tree',{packageName:route});write(`${name}.after-tree.json`,after);
    const stable=await ctx.assert({name:`${name}-after-screenshot`,scope:'device',condition:matches(view(after.result,route),expected)&&key(v)===key(view(after.result,route)),
      evidence:after.evidence,requiredEvidence:['tree'],requireCoverage:'complete'});
    result.checkpoints.push({name,route,treePath,screenshotPath,afterTreePath:path.join(out,`${name}.after-tree.json`),
      screenshotResponsePath:path.join(out,`${name}.screenshot.json`),startedAtMs,finishedAtMs:Date.now(),afterActionId:result.lastActionId,mutationSequence:result.mutations});save();
    if(shotProof.verdict!=='passed'||stable.verdict!=='passed')throw Error(`same_state_screenshot:${name}`);
    return v;
  }
  async function navigate(title) {await tap({contentDescription:'打开抽屉式导航栏'});await tap({resourceName:`${PACKAGE}:id/design_menu_item_text`,text:title});
    await observe(PACKAGE,v=>find(v,{resourceName:`${PACKAGE}:id/design_menu_item_text`,text:title}).length===0
      &&find(v,{text:title}).length===1,`navigation:${title}`);}
  async function settings() {
    await navigate('设置');
    for(let i=0;i<8;i++) {
      const {v}=await observe(PACKAGE,()=>true,'settings-stable');
      if(find(v,{text:'导入备份'}).length===1&&find(v,{text:'导出备份'}).length===1)return;
      const scroll=find(v,{className:'androidx.core.widget.NestedScrollView'});if(scroll.length!==1)throw Error('settings_scroll_view_required');
      const b=scroll[0].bounds;await call('swipe',{startX:(b.left+b.right)/2,startY:b.bottom-(b.bottom-b.top)*0.15,
        endX:(b.left+b.right)/2,endY:b.top+(b.bottom-b.top)*0.15,durationMs:500});
    }
    throw Error('backup_settings_not_revealed');
  }
  const settingsSelectors=[{text:'导入备份'},{text:'导出备份'}];
  const dialogSelectors=[{text:'备份密码'},{resourceName:'android:id/button1',text:'导入备份'},{resourceName:'android:id/button2',text:'取消'}];
  async function importFile(name) {
    await tap({text:'导入备份'});
    await observe(PICKER,()=>true,'picker-ready');
    // Named folder navigation is intentional: adb-provisioned files need not appear in Recents.
    await tap({text:'文件'},PICKER);
    await tap({text:'全部文件'},PICKER);await tap({text:'Documents'},PICKER);
    await tap({text:fixtureDirectory},PICKER);
    await checkpoint(`${phase}-picker`,PICKER,[{displayFilename:name}]);
    await tap({displayFilename:name},PICKER);
    await checkpoint(`${phase}-dialog`,PACKAGE,dialogSelectors);
  }
  async function capture(name) {
    const status=await call('status'); const epoch=status.result.debugBridge?.runtimeEpoch;
    if(!epoch)throw Error('explicit_runtime_epoch_required');
    const r=await call('logs',{runtimeEpoch:epoch,sinceMs:result.startedAtMs,limit:500});write(`${name}-logs.json`,r);
    result.capture={runtimeEpoch:epoch,path:path.join(out,`${name}-logs.json`),coverage:r.evidence?.coverage};save();
  }
  try {
    if(phase==='cold') {
      await navigate('未加标签');
      await checkpoint('cold-overview',PACKAGE,[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}]);
      await tap({resourceName:`${PACKAGE}:id/Title`,text:noteTitle});
      await checkpoint('cold-editor',PACKAGE,[{resourceName:`${PACKAGE}:id/EnterTitle`,text:noteTitle},
        {text:'Parent-A'},{text:'Child-A1'},{text:'Child-A2-edited'},{text:'Parent-B'}]);
      await call('keyevent',{keyCode:4});await capture(phase);
    } else if(phase==='delete') {
      await navigate('未加标签');
      await checkpoint('delete-before',PACKAGE,[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}]);
      const p=await target(PACKAGE,{resourceName:`${PACKAGE}:id/Title`,text:noteTitle});
      await call('swipe',{startX:p.tapX,startY:p.tapY,endX:p.tapX,endY:p.tapY,durationMs:800});
      await tap({contentDescription:'删除'});await navigate('已删除');
      await checkpoint('delete-trash',PACKAGE,[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}]);
      const q=await target(PACKAGE,{resourceName:`${PACKAGE}:id/Title`,text:noteTitle});
      await call('swipe',{startX:q.tapX,startY:q.tapY,endX:q.tapX,endY:q.tapY,durationMs:800});
      await tap({contentDescription:'永久删除'});
      await checkpoint('delete-confirm',PACKAGE,[{resourceName:'android:id/button1',text:'删除'},{resourceName:'android:id/button2',text:'取消'}]);
      await tap({resourceName:'android:id/button1',text:'删除'});
      await checkpoint('delete-empty',PACKAGE,[{text:'已删除'}],[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}]);
      await capture(phase);
    } else {
      await settings();await checkpoint(`${phase}-settings`,PACKAGE,settingsSelectors);
      if(phase==='export') {
        await tap({text:'导出备份'});await observe(PICKER,()=>true,'export-picker-ready');
        await tap({text:'全部文件'},PICKER);await tap({text:'Documents'},PICKER);await tap({text:fixtureDirectory},PICKER);
        const v=await checkpoint('export-destination',PICKER,[{text:'保存'},{className:'android.widget.EditText'}]);
        const entries=find(v,{className:'android.widget.EditText'});const name=entries[0].text;
        if(!/^NotallyX Backup \d{4}-\d{2}-\d{2} \d{2}-\d{2}$/.test(name))throw Error('observed_export_filename_required');
        result.exportFilename=name+'.zip';save();await tap({text:'保存'},PICKER);
        await checkpoint('export-returned',PACKAGE,settingsSelectors);await capture(phase);
      } else {
        await importFile(filename);
        if(phase==='cancel'){await tap({resourceName:'android:id/button2',text:'取消'});}
        else {
          if(['wrong-password','correct-password'].includes(phase)) {
            const p=await target(PACKAGE,{resourceName:`${PACKAGE}:id/InputText`});
            if(p.node.editable!==true)throw Error('password_input_not_editable');
            await call('input-text',{tapX:p.tapX,tapY:p.tapY,text:phase==='wrong-password'?'AAB-wrong-42':'AAB-test-42',appLocalAction:true});
            await call('keyevent',{keyCode:111});
          }
          await tap({resourceName:'android:id/button1',text:'导入备份'});
          // The controller additionally verifies the resulting DB and exact process-scoped logcat events.
          await new Promise(resolve=>setTimeout(resolve,1400));
        }
        await checkpoint(`${phase}-returned`,PACKAGE,settingsSelectors,dialogSelectors);
        await tap({text:'导入备份'});await observe(PICKER,()=>true,'import-reopens-after-return');
        await checkpoint(`${phase}-usable`,PICKER,[{text:'最近'},{text:'文件'}]);await call('keyevent',{packageName:PICKER,keyCode:4});
        await checkpoint(`${phase}-back`,PACKAGE,settingsSelectors);await capture(phase);
      }
    }
    result.status='completed';result.finishedAtMs=Date.now();save();return result;
  } catch(error){result.status='failed';result.error=error.message;result.finishedAtMs=Date.now();save();throw error;}
};
