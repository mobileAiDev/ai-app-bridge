#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual:equal}=require('node:util');
const ROOT=path.resolve(__dirname,'../../..'),CLI=path.join(ROOT,'desktop/ai-app-bridge-cli');
const {createMcpClient,payloadOf}=require(path.join(CLI,'scripts/validation/mcp-jsonrpc-client'));
const {hostCodeManifest}=require('./run-regression');
const PACKAGE='io.github.mobileaidev.notallyx.sample',PICKER='com.coloros.filemanager';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const {expectedUi}=require('./backup-expectations');
async function main(options) {
  if(!/^[A-Za-z0-9_.:-]+$/.test(options.serial||'')||!options.apk||!options.out||!options.noteTitle||!options.zip4jJar)throw Error('serial_apk_out_note_title_zip4j_jar_required');
  const out=path.resolve(options.out);if(fs.existsSync(out))throw Error('new_output_directory_required');fs.mkdirSync(out,{recursive:true});
  const runId=`backup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,target={serial:options.serial,packageName:PACKAGE};
  const fixtureDirectory=`AAB-${Date.now()}`,remoteDirectory=`/sdcard/Documents/${fixtureDirectory}`;
  const frozen=path.join(out,'frozen');fs.mkdirSync(frozen);
  const sourceIndexPath=path.join(__dirname,'backup-source-evidence-index.json');
  const sourceIndex=read(sourceIndexPath);
  for(const file of sourceIndex.artifacts)if(hash(path.join(ROOT,file.path))!==file.sha256)throw Error('intent_source_evidence_changed:'+file.path);
  fs.copyFileSync(sourceIndexPath,path.join(frozen,'backup-source-evidence-index.json'));
  const sourceNames=['backup-script.js','backup-epoch-script.js','backup-ui.js','backup-oracles.js','backup-expectations.js','ui-oracles.js','oracles.js','collector.js','read_snapshot.py','read_backup_zip.py','BackupFixtures.java','run-backup-regression.js','review-backup-regression.js'];
  for(const name of sourceNames)fs.copyFileSync(path.join(__dirname,name),path.join(frozen,name));
  fs.copyFileSync(path.join(CLI,'bin/shared-kernel/xml-attributes.js'),path.join(frozen,'xml-attributes.js'));
  fs.copyFileSync(options.zip4jJar,path.join(frozen,'zip4j.jar'));
  const hostCode=hostCodeManifest();write(path.join(frozen,'host-code-manifest.json'),hostCode);
  for(const file of hostCode.artifacts){const destination=path.join(out,'host-code',path.relative(ROOT,file.path));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(file.path,destination);}
  const sourceArtifacts=fs.readdirSync(frozen).map(name=>({path:path.join(frozen,name),sha256:hash(path.join(frozen,name))}));
  const identity={runId,target,apkSha256:hash(options.apk),scriptSha256:hash(path.join(frozen,'backup-script.js')),
    hostCodeManifestSha256:hash(path.join(frozen,'host-code-manifest.json')),noteTitle:options.noteTitle,remoteDirectory,sourceArtifacts};write(path.join(out,'identity.json'),identity);
  const {collectSnapshot}=require(path.join(frozen,'collector'));
  const {readSnapshot}=require(path.join(frozen,'oracles'));
  const {transition,checkUi,checkZip,observedException}=require(path.join(frozen,'backup-oracles'));
  const {parseXmlAttributes}=require(path.join(frozen,'xml-attributes'));
  const result={schemaVersion:'aab.notallyx-backup-regression/v1',ok:false,fullAppPassed:false,identity,startedAtMs:Date.now(),phases:[],snapshots:[],checks:[],runtimeEpochs:[],
    scope:'Fixed private notes, labels and parent/child lists. No attachment/reminder coverage, duplicate-disabled import, App password-setting/export, other providers or full 143-template acceptance.'};
  const save=()=>write(path.join(out,'result.json'),result);
  let client,operationId,sequence=0,lastEpoch=null;
  function adb(args,{allowed=[0],binary=false}={}) {
    const startedAtMs=Date.now();const r=spawnSync(options.adb||'adb',['-s',options.serial,...args],{timeout:30000,maxBuffer:256*1024*1024});
    const bytes=Buffer.from(r.stdout||'');fs.appendFileSync(path.join(out,'adb.jsonl'),JSON.stringify({argv:['adb','-s',options.serial,...args],startedAtMs,finishedAtMs:Date.now(),exitCode:r.status,
      stderr:String(r.stderr||''),stdoutSha256:sha(bytes),stdoutBytes:bytes.length,...(!binary?{stdout:bytes.toString()}: {})})+'\n');
    if(r.error||!allowed.includes(r.status))throw Error(`adb:${args[0]}:${r.error?.message||r.stderr||r.status}`);return binary?bytes:bytes.toString().trim();
  }
  async function run(command,args={}) {const r=payloadOf(await client.request('tools/call',{name:'run',arguments:{command,arguments:{...target,feedback:'off',...args}}}));
    if((r.ok===false||r.error)&&!(command==='script'&&r.operationId&&['failed','cancelled'].includes(r.status)))throw Error(`${command}:${r.error}`);return r;}
  async function launch(name) {
    write(path.join(out,name+'-launch.json'),await run('launch-app',{clearTask:true}));let status;const deadline=Date.now()+20000;
    do {try {status=await run('status');if(status.app?.packageName===PACKAGE&&status.debugBridge?.runtimeEpoch
      &&status.capturePersistence?.persistent===true&&status.capturePersistence.attachmentState==='attached')break;}catch(error){status={error:error.message};}
      await new Promise(resolve=>setTimeout(resolve,150));}while(Date.now()<deadline);
    if(!status.debugBridge?.runtimeEpoch||status.capturePersistence?.persistent!==true||status.capturePersistence.attachmentState!=='attached')throw Error('attached_capture_runtime_epoch_required');
    if(status.debugBridge.runtimeEpoch===lastEpoch)throw Error('cold_launch_must_have_new_runtime_epoch');
    result.runtimeEpochs.push({name,previousEpoch:lastEpoch,runtimeEpoch:status.debugBridge.runtimeEpoch,updatedAtMs:status.updatedAtMs});
    lastEpoch=status.debugBridge.runtimeEpoch;write(path.join(out,name+'-status.json'),status);save();return status;
  }
  function snapshot(name) {
    const directory=path.join(out,name),minCapturedAtMs=Date.now();
    const manifest=collectSnapshot({...target,out:directory,runId,sequence,apkSha256:identity.apkSha256,adb:options.adb||'adb'});
    const r=readSnapshot(manifest,{expectedTarget:target,expectedApkSha256:identity.apkSha256,runId,afterSequence:sequence,minCapturedAtMs});write(path.join(directory,'observed.json'),r);
    if(!r.ok)throw Error('snapshot:'+r.reason);result.snapshots.push({name,manifestPath:path.join(directory,'snapshot.json'),snapshotId:r.snapshotId,sequence});save();return r;
  }
  function check(name,condition,details={}) {result.checks.push({name,verdict:condition?'passed':'failed',...details});save();if(!condition)throw Error('independent_oracle:'+name);}
  async function epochProof(record,directory) {
    const out=path.join(directory,'epoch-proof');fs.mkdirSync(out);
    const start=await run('script',{operation:'start',script:{schemaVersion:'aab.code-script/v1',name:'notallyx-epoch-evidence',language:'javascript',sourcePath:path.join(frozen,'backup-epoch-script.js'),
      target,inputs:{out,runtimeEpoch:record.runtimeEpoch,previousEpoch:result.runtimeEpochs.at(-1).previousEpoch,sinceMs:record.deviceStartedAtMs,operationId:record.operationId},policy:{timeoutMs:30000,onFailure:'fail',restartPolicy:'none'}}});
    write(path.join(out,'start.json'),start);let current=start;
    while(!['completed','failed','cancelled'].includes(current.status))current=await run('script',{operation:'wait',operationId:start.operationId,waitMs:1000,afterSequence:current.eventSequence||0});
    const final=await run('script',{operation:'status',operationId:start.operationId,afterSequence:0,limit:4096});write(path.join(out,'final.json'),final);
    record.epochProof={operationId:start.operationId,status:current.status,path:out};save();
    if(current.status!=='completed')throw Error('epoch_proof_failed:'+current.error);
    const proof=read(path.join(out,'result.json'));
    check(record.phase+'-current-epoch',proof.afterOperationId===record.operationId&&proof.runtimeEpoch===record.runtimeEpoch&&proof.currentProof.verdict==='passed'
      &&final.events.some(e=>e.type==='assertion_passed'&&e.name==='epoch-current'&&e.observationId===proof.events.evidence.observationId));
    if(proof.previousEpoch)check(record.phase+'-old-epoch-rejected',proof.old.error==='runtime_epoch_changed'&&proof.oldProof.verdict==='inconclusive'
      &&final.events.some(e=>e.type==='assertion_inconclusive'&&e.name==='epoch-old-rejected'));
  }
  async function phase(name,filename) {
    await launch(name);const directory=path.join(out,name);fs.mkdirSync(directory);
    const pid=adb(['shell','pidof',PACKAGE]);if(!/^\d+$/.test(pid))throw Error('one_sample_pid_required');
    const startedAtMs=Date.now();const start=await run('script',{operation:'start',script:{schemaVersion:'aab.code-script/v1',name:'notallyx-backup-'+name,language:'javascript',
      sourcePath:path.join(frozen,'backup-script.js'),target,inputs:{out:directory,moduleDirectory:frozen,runId,phase:name,fixtureDirectory,filename,noteTitle:options.noteTitle,
        previousEpoch:result.runtimeEpochs.at(-1).previousEpoch},
      policy:{timeoutMs:240000,onFailure:'fail',restartPolicy:'none'}}});
    operationId=start.operationId;write(path.join(directory,'start.json'),start);if(!operationId)throw Error('script_operation_required');
    let current=start;const deadline=Date.now()+250000;
    while(!['completed','failed','cancelled'].includes(current.status)){
      if(Date.now()>deadline)throw Error('script_wait_deadline');current=await run('script',{operation:'wait',operationId,waitMs:1000,afterSequence:current.eventSequence||0});
      if(['paused','intervention_required'].includes(current.status))throw Error('script_attention:'+current.status);
    }
    const final=await run('script',{operation:'status',operationId,afterSequence:0,limit:4096});write(path.join(directory,'final.json'),final);
    const logcat=adb(['logcat','-d','--pid='+pid,'-v','epoch','-t','3000']);fs.writeFileSync(path.join(directory,'logcat.txt'),logcat+'\n');
    const record={phase:name,operationId,status:current.status,startedAtMs,deviceStartedAtMs:result.runtimeEpochs.at(-1).updatedAtMs,finishedAtMs:Date.now(),pid,logcatPath:path.join(directory,'logcat.txt'),runtimeEpoch:lastEpoch};result.phases.push(record);save();operationId=null;
    if(current.status!=='completed')throw Error(`script_failed:${name}:${current.error}`);
    const local=read(path.join(directory,'result.json'));
    if(final.history?.hasMore!==false||final.history?.gap||local.runId!==runId||local.phase!==name)throw Error('complete_identified_script_history_required');
    const actions=final.history.items.filter(item=>item.kind==='call_completed'&&item.actionId);
    if(actions.some(item=>item.executionId!==record.operationId||item.payloadSummary?.error||item.target?.serial!==target.serial
      ||![PACKAGE,PICKER].includes(item.target.packageName))||new Set(actions.map(item=>item.actionId)).size!==actions.length||actions.length!==local.mutations)throw Error('host_mutation_history_mismatch');
    sequence+=actions.length;record.hostMutationCount=actions.length;
    record.checkpoints=local.checkpoints.map(cp=>({...cp,runId,operationId:record.operationId,phaseStartedAtMs:startedAtMs,phaseFinishedAtMs:record.finishedAtMs,
      ...Object.fromEntries([['tree','treePath'],['afterTree','afterTreePath'],['screenshot','screenshotPath'],['screenshotResponse','screenshotResponsePath']].map(([k,p])=>[k,{path:cp[p],sha256:hash(cp[p])}]))}));
    const expected=expectedUi(name,{filename,noteTitle:options.noteTitle});
    if(record.checkpoints.length!==expected.length)throw Error('exact_checkpoint_inventory_required');
    for(const item of expected){const checkpoints=record.checkpoints.filter(cp=>cp.name===item.name);if(checkpoints.length!==1)throw Error('one_named_checkpoint_required');
      check(item.name,checkUi({checkpoint:checkpoints[0],expected:item,phase:final,target,parseXmlAttributes}));}
    await epochProof(record,directory);
    record.exportFilename=local.exportFilename;record.capture=local.capture;save();return {record,local,logcat};
  }
  try {
    const installed=adb(['shell','pm','path',PACKAGE]).split(/\r?\n/);if(installed.length!==1||!/^package:\/data\/app\/[A-Za-z0-9_./+=~-]+\/base\.apk$/.test(installed[0]))throw Error('single_installed_sample_apk_required');
    if(sha(adb(['exec-out','cat',installed[0].slice(8)],{binary:true}))!==identity.apkSha256)throw Error('installed_apk_sha256_mismatch');
    const before=snapshot('before');
    const controlled=before.data.notes.filter(n=>n.title===options.noteTitle);
    if(controlled.length!==1||controlled[0].type!=='LIST'||controlled[0].folder!=='NOTES'||controlled[0].labels.length
      ||!equal(controlled[0].items.map(n=>n.body),['Parent-A','Child-A1','Child-A2-edited','Parent-B'])||before.data.notes.some(n=>n.folder==='DELETED'
        ||n.images.length||n.files.length||n.audios.length||n.reminders.length||n.isPinnedToStatus))throw Error('explicit_unlabelled_controlled_hierarchy_and_empty_trash_required');
    adb(['shell','mkdir',remoteDirectory]);
    client=createMcpClient({serverPath:path.join(CLI,'bin/mcp-server.js'),transcriptPath:path.join(out,'mcp.jsonl'),stderrPath:path.join(out,'mcp.stderr.log'),env:{AI_APP_BRIDGE_FACT_STORE_DIR:path.join(out,'host-facts')}});await client.initialize();
    const exported=await phase('export');const filename=exported.local.exportFilename;
    const archive=path.join(out,'backup.zip');fs.writeFileSync(archive,adb(['exec-out','cat',remoteDirectory+'/'+filename],{binary:true}));
    const zipRead=spawnSync('python3',[path.join(frozen,'read_backup_zip.py'),archive,path.join(out,'zip')],{encoding:'utf8'});write(path.join(out,'zip-reader.json'),{status:zipRead.status,stdout:zipRead.stdout,stderr:zipRead.stderr});
    if(zipRead.status!==0)throw Error('zip_reader_failed');const zip=read(path.join(out,'zip/observed.json'));
    check('zip-exact-database',checkZip(before,zip),{archiveSha256:hash(archive)});
    check('export-database-unchanged',transition(before,snapshot('export-db'),{kind:'unchanged'}));
    const fixtures=path.join(out,'fixtures');const created=spawnSync('java',['--class-path',path.join(frozen,'zip4j.jar'),path.join(frozen,'BackupFixtures.java'),path.join(out,'zip/NotallyDatabase'),fixtures],{encoding:'utf8',timeout:30000});
    write(path.join(out,'fixture-generation.json'),{status:created.status,stdout:created.stdout,stderr:created.stderr});if(created.status!==0)throw Error('negative_fixture_generation_failed');
    const fixtureFiles=fs.readdirSync(fixtures).map(name=>({name,path:path.join(fixtures,name),sha256:hash(path.join(fixtures,name))}));
    for(const file of fixtureFiles){adb(['push',file.path,remoteDirectory+'/'+file.name]);if(sha(adb(['exec-out','cat',remoteDirectory+'/'+file.name],{binary:true}))!==file.sha256)throw Error('device_fixture_hash_mismatch');}
    write(path.join(out,'fixture-files.json'),fixtureFiles);
    for(const [name,file] of [['cancel',filename],['corrupt','AAB-corrupt.zip'],['missing-db','AAB-missing-db.zip'],['wrong-password','AAB-encrypted.zip'],['correct-password','AAB-encrypted.zip']]) {
      const current=await phase(name,file);check(name+'-database-unchanged',transition(before,snapshot(name+'-db'),{kind:'unchanged'}));
      if(['corrupt','missing-db','wrong-password'].includes(name)) {
        check(name+'-exception-observed',observedException(current.logcat,current.record),{logcatPath:current.record.logcatPath,pid:current.record.pid});
      }
    }
    await phase('delete');check('only-controlled-note-deleted',transition(before,snapshot('deleted-db'),{kind:'delete',noteTitle:options.noteTitle}));
    await phase('restore',filename);const restored=snapshot('restored-db');check('restored-exact-note-except-new-id',transition(before,restored,{kind:'restore',noteTitle:options.noteTitle}));
    await phase('cold');check('cold-database-unchanged',transition(restored,snapshot('cold-db'),{kind:'unchanged'}));
    check('frozen-sources-unchanged',sourceArtifacts.every(file=>hash(file.path)===file.sha256));
    check('host-sources-unchanged',hostCode.artifacts.every(file=>hash(file.path)===file.sha256));
    result.ok=true;
  }catch(error){result.error=error.message;}
  finally {if(client){if(operationId)try{write(path.join(out,'cancel-active.json'),await run('script',{operation:'cancel',operationId}));}catch(error){result.cancelError=error.message;}
    await client.close();}}
  result.finishedAtMs=Date.now();result.wallMs=result.finishedAtMs-result.startedAtMs;save();
  write(path.join(out,'execution-records.json'),{runId,phases:result.phases.flatMap(phase=>[
    {phase:phase.phase,operationId:phase.operationId},...(phase.epochProof?[{phase:phase.phase+'-epoch',operationId:phase.epochProof.operationId}]:[])]),snapshots:result.snapshots});
  const artifacts=[];function collect(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){if(item.name==='host-facts'||item.name==='archive-manifest.json')continue;
    const file=path.join(directory,item.name);if(item.isDirectory())collect(file);else artifacts.push({path:file,sha256:hash(file),bytes:fs.statSync(file).size});}}collect(out);
  write(path.join(out,'archive-manifest.json'),{runId,artifacts});
  return {ok:result.ok,out,runId,wallMs:result.wallMs,phases:result.phases.length,uiCheckpoints:result.phases.reduce((n,p)=>n+(p.checkpoints?.length||0),0),snapshots:result.snapshots.length,error:result.error};
}
if(require.main===module){const options={};for(let i=2;i<process.argv.length;i+=2){const flag=process.argv[i];if(!['--serial','--apk','--out','--note-title','--zip4j-jar','--adb'].includes(flag)||!process.argv[i+1])throw Error('explicit_named_arguments_required');options[flag.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=process.argv[i+1];}
  main(options).then(r=>{console.log(JSON.stringify(r,null,2));if(!r.ok)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});}
module.exports={main,expectedUi};
