'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const runtimeRoot = '/data/local/tmp/ai-app-bridge-uia/v1';
const mainClass = 'io.github.mobileaidev.aiappbridge.uia.UiaRuntime';

module.exports.main = async ctx => {
  const { outDir, runId, recoveryMode, business } = ctx.inputs;
  const pkg = ctx.target.packageName, began = Date.now(), calls = [];
  const journal = `files/uia-recovery-${runId}.jsonl`, remote = `/data/local/tmp/aab-uia-loss-${runId}`;
  const save = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2));
  async function raw(command, args = {}, redactDescriptor = false) {
    const atMs = Date.now(), reply = await ctx.call(command, args);
    let retained = reply;
    if (redactDescriptor && reply.result?.stdout) {
      const descriptor = JSON.parse(reply.result.stdout);
      const publicFields = Object.fromEntries(['pid', 'runtimeEpoch', 'bootId', 'running', 'dexSha256', 'sessionPath']
        .map(key => [key, descriptor[key]]));
      retained = { ...reply, result: { ...reply.result, stdout: JSON.stringify(publicFields) } };
    }
    calls.push({ command, args, atMs, ms: Date.now() - atMs, reply: retained });
    fs.appendFileSync(path.join(outDir, 'calls.jsonl'), JSON.stringify(calls.at(-1)) + '\n');
    return reply;
  }
  async function call(command, args) {
    const reply = await raw(command, args);
    assert(reply.ok && !reply.ambiguous, `${command}: ${reply.error}: ${reply.message || ''}`);
    return reply.result;
  }
  async function adb(argv, readOnly = false) {
    const result = await call('adb-exec', { argv, readOnly });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  }
  const readJournal = async () => (await adb(['shell', 'run-as', pkg, 'cat', journal], true)).trim().split('\n').map(JSON.parse);
  const wait = targetText => call('wait-text', { provider: 'uia', targetText, timeoutMs: 15000, intervalMs: 100 });
  const hostBefore = await call('runtime', { operation: 'status' });
  const ownerBefore = await call('device-ownership', { operation: 'status', serial: ctx.target.serial });
  assert.equal(ownerBefore.active, 0);
  await call('launch-activity', { activity: 'com.philkes.notallyx.fixture.UiaRecoveryFixtureActivity', clearTask: true,
    extra: [`runId=${runId}`] });
  await wait('Effect count: 0');
  const original = await call('uia-runtime', { operation: 'status' });
  const descriptorReply = await raw('adb-exec', { argv: ['shell', 'cat', runtimeRoot + '/runtime.json'], readOnly: true }, true);
  assert(descriptorReply.ok && descriptorReply.result.exitCode === 0);
  const descriptor = JSON.parse(descriptorReply.result.stdout);
  assert.equal(descriptor.runtimeEpoch, original.runtimeEpoch);
  assert.equal(descriptor.bootId, original.bootId);
  assert(Number.isSafeInteger(descriptor.pid) && descriptor.pid > 1);
  const stat = await adb(['shell', 'cat', `/proc/${descriptor.pid}/stat`], true);
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  assert(/^\d+$/.test(startTicks));
  const cmdline = await adb(['shell', 'cat', `/proc/${descriptor.pid}/cmdline`], true);
  assert(cmdline.split('\0').includes(mainClass), 'The selected PID is not the UIA runtime');
  const cmdHash = createHash('sha256').update(cmdline).digest('hex');
  const before = await readJournal(); assert.equal(before.length, 1); assert.equal(before[0].phase, 'ready');
  save('identity-before.json', { hostBefore, original, pid: descriptor.pid, startTicks, cmdHash, appPid: before[0].pid });

  // This test-only device worker is armed through public wrapped ADB before the
  // UI action. It kills only the exact verified UIA process after the App durably
  // reports entering its callback, and expires without touching anything else.
  const watcher = `#!/system/bin/sh
pid=${descriptor.pid}
read_start() { value=$(cat /proc/$pid/stat) || return 1; value=\${value##*) }; set -- $value; shift 19; printf '%s' "$1"; }
for attempt in $(seq 1 600); do
  run-as ${quote(pkg)} cat ${quote(journal)} >${quote(remote + '/app-seen.jsonl')} 2>/dev/null || exit 20
  if grep -q '"phase":"entered"' ${quote(remote + '/app-seen.jsonl')}; then
    grep -q '"phase":"applied"' ${quote(remote + '/app-seen.jsonl')} && exit 21
    [ "$(cat /proc/sys/kernel/random/boot_id)" = ${quote(original.bootId)} ] || exit 22
    grep -q -F ${quote(original.runtimeEpoch)} ${quote(runtimeRoot + '/runtime.json')} || exit 23
    [ "$(read_start)" = ${quote(startTicks)} ] || exit 24
    actual=$(sha256sum /proc/$pid/cmdline); actual=\${actual%% *}
    [ "$actual" = ${quote(cmdHash)} ] || exit 25
    read up ignored < /proc/uptime
    killed_ms=$(( \${up%.*} * 1000 + 10#\${up#*.} * 10 ))
    kill -9 "$pid" || exit 26
    printf '{"pid":%s,"killedAtElapsedMs":%s,"signal":"SIGKILL"}\n' "$pid" "$killed_ms" >${quote(remote + '/fault.json')}
    exit 0
  fi
  sleep 0.05
done
exit 27
`;
  fs.writeFileSync(path.join(outDir, 'fault-worker.sh'), watcher);
  await adb(['shell', 'mkdir', '-p', remote]);
  await adb(['push', path.join(outDir, 'fault-worker.sh'), remote + '/watch.sh']);
  await adb(['shell', `setsid nohup sh ${quote(remote + '/watch.sh')} </dev/null >${quote(remote + '/watch.log')} 2>&1 &`]);
  await ctx.checkpoint('before-original-click', { phase: 'query-original-effect', runId });
  const originalCall = await raw('tap-uia', { selector: { contentDescription: 'uia_recovery_delayed_action' } });
  save('original-call.json', originalCall);
  assert.equal(originalCall.ok, false, 'Fault was not injected during the original call');
  assert.equal(originalCall.ambiguous, true, 'Executor death must not invent the missing completion');
  assert.deepEqual(originalCall.guidance, originalCall.result.guidance);
  const hints = originalCall.guidance.nextActions;
  assert.deepEqual(hints.map(hint => [hint.command, hint.arguments.operation]), [
    ['device-ownership', 'receipt'], ['uia-runtime', 'start'], ['uia-tree', undefined], ['uia-runtime', 'force-reset'],
  ]);
  assert.equal(hints[0].arguments.actionId, originalCall.result.actionId);
  assert.equal(hints[0].arguments.runtimeEpoch, original.runtimeEpoch);
  const completion = await raw(hints[0].command, hints[0].arguments);
  assert.equal(completion.ok, false);
  assert.equal(completion.error, 'device_completion_not_retained');
  const fault = JSON.parse(await adb(['shell', 'cat', remote + '/fault.json'], true));
  assert.equal(fault.pid, descriptor.pid);
  const pending = await call('device-ownership', { operation: 'status', serial: ctx.target.serial });
  assert.equal(pending.ownership.pending.kind, 'uia-node');
  assert.equal(pending.ownership.pending.runtimeEpoch, original.runtimeEpoch);
  const action = pending.ownership.pending;
  const recordPath = action.target.sessionPath + '/actions/' + createHash('sha256').update(action.actionId).digest('hex') + '.json';
  const oldRecord = JSON.parse(await adb(['shell', 'cat', recordPath], true));
  assert.equal(oldRecord.phase, 'admitted'); assert.equal(oldRecord.receiptJson, null);
  save('original-unsettled-record.json', oldRecord); save('pending-before-recovery.json', pending); save('fault.json', fault);

  const recoveryBegan = Date.now();
  let reset;
  if (recoveryMode === 'force-reset') {
    reset = await call(hints[3].command, hints[3].arguments);
    assert.equal(reset.outcome, 'unknown'); save('forced-reset.json', reset);
  }
  const restarted = await call(hints[1].command, hints[1].arguments);
  assert.notEqual(restarted.runtimeEpoch, original.runtimeEpoch);
  assert.equal(restarted.bootId, original.bootId);
  await wait('Effect count: 1');
  const intermediate = await readJournal();
  assert.deepEqual(intermediate.map(row => [row.phase, row.count]), [['ready', 0], ['entered', 0], ['applied', 1]]);
  assert(intermediate[2].elapsedMs > fault.killedAtElapsedMs, 'The App effect finished before the executor died');
  assert.equal(intermediate[2].pid, before[0].pid, 'The App process must survive executor recovery');
  await call('screenshot', { outFile: path.join(outDir, 'original-effect.png') });
  await ctx.checkpoint('original-effect-observed', { phase: 'new-explicit-action', runId });
  const next = await call('tap-uia', { selector: { contentDescription: 'uia_recovery_continue_action' } });
  await wait('Effect count: 2');
  const after = await readJournal(); save('app-journal.json', after);
  assert.deepEqual(after.map(row => row.count), [0, 0, 1, 2]);
  assert.deepEqual(after.filter(row => row.phase === 'applied').map(row => row.deliveries), [1, 2]);
  assert.equal(after.at(-1).pid, before[0].pid);
  await call('screenshot', { outFile: path.join(outDir, 'continued-effect.png') });
  const ownership = await call('device-ownership', { operation: 'status', serial: ctx.target.serial });
  assert.equal(ownership.unresolved, false);
  const archive = await call('device-ownership', { operation: 'archive', serial: ctx.target.serial,
    archiveId: ownership.ownership.lastUnknown.archiveId });
  assert.equal(archive.outcome, 'unknown');
  assert.equal(archive.journal.pending.actionId, action.actionId);
  assert.equal(archive.journal.pending.runtimeEpoch, original.runtimeEpoch);
  save('ownership-archive.json', archive);
  const keptPath = reset ? recordPath.replace(runtimeRoot + '/sessions/', reset.archivePath + '/sessions/') : recordPath;
  const kept = JSON.parse(await adb(['shell', 'cat', keptPath], true));
  assert.deepEqual(kept, oldRecord, 'The original unknown record must remain unchanged');
  const hostAfter = await call('runtime', { operation: 'status' });
  assert.equal(hostAfter.runtimeId, hostBefore.runtimeId);
  const recoveryMs = Date.now() - recoveryBegan;
  let businessResult;
  if (business) {
    const businessDir = path.join(outDir, 'business'); fs.mkdirSync(businessDir);
    businessResult = await require('./uia-regression').main({ ...ctx,
      inputs: { outDir: businessDir, runId: `${runId}-after-recovery` } });
    assert.equal(businessResult.ok, true, JSON.stringify(businessResult));
  }
  const report = { ok: true, recoveryMode, elapsedMs: Date.now() - began, recoveryMs, fault,
    injectedCallbackMs: 8000, hostUnchanged: true, appPid: before[0].pid,
    previousEpoch: original.runtimeEpoch, currentEpoch: restarted.runtimeEpoch,
    originalActionId: action.actionId, originalReceiptRecovered: false, originalRecordPreserved: true,
    originalCounter: 1, finalCounter: 2, commands: calls.length + (businessResult?.commands || 0),
    recoveryGuidanceVerified: true,
    recoveryWarnings: [...(reset?.warnings || []), ...(restarted.warnings || [])].map(w => ({ code: w.code, blocking: w.blocking })),
    newActionWarnings: next.warnings || [], business: businessResult || null };
  save('program-report.json', report); return report;
};
