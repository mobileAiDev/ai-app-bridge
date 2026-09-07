#!/usr/bin/env node
'use strict';
// Reopens the frozen archive without connecting to a phone or trusting saved verdicts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file));
function main(run,out) {
  run=path.resolve(run);out=path.resolve(out);if(fs.existsSync(out))throw Error('new_review_output_required');
  const manifest=read(path.join(run,'archive-manifest.json')),r=read(path.join(run,'result.json'));
  for(const file of manifest.artifacts)assert.equal(hash(file.path),file.sha256,file.path);
  const {readSnapshot}=require(path.join(run,'frozen/oracles'));
  const {transition,checkUi,checkZip,observedException}=require(path.join(run,'frozen/backup-oracles'));
  const {expectedUi}=require(path.join(run,'frozen/backup-expectations'));
  const {parseXmlAttributes}=require(path.join(run,'frozen/xml-attributes'));
  assert.equal(r.ok,true);assert.equal(r.phases.length,9);assert.equal(r.snapshots.length,10);
  const snapshots={};let lastSequence=-1,lastTime=0;
  for(const row of r.snapshots){const m=read(row.manifestPath),s=readSnapshot(m,{expectedTarget:r.identity.target,expectedApkSha256:r.identity.apkSha256,
    runId:r.identity.runId,afterSequence:row.sequence,minCapturedAtMs:r.startedAtMs});assert(s.ok,s.reason);
    assert(s.capturedAfterSequence>lastSequence&&s.capturedAtMs>lastTime);lastSequence=s.capturedAfterSequence;lastTime=s.capturedAtMs;snapshots[row.name]=s;}
  const checks=[];const check=(name,ok)=>{assert.equal(ok,true,name);checks.push(name);};
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'notallyx-backup-review-'));
  try {
    const directory=path.join(temporary,'zip');
    const parsed=spawnSync('python3',[path.join(run,'frozen/read_backup_zip.py'),path.join(run,'backup.zip'),directory],{encoding:'utf8',timeout:30000});
    assert.equal(parsed.status,0,parsed.stderr);
    const zip=read(path.join(directory,'observed.json'));
    assert.deepEqual(zip,read(path.join(run,'zip/observed.json')));
    check('zip',checkZip(snapshots.before,zip));
  } finally {fs.rmSync(temporary,{recursive:true});}
  for(const name of ['export','cancel','corrupt','missing-db','wrong-password','correct-password'])check(name,transition(snapshots.before,snapshots[name+'-db'],{kind:'unchanged'}));
  check('delete',transition(snapshots.before,snapshots['deleted-db'],{kind:'delete',noteTitle:r.identity.noteTitle}));
  check('restore',transition(snapshots.before,snapshots['restored-db'],{kind:'restore',noteTitle:r.identity.noteTitle}));
  check('cold',transition(snapshots['restored-db'],snapshots['cold-db'],{kind:'unchanged'}));
  let checkpoints=0;
  for(const phase of r.phases){
    const final=read(path.join(run,phase.phase,'final.json')),local=read(path.join(run,phase.phase,'result.json'));
    assert.equal(final.status,'completed');assert.equal(final.history.hasMore,false);assert.equal(final.history.gap,false);
    const source=read(path.join(run,phase.phase,'start.json'));
    assert.equal(source.operationId,phase.operationId);
    const input=read(path.join(run,phase.phase,'epoch-proof/result.json'));
    const proof=read(path.join(run,phase.phase,'epoch-proof/final.json'));
    assert.equal(proof.status,'completed');assert.equal(input.afterOperationId,phase.operationId);assert.equal(input.runtimeEpoch,phase.runtimeEpoch);
    assert(input.events.evidence.refs.length>0&&input.events.evidence.refs.every(ref=>ref.runtimeEpoch===phase.runtimeEpoch&&ref.targetKey===r.identity.target.packageName));
    assert(proof.events.some(e=>e.type==='assertion_passed'&&e.name==='epoch-current'&&e.observationId===input.events.evidence.observationId));
    if(input.previousEpoch){assert.equal(input.old.error,'runtime_epoch_changed');assert.equal(input.oldProof.verdict,'inconclusive');}
    const filenames={cancel:r.phases[0].exportFilename,corrupt:'AAB-corrupt.zip','missing-db':'AAB-missing-db.zip','wrong-password':'AAB-encrypted.zip','correct-password':'AAB-encrypted.zip',restore:r.phases[0].exportFilename};
    const expected=expectedUi(phase.phase,{filename:filenames[phase.phase],noteTitle:r.identity.noteTitle});assert.equal(expected.length,phase.checkpoints.length);
    for(const item of expected){const cp=phase.checkpoints.find(p=>p.name===item.name);assert(cp);check(item.name,checkUi({checkpoint:cp,expected:item,phase:final,target:r.identity.target,parseXmlAttributes}));checkpoints++;}
    const actions=final.history.items.filter(e=>e.kind==='call_completed'&&e.actionId);assert.equal(actions.length,phase.hostMutationCount);assert.equal(local.mutations,actions.length);
    if(['corrupt','missing-db','wrong-password'].includes(phase.phase))check(phase.phase+'-exception',observedException(fs.readFileSync(phase.logcatPath,'utf8'),phase));
  }
  const result={ok:true,runId:r.identity.runId,artifactCount:manifest.artifacts.length,uiCheckpoints:checkpoints,snapshots:Object.keys(snapshots).length,
    epochProofs:r.phases.length,checks,source:'frozen-archive-files-and-independent-oracles',reviewerSha256:hash(__filename),fullAppPassed:false};
  fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');return result;
}
if(require.main===module){try{console.log(JSON.stringify(main(process.argv[2],process.argv[3])));}catch(error){console.error(error);process.exitCode=1;}}
module.exports={main};
