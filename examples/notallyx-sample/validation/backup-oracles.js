'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {issuedResponse}=require('./ui-oracles');
const {canonical}=require('./oracles');
const {PACKAGE,PICKER,view,find,key}=require('./backup-ui');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function transition(before,after,{kind,noteTitle}) {
  const a=canonical(before),b=canonical(after);
  if(before.snapshotId===after.snapshotId||after.capturedAtMs<=before.capturedAtMs||after.capturedAfterSequence<=before.capturedAfterSequence
    ||before.runId!==after.runId||!equal(before.target,after.target)||!equal(before.identity,after.identity))throw Error('fresh_identical_target_snapshot_required');
  if(kind==='unchanged')return equal(a,b);
  const note=a.notes.filter(n=>n.title===noteTitle);
  if(note.length!==1)throw Error('one_exact_controlled_note_required');
  const rest={...a,notes:a.notes.filter(n=>n.id!==note[0].id)};
  if(kind==='delete')return equal(rest,b);
  if(kind!=='restore')throw Error('explicit_transition_required');
  const restored=b.notes.filter(n=>n.title===noteTitle);
  return restored.length===1&&restored[0].id!==note[0].id&&equal({...restored[0],id:note[0].id},note[0])
    &&equal(rest,{...b,notes:b.notes.filter(n=>n.id!==restored[0].id)});
}
function checkUi({checkpoint,expected,phase,target,parseXmlAttributes}) {
  const cp=checkpoint,route=expected.route;
  if(cp.route!==route||![PACKAGE,PICKER].includes(route))throw Error('exact_ui_route_required');
  const actualTarget={...target,packageName:route},command=route===PACKAGE?'tree':'uia-tree';
  const before=issuedResponse(cp,cp.tree,command,cp.name,phase,actualTarget);
  const shot=issuedResponse(cp,cp.screenshotResponse,'screenshot',cp.name+'-screenshot',phase,actualTarget);
  const after=issuedResponse(cp,cp.afterTree,command,cp.name+'-after-screenshot',phase,actualTarget);
  const bytes=fs.readFileSync(cp.screenshot.path);
  if(hash(bytes)!==cp.screenshot.sha256||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('screenshot_hash_or_format');
  const a=view(before.result,route,parseXmlAttributes),b=view(after.result,route,parseXmlAttributes);
  if(shot.result.path!==cp.screenshot.path||shot.result.foregroundMatchesPackage!==true||shot.result.foreground?.packageName!==route
    ||shot.result.foreground?.activity!==a.activity||a.activity!==b.activity||shot.result.artifact?.sha256!==cp.screenshot.sha256
    ||!shot.evidence.refs.some(ref=>ref.sha256===cp.screenshot.sha256&&ref.screenshotId===cp.screenshot.path)
    ||shot.result.width!==bytes.readUInt32BE(16)||shot.result.height!==bytes.readUInt32BE(20))throw Error('same_foreground_screenshot_required');
  if(key(a)!==key(b))throw Error('ui_changed_during_screenshot');
  const times=[cp.phaseStartedAtMs,cp.startedAtMs,before.evidence.window.closedAtMs,shot.evidence.window.closedAtMs,
    after.evidence.window.closedAtMs,cp.finishedAtMs,cp.phaseFinishedAtMs];
  if(!times.every(Number.isFinite)||!times.every((v,i)=>!i||v>=times[i-1]))throw Error('ui_time_order');
  return [a,b].every(v=>expected.present.every(s=>find(v,s).length===1)&&(expected.absent||[]).every(s=>find(v,s).length===0));
}
function checkZip(before,zip) {
  canonical(before);
  if(!zip?.ok)throw Error('verified_database_and_zip_required');
  if(before.data.notes.some(n=>['images','files','audios','reminders'].some(k=>n[k].length)))throw Error('full_attachment_fixture_not_supported');
  return ['schemaVersion','roomIdentity','notes','labels'].every(k=>equal(before.data[k],zip.data[k]));
}
function observedException(logcat,{phase,pid,deviceStartedAtMs}) {
  const marker={'corrupt':'Zip headers not found. Probably not a zip file','missing-db':'No file found with name NotallyDatabase in zip file','wrong-password':'Wrong Password'}[phase];
  if(!marker||!/^\d+$/.test(pid)||!Number.isFinite(deviceStartedAtMs))throw Error('explicit_log_exception_window_required');
  return logcat.split('\n').some(line=>{const m=/^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+E\s+[^:]+:\s*(.*)$/.exec(line);
    return m&&m[2]===pid&&Number(m[1])*1000>=deviceStartedAtMs&&m[3].toLowerCase().includes(marker.toLowerCase());});
}
module.exports={transition,checkUi,checkZip,observedException};
