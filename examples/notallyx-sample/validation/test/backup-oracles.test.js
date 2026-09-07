'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {transition,checkZip,observedException}=require('../backup-oracles');
const {fixture}=require('./helpers/backup-snapshot');
const {PACKAGE,PICKER,view,find}=require('../backup-ui');
const {parseXmlAttributes}=require('../../../../desktop/ai-app-bridge-cli/bin/shared-kernel/xml-attributes');
function data() {const note=(id)=>({id,type:'LIST',folder:'NOTES',color:'#123456',title:'list-'+id,pinned:false,timestamp:100,modifiedTimestamp:200,
  labels:[],body:'',spans:[],items:[{body:'Parent',checked:false,isChild:false,order:0},{body:'Child',checked:false,isChild:true,order:1}],
  images:[],files:[],audios:[],reminders:[],viewMode:'EDIT',isPinnedToStatus:false});
  return {notes:[note(1),note(2)],labels:[{value:'one',order:0}],preferences:{dataSchemaId:2}};}
const after=(t,d,opts={})=>fixture(t,d,{start:10000,sequence:2,...opts});
test('exception proof requires the current process, device time window and error level',()=>{
  const line='1001.002 1234 2345 E Import: net.lingala.zip4j.exception.ZipException: Wrong Password!';
  const scope={phase:'wrong-password',pid:'1234',deviceStartedAtMs:1000000};assert(observedException(line,scope));
  assert.equal(observedException(line,{...scope,pid:'2345'}),false);
  assert.equal(observedException(line,{...scope,deviceStartedAtMs:1002000}),false);
  assert.equal(observedException(line.replace(' E ',' I '),scope),false);
});
test('backup oracle rejects fabricated, stale and other-device snapshots',t=>{
  const a=fixture(t,data()),b=after(t,data());
  assert.equal(transition(a,b,{kind:'unchanged'}),true);
  for(const value of [structuredClone(b),a,after(t,data(),{serial:'other'}),after(t,data(),{runId:'other'})])
    assert.throws(()=>transition(a,value,{kind:'unchanged'}));
});
test('backup deletion and restoration permit one exact controlled identity change only',t=>{
  const original=data(),a=fixture(t,original),deleted=data();deleted.notes.pop();
  assert.equal(transition(a,after(t,deleted),{kind:'delete',noteTitle:'list-2'}),true);
  const restored=data();restored.notes[1].id=3;
  assert.equal(transition(a,after(t,restored),{kind:'restore',noteTitle:'list-2'}),true);
  for(const change of [d=>d.notes[0].body='changed',d=>d.notes[1].items[1].isChild=false,d=>d.labels.pop(),d=>d.preferences.dataSchemaId=3]){
    const broken=structuredClone(restored);change(broken);
    assert.equal(transition(a,after(t,broken),{kind:'restore',noteTitle:'list-2'}),false);
  }
  assert.equal(transition(a,after(t,original),{kind:'restore',noteTitle:'list-2'}),false);
});
test('wrong-password/cancel oracle detects partial writes despite a matching note count',t=>{
  const a=fixture(t,data()),bad=data();bad.notes[0].items[1].checked=true;
  assert.equal(transition(a,after(t,bad),{kind:'unchanged'}),false);
  const zip={ok:true,data:structuredClone(a.data)};assert.equal(checkZip(a,zip),true);
  zip.data.notes[1].labels=['one'];assert.equal(checkZip(a,zip),false);
});
test('picker labels retain XML semantics and only owned filename display breaks are removed',()=>{
  const xml=`<hierarchy><node package="${PICKER}" enabled="true" bounds="[0,0][1080,2414]"><node package="${PICKER}" enabled="true" text="NotallyX Backup 2026-09-07 &#10;17-00.zip" bounds="[20,300][700,410]"/></node></hierarchy>`;
  const v=view(xml,PICKER,parseXmlAttributes);
  assert.equal(find(v,{displayFilename:'NotallyX Backup 2026-09-07 17-00.zip'}).length,1);
  assert.equal(find(v,{displayFilename:'NotallyX Backup 2026-09-07 17-01.zip'}).length,0);
  assert.throws(()=>view(xml.replaceAll(PICKER,PACKAGE),PICKER,parseXmlAttributes),/foreground/);
});
