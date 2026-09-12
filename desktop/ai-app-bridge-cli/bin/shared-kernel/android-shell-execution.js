'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { execFileBounded } = require('./execution-io');
const { runExecution, checkExecution, currentExecution, withoutExecution, executionSleep, markExecutionDispatched } = require('./execution-scope');
const { runDeviceEffect, isDeviceSettlementDurable } = require('./device-mutation-lease');
const { CommandError } = require('../command-errors');

const schema = 'aab.android-shell-execution/v1';
const rootDirectory = '/data/local/tmp/ai-app-bridge-shell/v1';
const maxRetainedJobs = 512;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const uptimeScript = 'read up ignored < /proc/uptime\nuptime_ms=$(( ${up%.*} * 1000 + 10#${up#*.} * 10 ))\n';

// Each immutable job directory belongs to one command and one Android boot.
// The detached worker publishes a terminal receipt only after the command exits.
// Cancellation can win admission. Once admitted, the original command drains;
// killing a client or its Binder caller is not remote completion evidence.
function createAndroidShellPort({ adb, serial, timeoutMs = 15000, run = execFileBounded } = {}) {
  if (typeof serial !== 'string' || !serial) throw new CommandError('serial_required', 'Android shell execution requires serial.');
  const shell = (script, budgetMs=timeoutMs) => run(adb, ['-s', serial, 'shell', 'sh', '-c', quote(script)], {
    timeoutMs:budgetMs, mutation: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  }).then(r => r.stdout.trim());
  const request = async (script,budgetMs) => {
    let text;
    try { text = await shell(script,budgetMs); }
    catch (error) {
      throw new CommandError(typeof error.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code : 'shell_transport_failed',
        'Android shell transport failed.', { dispatched: error.dispatched ?? null, ambiguous: error.ambiguous ?? true,
          details: { cause: error.code ?? null, stderr: String(error.stderr ?? '').trim().slice(0, 1024) } });
    }
    try { return JSON.parse(text); }
    catch (_) { throw new CommandError('invalid_shell_execution_response', 'The device did not return a valid shell execution response.', { dispatched: null, ambiguous: true }); }
  };
  const identityFields = identity => {
    if (!uuid.test(identity.jobId) || !uuid.test(identity.runtimeEpoch) || typeof identity.actionId !== 'string'
      || !identity.actionId || identity.actionId.length>1024 || !/^[a-f0-9]{64}$/.test(identity.commandSha256)
      || !Number.isSafeInteger(identity.deadlineUptimeMs) || identity.deadlineUptimeMs<1) throw new CommandError('invalid_shell_execution_identity', 'An original shell action identity is required.');
    return { schemaVersion: schema, actionId: identity.actionId, jobId: identity.jobId,
      runtimeEpoch: identity.runtimeEpoch, commandSha256: identity.commandSha256, deadlineUptimeMs:identity.deadlineUptimeMs };
  };
  const checkedDirectory = identity => {
    const fields = identityFields(identity), directory = `${rootDirectory}/${fields.jobId}`;
    return { fields, directory, guard: `job=${quote(directory)}\nexpected=${quote(JSON.stringify(fields))}\n` +
      `if [ "$(cat /proc/sys/kernel/random/boot_id)" != ${quote(fields.runtimeEpoch)} ]; then printf '%s' '{"ok":false,"error":"shell_runtime_changed"}'; exit 0; fi\n` +
      `if [ ! -f "$job/identity.json" ] || [ "$(cat "$job/identity.json")" != "$expected" ]; then printf '%s' '{"ok":false,"error":"shell_execution_not_found"}'; exit 0; fi\n` };
  };
  return {
    async prepare(argv, actionId = randomUUID()) {
      if (!Array.isArray(argv) || !argv.length || !argv[0] || argv.some(v => typeof v !== 'string' || v.includes('\0'))) {
        throw new CommandError('invalid_shell_arguments', 'Shell arguments must be nonempty string argv without NUL.');
      }
      const deadlineMs=Math.min(currentExecution()?.deadlineMs??Infinity,Date.now()+timeoutMs);
      const probe=await request(`command -v setsid >/dev/null && command -v nohup >/dev/null || exit 1\n${uptimeScript}`+
        `printf '{"runtimeEpoch":"%s","uptimeMs":%s}' "$(cat /proc/sys/kernel/random/boot_id)" "$uptime_ms"`);
      if (!uuid.test(probe.runtimeEpoch)||!Number.isSafeInteger(probe.uptimeMs)||probe.uptimeMs<0) throw new CommandError('shell_runtime_unavailable', 'Android boot identity and monotonic uptime are unavailable.');
      const remaining=Math.floor(deadlineMs-Date.now());
      if(remaining<1)throw new CommandError('deadline_exceeded','The execution budget expired before shell preparation.');
      const command = `exec ${argv.map(quote).join(' ')}\n`;
      if (Buffer.byteLength(command) > 65536) throw new CommandError('shell_arguments_too_large', 'The serialized shell command exceeds 64 KiB.');
      const identity={schemaVersion:schema,actionId,jobId:randomUUID(),runtimeEpoch:probe.runtimeEpoch,commandSha256:digest(command),deadlineUptimeMs:probe.uptimeMs+remaining};
      const fields = identityFields(identity), directory = `${rootDirectory}/${fields.jobId}`;
      const prefix = JSON.stringify(fields).slice(0,-1);
      const completedPrefix = `${prefix},"ok":true,"settled":true,"dispatched":true,"ambiguous":false,"exitCode":`;
      const expired = JSON.stringify({ ...fields, ok:false, error:'shell_action_timeout', settled:true, dispatched:false, ambiguous:false, exitCode:null });
      const worker = `job=${quote(directory)}\n` +
        `if ! mkdir "$job/admission" 2>/dev/null; then exit 0; fi\n` +
        `if [ "$(cat /proc/sys/kernel/random/boot_id)" != ${quote(fields.runtimeEpoch)} ]; then exit 1; fi\n` +
        `actual=$(sha256sum "$job/command.sh"); actual=\${actual%% *}\n` +
        `if [ "$actual" != ${quote(fields.commandSha256)} ]; then exit 1; fi\n` +
        uptimeScript +
        `if [ "$uptime_ms" -ge ${fields.deadlineUptimeMs} ]; then printf '%s' ${quote(expired)} >"$job/receipt.tmp" && mv "$job/receipt.tmp" "$job/receipt.json"; exit 0; fi\n` +
        `ulimit -f 128 || exit 1\n` +
        `sh "$job/command.sh" >"$job/stdout" 2>"$job/stderr"\ncode=$?\n` +
        `printf '%s%s%s' ${quote(completedPrefix)} "$code" '}' >"$job/receipt.tmp" && mv "$job/receipt.tmp" "$job/receipt.json"\n`;
      const prepared=await request(`umask 077\nmkdir -p ${quote(rootDirectory)} || exit 1\n` +
        // Android mksh closes descriptors above 2 when launching flock. This
        // noninteractive staging shell retains its lock through inherited stdin.
        `exec 0>${quote(rootDirectory + '/prepare.lock')} || exit 1\nflock -x 0 || exit 1\n` +
        `count=0\nfor candidate in ${quote(rootDirectory)}/*; do\n` +
        `  [ -d "$candidate" ] || continue\n` +
        `  if [ -f "$candidate/acknowledged" ]; then rm -rf "$candidate" || exit 1; else count=$((count + 1)); fi\ndone\n` +
        `if [ "$count" -ge ${maxRetainedJobs} ]; then printf '%s' '{"ok":false,"error":"shell_execution_store_full"}'; exit 0; fi\njob=${quote(directory)}\n` +
        `if ! mkdir "$job" 2>/dev/null; then printf '%s' '{"ok":false,"error":"shell_action_id_reused"}'; exit 0; fi\n` +
        `printf '%s' ${quote(JSON.stringify(fields))} >"$job/identity.tmp" && mv "$job/identity.tmp" "$job/identity.json" || exit 1\n` +
        `printf '%s' ${quote(command)} >"$job/command.sh" || exit 1\n` +
        `printf '%s' ${quote(worker)} >"$job/worker.sh" || exit 1\n` +
        `printf '%s' '{"ok":true,"prepared":true}'`);
      if(prepared.ok!==true||prepared.prepared!==true)throw new CommandError(prepared.error||'shell_preparation_failed','The Android shell job could not be prepared.');
      return identity;
    },
    async start(identity) {
      const {guard}=checkedDirectory(identity);
      return request(guard+
        `if ! mkdir "$job/launched" 2>/dev/null; then printf '%s' '{"ok":false,"error":"shell_action_id_reused"}'; exit 0; fi\n`+
        `setsid nohup sh "$job/worker.sh" </dev/null >"$job/worker.log" 2>&1 &\n` +
        `printf '%s' '{"ok":true,"submitted":true}'`);
    },
    async query(identity) {
      const {guard}=checkedDirectory(identity);
      return request(guard + `if [ -f "$job/receipt.json" ]; then cat "$job/receipt.json"; else printf '%s' '{"ok":true,"settled":false}'; fi`);
    },
    async cancel(identity) {
      const {guard,fields}=checkedDirectory(identity);
      const cancelled=JSON.stringify({...fields,ok:false,error:'shell_action_cancelled',settled:true,dispatched:false,ambiguous:false,exitCode:null});
      return request(guard + `if mkdir "$job/admission" 2>/dev/null; then printf '%s' ${quote(cancelled)} >"$job/cancel.tmp" && mv "$job/cancel.tmp" "$job/receipt.json"; fi\n` +
        `if [ -f "$job/receipt.json" ]; then cat "$job/receipt.json"; else printf '%s' '{"ok":true,"settled":false}'; fi`,3000);
    },
    async output(identity) {
      const {guard}=checkedDirectory(identity);
      const result = await request(guard + `if [ ! -f "$job/receipt.json" ]; then printf '%s' '{"ok":false,"error":"shell_action_not_settled"}'; exit 0; fi\n` +
        `printf '{"ok":true,"stdout":"'; if [ -f "$job/stdout" ]; then base64 "$job/stdout" | tr -d '\\n'; fi\n` +
        `printf '","stderr":"'; if [ -f "$job/stderr" ]; then base64 "$job/stderr" | tr -d '\\n'; fi; printf '"}'`);
      if (!result.ok) throw new CommandError(result.error, 'The original shell command output is unavailable.', { dispatched:null, ambiguous:true });
      return { stdout:Buffer.from(result.stdout,'base64').toString('utf8'), stderr:Buffer.from(result.stderr,'base64').toString('utf8') };
    },
    async acknowledge(identity, receipt) {
      if (!terminalReceipt(receipt, identity)) throw new CommandError('invalid_shell_execution_receipt', 'Only the original terminal receipt may be acknowledged.');
      const { guard } = checkedDirectory(identity);
      const { executionReceipt, ...wireReceipt } = receipt;
      const expected = JSON.stringify(wireReceipt);
      return request(guard + `if [ "$(cat "$job/receipt.json")" != ${quote(expected)} ]; then printf '%s' '{"ok":false,"error":"shell_receipt_changed"}'; exit 0; fi\n` +
        `printf '%s' ${quote(digest(expected))} >"$job/acknowledged.tmp" && mv "$job/acknowledged.tmp" "$job/acknowledged" || exit 1\n` +
        `printf '%s' '{"ok":true,"acknowledged":true}'`, 1000);
    },
  };
}

