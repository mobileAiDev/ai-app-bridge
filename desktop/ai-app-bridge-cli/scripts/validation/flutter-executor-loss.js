'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

module.exports.main = async ctx => {
  const { outDir, runId, business } = ctx.inputs;
  const pkg = ctx.target.packageName, began = Date.now(), calls = [], cases = [];
  const save = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2));
  async function raw(command, args = {}) {
    const atMs = Date.now(), reply = await ctx.call(command, args);
    calls.push({ command, args, atMs, ms: Date.now() - atMs, reply });
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
  const wait = targetText => call('wait-text', { provider: 'flutter', targetText, timeoutMs: 15000, intervalMs: 50 });
  const hostBefore = await call('runtime', { operation: 'status' });
  const ownershipBefore = await call('device-ownership', { operation: 'status', serial: ctx.target.serial });
  assert.equal(ownershipBefore.active, 0);

  for (const point of ['before-effect', 'after-effect']) {
    const caseBegan = Date.now(), caseDir = path.join(outDir, point);
    fs.mkdirSync(caseDir);
    const name = `${runId}-${point}`, journal = `files/flutter-recovery-${name}.jsonl`;
    const remote = `/data/local/tmp/aab-flutter-loss-${name}`;
    const uri = `bridge-workflow-lab://recovery?run=${name}&point=${point}`;
    const launchArgs = { activity: '.MainActivity', action: 'android.intent.action.VIEW', data: uri };
    const readJournal = async () => (await adb(['shell', 'run-as', pkg, 'cat', journal], true)).trim().split('\n').map(JSON.parse);
    const keep = (file, value) => save(`${point}/${file}`, value);
    await call('launch-activity', launchArgs);
    await wait('Effect count: 0');
    const originalTree = await call('flutter-nodes');
    const descriptor = JSON.parse(await adb(['shell', 'run-as', pkg, 'cat', 'files/ai_app_bridge_endpoint.json'], true));
    const originalEpoch = originalTree.runtimeEpoch;
    assert.equal(descriptor.packageName, pkg);
    assert.equal(descriptor.ok, true);
    const transportEpoch = descriptor.runtimeEpoch;
    const initial = await readJournal();
    assert.deepEqual(initial.map(row => [row.phase, row.count, row.deliveries]), [['ready', 0, 0]]);
    const originalPid = initial[0].pid;
    const bootId = (await adb(['shell', 'cat', '/proc/sys/kernel/random/boot_id'], true)).trim();
    const stat = await adb(['shell', 'run-as', pkg, 'cat', `/proc/${originalPid}/stat`], true);
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    assert(/^\d+$/.test(startTicks));
    const cmdline = await adb(['shell', 'run-as', pkg, 'cat', `/proc/${originalPid}/cmdline`], true);
    assert.equal(cmdline.split('\0')[0], pkg);
    const cmdHash = createHash('sha256').update(cmdline).digest('hex');
    keep('identity-before.json', { originalPid, originalEpoch, transportEpoch, bootId, startTicks, cmdHash, descriptor });
    const marker = point === 'before-effect' ? 'entered' : 'applied';
    const watcher = `#!/system/bin/sh
pid=${originalPid}
read_start() { value=$(run-as ${quote(pkg)} cat /proc/$pid/stat) || return 1; value=\${value##*) }; set -- $value; shift 19; printf '%s' "$1"; }
for attempt in $(seq 1 600); do
  run-as ${quote(pkg)} cat ${quote(journal)} >${quote(remote + '/app-seen.jsonl')} 2>/dev/null || exit 20
  if grep -q ${quote('"phase":"' + marker + '"')} ${quote(remote + '/app-seen.jsonl')}; then
    grep -q '"phase":"returned"' ${quote(remote + '/app-seen.jsonl')} && exit 21
    [ "$(cat /proc/sys/kernel/random/boot_id)" = ${quote(bootId)} ] || exit 22
    run-as ${quote(pkg)} cat files/ai_app_bridge_endpoint.json | grep -q -F ${quote(transportEpoch)} || exit 23
    [ "$(read_start)" = ${quote(startTicks)} ] || exit 24
    actual=$(run-as ${quote(pkg)} sha256sum /proc/$pid/cmdline); actual=\${actual%% *}
    [ "$actual" = ${quote(cmdHash)} ] || exit 25
    read up ignored < /proc/uptime
    killed_ms=$(( \${up%.*} * 1000 + 10#\${up#*.} * 10 ))
    run-as ${quote(pkg)} kill -9 "$pid" || exit 26
    printf '{"pid":%s,"killedAtElapsedMs":%s,"signal":"SIGKILL","point":"${point}"}\n' "$pid" "$killed_ms" >${quote(remote + '/fault.json')}
    exit 0
  fi
  sleep 0.05
done
exit 27
`;
    fs.writeFileSync(path.join(caseDir, 'fault-worker.sh'), watcher);
    await adb(['shell', 'mkdir', '-p', remote]);
    await adb(['push', path.join(caseDir, 'fault-worker.sh'), remote + '/watch.sh']);
    await adb(['shell', `setsid nohup sh ${quote(remote + '/watch.sh')} </dev/null >${quote(remote + '/watch.log')} 2>&1 &`]);
    await ctx.checkpoint(`before-${point}`, { phase: 'query-original-effect', runId: name });
    const original = await raw('tap-flutter-text', { targetText: '执行原始动作' });
    keep('original-call.json', original);
    assert.equal(original.ok, false, 'The original callback returned before the process died');
    assert.equal(original.ambiguous, true, 'An exited process cannot supply its missing receipt');
    assert.equal(original.result.settled, false);
    assert.equal(original.result.runtimeEpoch, originalEpoch);
    assert.deepEqual(original.guidance, original.result.guidance);
    const hints = original.guidance.nextActions;
    assert.deepEqual(hints.map(hint => [hint.command, hint.arguments.operation]), [
      ['device-ownership', 'status'], ['device-ownership', 'archives'], ['flutter-nodes', undefined],
      ['launch-app', undefined], ['device-ownership', 'force-stop'],
    ]);
    assert.equal(hints[1].arguments.actionId, original.result.actionId);
    const fault = JSON.parse(await adb(['shell', 'cat', remote + '/fault.json'], true));
    assert.equal(fault.pid, originalPid);
    const ownership = await call(hints[0].command, hints[0].arguments);
    const pending = ownership.ownership.pending;
    assert.equal(pending.kind, 'flutter');
    assert.equal(pending.actionId, original.result.actionId);
    assert.equal(pending.runtimeEpoch, originalEpoch);
    const interrupted = await readJournal();
    const expectedCount = point === 'before-effect' ? 0 : 1;
    assert.equal(interrupted.at(-1).count, expectedCount);
    assert.equal(interrupted.at(-1).deliveries, 1);
    assert.equal(interrupted.filter(row => row.phase === 'returned').length, 0);
    keep('fault.json', fault); keep('pending-before-recovery.json', ownership); keep('journal-at-death.json', interrupted);

    const recoveryBegan = Date.now();
    const launch = await raw('launch-activity', launchArgs);
    assert(launch.ok && !launch.ambiguous);
    const recoveryWarning = launch.warnings?.find(item => item.code === 'previous_execution_unknown' && item.blocking === false);
    assert(recoveryWarning, 'A new action must explain the preserved unknown predecessor');
    const postFaultLaunchMs = Date.now() - recoveryBegan, readinessBegan = Date.now();
    // Preserve the original 15-second threshold while allowing a separate
    // bounded, read-only recovery check to finish functional fault coverage.
    await call('wait-text', { provider: 'flutter', targetText: `Effect count: ${expectedCount}`,
      timeoutMs: 60000, intervalMs: 100 });
    const postFaultReadinessMs = Date.now() - readinessBegan;
    const currentTree = await call(hints[2].command, hints[2].arguments);
    assert.notEqual(currentTree.runtimeEpoch, originalEpoch);
    const restarted = await readJournal();
    assert.equal(restarted.at(-1).phase, 'ready');
    assert.notEqual(restarted.at(-1).pid, originalPid);
    assert.equal(restarted.at(-1).count, expectedCount);
    assert.equal(restarted.at(-1).deliveries, 1);
    await call('screenshot', { outFile: path.join(caseDir, 'original-effect-after-restart.png') });
    const archives = await call(hints[1].command, hints[1].arguments);
    assert.equal(archives.items.length, 1);
    const archiveId = archives.items[0].archiveId;
    const archive = await call(archives.items[0].read.command, archives.items[0].read.arguments);
    assert.equal(archive.outcome, 'unknown');
    assert.deepEqual(archive.journal.pending, pending);
    keep('original-action-archive.json', archive);
    const query = await call('device-ownership', { operation: 'reconcile-archive', serial: ctx.target.serial,
      archiveId, entryId: pending.id, timeoutMs: 5000 });
    assert.equal(query.settled, false);
    assert.equal(query.actionId, pending.actionId);
    keep('original-completion-query.json', query);
    await ctx.checkpoint(`original-${point}-observed`, { phase: 'new-explicit-action', runId: name, expectedCount });
    await call('tap-flutter-text', { targetText: '执行新的明确动作' });
    await wait(`Effect count: ${expectedCount + 1}`);
    const after = await readJournal();
    assert.equal(after.filter(row => row.phase === 'entered').length, 1, 'The original callback was replayed');
    assert.equal(after.at(-1).action, 'new-explicit');
    assert.equal(after.at(-1).count, expectedCount + 1);
    assert.equal(after.at(-1).deliveries, 2);
    assert.equal(after.at(-1).pid, restarted.at(-1).pid);
    const kept = await call('device-ownership', { operation: 'archive', serial: ctx.target.serial, archiveId });
    assert.equal(kept.checksum, archive.checksum);
    assert.deepEqual(kept.journal.pending, pending);
    keep('journal-after-continuation.json', after);
    await call('screenshot', { outFile: path.join(caseDir, 'continued-effect.png') });
    cases.push({ point, ok: true, elapsedMs: Date.now() - caseBegan, recoveryMs: Date.now() - recoveryBegan,
      postFaultLaunchMs, postFaultReadinessMs, readinessThresholdMs: 15000, readinessRecoveryBudgetMs: 60000,
      exceeded15s: postFaultReadinessMs > 15000,
      originalPid, currentPid: after.at(-1).pid, originalEpoch, currentEpoch: currentTree.runtimeEpoch,
      originalActionId: pending.actionId, originalOutcome: 'unknown', originalActionReplayed: false,
      originalRecordPreserved: true, originalEffects: expectedCount, finalEffects: expectedCount + 1,
      originalGuidance: original.guidance || null, recoveryWarning });
    save('fixture-cases.json', cases);
  }
  let businessResult = null;
  if (business) {
    const businessDir = path.join(outDir, 'business'); fs.mkdirSync(businessDir);
    businessResult = await require('./city-flow').main({ ...ctx, inputs: {
      ...ctx.inputs, outDir: businessDir, runId: `${runId}-business`,
      helperPath: path.join(__dirname, 'lab-client.js'),
    } });
    assert.equal(businessResult.ok, true, JSON.stringify(businessResult));
  }
  const hostAfter = await call('runtime', { operation: 'status' });
  assert.equal(hostAfter.runtimeId, hostBefore.runtimeId);
  const finalOwnership = await call('device-ownership', { operation: 'status', serial: ctx.target.serial });
  assert.equal(finalOwnership.unresolved, false);
  const report = { ok: true, elapsedMs: Date.now() - began, commands: calls.length + (businessResult?.calls || 0),
    fixtureCases: cases, business: businessResult, hostUnchanged: true, hostRuntimeId: hostAfter.runtimeId,
    performanceBudgetMet: cases.every(item => !item.exceeded15s) };
  save('program-report.json', report);
  return report;
};