function terminalReceipt(result, identity) {
  return result?.schemaVersion===schema && result.actionId===identity.actionId && result.jobId===identity.jobId
    && result.runtimeEpoch===identity.runtimeEpoch && result.commandSha256===identity.commandSha256
    && result.deadlineUptimeMs===identity.deadlineUptimeMs
    && result.settled===true && typeof result.dispatched==='boolean' && result.ambiguous===false
    && (result.dispatched ? result.ok===true && Number.isInteger(result.exitCode) && result.exitCode>=0 && result.exitCode<=255
      : result.ok===false && ['shell_action_cancelled','shell_action_timeout'].includes(result.error) && result.exitCode===null);
}
function settlementProof(result, identity) {
  if (!terminalReceipt(result, identity)) return null;
  const { executionReceipt, ...wireReceipt } = result;
  return { kind:'android-shell', actionId:identity.actionId, runtimeEpoch:identity.runtimeEpoch, jobId:identity.jobId,
    commandSha256:identity.commandSha256, deadlineUptimeMs:identity.deadlineUptimeMs, settled:true, dispatched:result.dispatched, ambiguous:false,
    exitCode:result.exitCode, error:result.error??null, responseSha256:digest(JSON.stringify(wireReceipt)) };
}

async function executeAndroidShell({ adb, serial, argv, actionId, timeoutMs=15000, port=createAndroidShellPort({adb,serial,timeoutMs}) }) {
  return runExecution({timeoutMs,mutation:true},()=>executeWithinScope({adb,serial,argv,actionId,port}));
}
async function executeWithinScope({adb,serial,argv,actionId,port}) {
  const prepared = await port.prepare(argv,actionId);
  const identity=prepared;
  let failure;
  const result = await runDeviceEffect({kind:'android-shell',...identity,target:{adb,serial}},async()=>{
    try {
      checkExecution(); markExecutionDispatched();
      const submitted=await port.start(prepared);
      if (!submitted.ok) throw new Error(submitted.error);
      while(true){
        checkExecution();const receipt=await port.query(identity);
        if(terminalReceipt(receipt,identity)) return { ...receipt,executionReceipt:settlementProof(receipt,identity) };
        if(receipt?.ok!==true||receipt.settled!==false) throw new Error(receipt?.error||'invalid_shell_execution_receipt');
        await executionSleep(60);
      }
    } catch(error){failure=error.code||'shell_action_response_lost';}
    let receipt;
    try{receipt=await withoutExecution(()=>port.cancel(identity));}catch(_){/* Missing cancellation remains unresolved. */}
    if(terminalReceipt(receipt,identity))return {...receipt,executionReceipt:settlementProof(receipt,identity)};
    return {ok:false,error:failure, ...identity,settled:false,dispatched:null,ambiguous:true,executionReceipt:null};
  },value=>settlementProof(value,identity));
  if(!result.executionReceipt)throw Object.assign(new CommandError(result.error,'The original Android shell command has not confirmed completion.',{dispatched:null,ambiguous:true}),{settled:false,executionReceipt:null});
  let output;
  try { output=await withoutExecution(()=>port.output(identity)); }
  catch (error) {
    throw new CommandError('shell_output_unavailable', 'The command completed, but its output could not be read.', {
      dispatched: result.dispatched, ambiguous: false, settled: true, executionReceipt: result.executionReceipt,
      exitCode: result.exitCode, details: { cause: error.code || 'shell_output_read_failed' },
    });
  }
  // Ownership has already fsynced this exact proof. A failed acknowledgement
  // retains the phone copy; it cannot undo the confirmed execution outcome.
  let cleanupError;
  if (isDeviceSettlementDurable(result.executionReceipt)) {
    try {
      const ack = await withoutExecution(() => port.acknowledge(identity, result));
      if (ack.ok !== true || ack.acknowledged !== true) cleanupError = ack.error || 'shell_receipt_acknowledgement_failed';
    } catch (error) { cleanupError = error.code || 'shell_receipt_acknowledgement_failed'; }
  }
  if (cleanupError) output.cleanupError = cleanupError;
  if(failure||result.exitCode!==0)throw Object.assign(new CommandError(failure||result.error||'adb_command_failed',output.stderr||'The Android shell command did not complete successfully.',{dispatched:result.dispatched,ambiguous:false}),
    {...output,settled:true,executionReceipt:result.executionReceipt,exitCode:result.exitCode});
  return {...output,settled:true,dispatched:result.dispatched,ambiguous:false,executionReceipt:result.executionReceipt};
}

module.exports={schema,createAndroidShellPort,executeAndroidShell,terminalReceipt,settlementProof};
