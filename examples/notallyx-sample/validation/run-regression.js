#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'desktop/ai-app-bridge-cli');
const { createMcpClient, payloadOf } = require(path.join(CLI, 'scripts/validation/mcp-jsonrpc-client'));
const PACKAGE = 'io.github.mobileaidev.notallyx.sample';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = (file) => sha(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--install') options.install = true;
    else if (['--serial', '--out', '--apk', '--run-id', '--adb', '--aapt2', '--assignment-label'].includes(key)) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`value_required:${key}`);
      options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index];
    } else throw new Error(`unknown_argument:${key}`);
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(options.serial || '') || !options.out || !options.apk) throw new Error('--serial --out --apk are required');
  options.out = path.resolve(options.out); options.apk = path.resolve(options.apk);
  options.runId ||= `script-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(options.runId)) throw new Error('safe_run_id_required');
  return options;
}

function apkPackage(apk, explicitTool) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk');
  const tools = path.join(sdk, 'build-tools');
  const candidates = explicitTool ? [explicitTool] : fs.existsSync(tools) ? fs.readdirSync(tools).sort().reverse().map((version) => path.join(tools, version, 'aapt2')).filter((file) => fs.existsSync(file)) : [];
  if (!candidates.length) throw new Error('aapt2_required_for_isolated_apk_identity');
  const result = spawnSync(candidates[0], ['dump', 'badging', apk], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`apk_metadata_failed:${result.error?.message || result.stderr}`);
  const match = /^package: name='([^']+)'/m.exec(result.stdout);
  if (match?.[1] !== PACKAGE) throw new Error('isolated_sample_apk_required');
  return { tool: candidates[0], packageName: match[1], raw: result.stdout };
}

function hostCodeManifest() {
  const files = [path.join(CLI, 'package.json'), path.join(CLI, 'package-lock.json'), path.join(CLI, 'scripts/validation/mcp-jsonrpc-client.js')];
  const collect = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file); else if (entry.isFile()) files.push(file);
  } };
  collect(path.join(CLI, 'bin'));
  const nativeEntry = require.resolve('@mobileaidev/segmented-fact-store-native', { paths: [CLI] });
  files.push(nativeEntry, path.join(path.dirname(nativeEntry), 'package.json'), path.join(path.dirname(nativeEntry), 'build/Release/segmented_fact_store.node'));
  return { schemaVersion: 'aab.notallyx.host-code-manifest/v1', node: { version: process.version, platform: process.platform, arch: process.arch, executable: process.execPath },
    scope: 'All local CLI bin files, package/lock, MCP client and loaded native FactStore entry/binary; not an attestation of the complete machine.',
    artifacts: files.sort().map((file) => ({ role: 'host-execution-code', path: file, sha256: hash(file), bytes: fs.statSync(file).size })) };
}

async function main(options) {
  // main is exported for explicit execution; importing this file never touches adb.
  if (!/^[A-Za-z0-9_.:-]+$/.test(options.serial || '')) throw new Error('explicit_serial_required');
  if (fs.existsSync(options.out) && fs.readdirSync(options.out).length) throw new Error('output_directory_not_empty');
  fs.mkdirSync(options.out, { recursive: true });
  const out = path.resolve(options.out); const frozen = path.join(out, 'frozen');
  fs.mkdirSync(frozen);
  const freezeStarted = Date.now();
  const freezeFiles = ['regression-script.js', 'ui-oracles.js', 'oracles.js', 'label-oracles.js', 'assignment-oracles.js', 'collector.js', 'read_snapshot.py', 'report.js', 'source-provenance.js', 'feature-inventory.json', 'scenarios.json', 'evidence-source-index.json', 'labels-evidence-source-index-v2.json', 'assignment-evidence-source-index-v1.json'];
  for (const name of freezeFiles) fs.copyFileSync(path.join(__dirname, name), path.join(frozen, name));
  fs.copyFileSync(__filename, path.join(frozen, 'run-regression.js'));
  const sourceIndex = JSON.parse(fs.readFileSync(path.join(frozen, 'evidence-source-index.json'), 'utf8'));
  const labelsSourceIndex = JSON.parse(fs.readFileSync(path.join(frozen, 'labels-evidence-source-index-v2.json'), 'utf8'));
  if (labelsSourceIndex.bundleState !== 'frozen') throw new Error('labels_source_bundle_not_frozen');
  const { verifySourceProvenance } = require(path.join(frozen, 'source-provenance'));
  const sourceProvenance = verifySourceProvenance({ repositoryRoot: ROOT, indexPath: path.join(frozen, 'evidence-source-index.json'),
    bundleManifestPath: path.join(__dirname, 'source-evidence/bundle-manifest.json') });
  fs.copyFileSync(path.join(__dirname, 'source-evidence/bundle-manifest.json'), path.join(frozen, 'source-bundle-manifest.json'));
  write(path.join(out, 'source-provenance.json'), sourceProvenance);
  const labelsSourceProvenance = verifySourceProvenance({ repositoryRoot: ROOT, indexPath: path.join(frozen, 'labels-evidence-source-index-v2.json'),
    bundleManifestPath: path.join(__dirname, 'source-evidence-labels-v2/bundle-manifest.json') });
  fs.copyFileSync(path.join(__dirname, 'source-evidence-labels-v2/bundle-manifest.json'), path.join(frozen, 'labels-source-bundle-manifest.json'));
  write(path.join(out, 'labels-source-provenance.json'), labelsSourceProvenance);
  const assignmentSourceProvenance = options.assignmentLabel ? verifySourceProvenance({ repositoryRoot: ROOT,
    indexPath: path.join(frozen, 'assignment-evidence-source-index-v1.json'),
    bundleManifestPath: path.join(__dirname, 'source-evidence-assignment-v1/bundle-manifest.json') }) : null;
  if (assignmentSourceProvenance) {
    fs.copyFileSync(path.join(__dirname, 'source-evidence-assignment-v1/bundle-manifest.json'), path.join(frozen, 'assignment-source-bundle-manifest.json'));
    write(path.join(out, 'assignment-source-provenance.json'), assignmentSourceProvenance);
  }
  const hostCode = hostCodeManifest();
  write(path.join(frozen, 'host-code-manifest.json'), hostCode);
  const apkMetadata = apkPackage(options.apk, options.aapt2);
  write(path.join(out, 'apk-metadata.json'), apkMetadata);
  const freezeFinished = Date.now();
  const { collectSnapshot } = require(path.join(frozen, 'collector'));
  const { readSnapshot, checkSnapshot, compareCanonical } = require(path.join(frozen, 'oracles'));
  const { checkLabelTransition } = require(path.join(frozen, 'label-oracles'));
  const { checkLabelAssignment } = require(path.join(frozen, 'assignment-oracles'));
  const { checkTextUi } = require(path.join(frozen, 'ui-oracles'));
  const { buildReport, writeReport } = require(path.join(frozen, 'report'));
  const inventory = require(path.join(frozen, 'feature-inventory.json'));
  const scenarios = require(path.join(frozen, 'scenarios.json'));
  const target = { serial: options.serial, packageName: PACKAGE };
  const scriptTarget = { platform: 'android', ...target };
  const sourcePath = path.join(frozen, 'regression-script.js');
  const identity = { apkSha256: hash(options.apk), scriptSha256: hash(sourcePath), inventorySha256: hash(path.join(frozen, 'feature-inventory.json')),
    scenariosSha256: hash(path.join(frozen, 'scenarios.json')), hostCodeManifestSha256: hash(path.join(frozen, 'host-code-manifest.json')), runId: options.runId, target, assignmentCommon: options.assignmentLabel || null };
  const timing = { construction: [{ kind: 'freeze-run-inputs-only', startedAtMs: freezeStarted, finishedAtMs: freezeFinished }], installation: [] };
  const executions = [], oracleResults = [], phases = [], snapshots = [], observedFlows = [], labelAssessments = [], assignmentAssessments = [], hostPhases = {};
  let sequence = 0, client, operationId, failure, assignmentMembers;
  const assignmentCommon = options.assignmentLabel;
  const title = `AAB-TEXT-${options.runId}`;
  const listTitle = `AAB-LIST-${options.runId}`;
  const label = `AAB项目-${options.runId}`;
  const labelA = `AAB-label-${options.runId}-a`, labelAb = `AAB-label-${options.runId}-ab`, labelRenamed = `AAB-label-${options.runId}-renamed`;
  const originalBody = '第一行中文\nsecond line & <tag>';
  const editedBody = `${originalBody}-edited`;
  const adbLog = path.join(out, 'adb.jsonl');
  const adb = (args, binary = false) => {
    const startedAtMs = Date.now();
    const result = spawnSync(options.adb || 'adb', ['-s', options.serial, ...args], { encoding: binary ? null : 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
    const bytes = Buffer.from(result.stdout || '');
    fs.appendFileSync(adbLog, `${JSON.stringify({ argv: [options.adb || 'adb', '-s', options.serial, ...args], startedAtMs, finishedAtMs: Date.now(), exitCode: result.status,
      stderr: String(result.stderr || ''), ...(binary ? { stdoutSha256: sha(bytes), stdoutBytes: bytes.length } : { stdout: bytes.toString() }) })}\n`);
    if (result.error || result.status !== 0) throw new Error(`adb_failed:${args[0]}:${result.error?.message || result.stderr || result.status}`);
    return binary ? bytes : bytes.toString();
  };
  const run = async (command, args = {}) => {
    const arguments_ = command === 'script' ? args : { ...target, ...args };
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: arguments_ } }));
    if (result.ok === false || result.error) throw new Error(`${command}:${result.error || 'not_ok'}`);
    return result;
  };
  async function launch(name) {
    write(path.join(out, `${name}-launch.json`), await run('launch-app', { clearTask: true }));
    const deadline = Date.now() + 20000;
    let last;
    do {
      try { last = await run('status'); if (last.app?.packageName === PACKAGE && last.debugBridge?.version === require(path.join(CLI, 'package.json')).version) { write(path.join(out, `${name}-status.json`), last); return; } }
      catch (error) { last = { error: error.message }; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    write(path.join(out, `${name}-status.json`), last); throw new Error('current_sample_bridge_unavailable');
  }
  function snapshot(name) {
    const directory = path.join(out, name);
    const minCapturedAtMs = Date.now();
    const manifest = collectSnapshot({ ...target, out: directory, runId: options.runId, sequence, apkSha256: identity.apkSha256, adb: options.adb || 'adb' });
    const observed = readSnapshot(manifest, { expectedTarget: target, runId: options.runId, afterSequence: sequence, minCapturedAtMs, expectedApkSha256: identity.apkSha256 });
    write(path.join(directory, 'observed.json'), observed);
    if (!observed.ok) throw new Error(`snapshot:${observed.reason}`);
    snapshots.push({ name, snapshotId: observed.snapshotId, manifestPath: path.join(directory, 'snapshot.json') });
    return observed;
  }
  async function scriptPhase(phase) {
    const directory = path.join(out, phase); fs.mkdirSync(directory);
    const startedAtMs = Date.now();
    const start = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', name: `notallyx-text-${phase}`, language: 'javascript', sourcePath,
      target: scriptTarget, inputs: { out: directory, runId: options.runId, phase, title, originalBody, editedBody, label, listTitle, labelA, labelAb, labelRenamed, assignmentCommon, assignmentMembers }, policy: { timeoutMs: 120000, restartPolicy: 'none' } } });
    write(path.join(directory, 'start.json'), start); operationId = start.operationId;
    if (!operationId) throw new Error('script_operation_missing');
    let current = start;
    const deadline = Date.now() + 130000;
    while (!['completed', 'failed', 'cancelled'].includes(current.status)) {
      if (Date.now() > deadline) throw new Error('script_wait_deadline');
      current = await run('script', { operation: 'wait', operationId, waitMs: 1000, afterSequence: current.eventSequence || 0 });
      if (['paused', 'intervention_required'].includes(current.status)) throw new Error(`script_attention:${current.status}`);
    }
    const final = await run('script', { operation: 'status', operationId, afterSequence: 0, limit: 1000 });
    hostPhases[operationId] = final;
    write(path.join(directory, 'final.json'), final);
    const phaseRecord = { phase, operationId, executionStatus: current.status, startedAtMs, finishedAtMs: Date.now() }; phases.push(phaseRecord); operationId = null;
    if (current.status !== 'completed') throw new Error(`script_phase_failed:${phase}:${current.error || current.status}`);
    const persisted = await run('script', { operation: 'result', operationId: phaseRecord.operationId });
    write(path.join(directory, 'persisted-result.json'), persisted);
    const result = persisted.result;
    if (persisted.persisted !== true || !isDeepStrictEqual(result, JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8')))) throw new Error('persisted_script_result_mismatch');
    if (result.runId !== options.runId || result.phase !== phase) throw new Error('script_result_identity_mismatch');
    if (final.history?.hasMore !== false || final.history?.gap) throw new Error('complete_host_phase_history_required');
    const actions = final.history.items.filter((item) => item.kind === 'call_completed' && item.actionId);
    if (actions.some((item) => item.executionId !== phaseRecord.operationId || item.payloadSummary?.error || !isDeepStrictEqual(item.target, scriptTarget))
      || new Set(actions.map((item) => item.actionId)).size !== actions.length || result.mutations !== actions.length) throw new Error('host_mutation_history_mismatch');
    sequence += actions.length;
    phaseRecord.hostMutationCount = actions.length;
    phaseRecord.checkpoints = result.checkpoints.map((checkpoint) => ({ ...checkpoint, runId: options.runId, operationId: phaseRecord.operationId,
      phaseStartedAtMs: startedAtMs, phaseFinishedAtMs: phaseRecord.finishedAtMs,
      tree: { path: checkpoint.treePath, sha256: hash(checkpoint.treePath) }, screenshot: { path: checkpoint.screenshotPath, sha256: hash(checkpoint.screenshotPath) },
      afterTree: { path: checkpoint.afterTreePath, sha256: hash(checkpoint.afterTreePath) },
      screenshotResponse: { path: checkpoint.screenshotResponsePath, sha256: hash(checkpoint.screenshotResponsePath) } }));
    return phaseRecord;
  }
  const record = (scenarioId, result, attempt = 1) => oracleResults.push({ ...result, scenarioId, attempt });
  const combine = (id, results) => {
    const verdict = results.some((result) => result.verdict === 'failed') ? 'failed'
      : results.length && results.every((result) => result.verdict === 'passed' && result.source === 'independent-host-business-oracle') ? 'passed' : 'inconclusive';
    return { id, source: 'independent-host-business-oracle', verdict, ok: verdict === 'passed', results };
  };
  const acceptLabelStep = (name, results) => {
    const assessment = combine(name, results); labelAssessments.push(assessment);
    write(path.join(out, `${name}-oracles.json`), assessment);
    if (!assessment.ok) throw new Error(`label_oracle:${name}:${assessment.verdict}`);
    return assessment;
  };
  try {
    if (options.install) {
      const startedAtMs = Date.now(); adb(['install', '-r', options.apk]);
      timing.installation.push({ kind: 'adb-install-r-isolated-apk', startedAtMs, finishedAtMs: Date.now() });
    }
    timing.regression = { startedAtMs: Date.now() };
    const installed = adb(['shell', 'pm', 'path', PACKAGE]).trim().split(/\r?\n/);
    if (installed.length !== 1 || !/^package:\/data\/app\/[^\r\n]+\/base\.apk$/.test(installed[0])) throw new Error('single_installed_base_apk_required');
    if (sha(adb(['exec-out', 'cat', installed[0].slice(8)], true)) !== identity.apkSha256) throw new Error('installed_apk_hash_mismatch');
    client = createMcpClient({ serverPath: path.join(CLI, 'bin/mcp-server.js'), transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.stderr.log'),
      env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'host-facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
    await client.initialize();
    await launch('initial'); const baseline = snapshot('before');
    if (baseline.data.notes.some((note) => [title, listTitle].includes(note.title)) || baseline.data.labels.some((row) => [label, labelA, labelAb, labelRenamed].includes(row.value))) throw new Error('run_markers_already_exist_choose_new_run_id');
    if (assignmentCommon && baseline.data.labels.filter(row => row.value === assignmentCommon).length !== 1) throw new Error('existing_assignment_label_required');
    await launch('before');
    const normalStarted = Date.now();
    executions.push({ scenarioId: 'note.text_crud.normal', attempt: 1, executionStatus: 'running', startedAtMs: normalStarted });
    const createdUi = await scriptPhase('create'); const created = snapshot('created-db'); await launch('created');
    const createdNotes = created.data.notes.filter((note) => note.title === title);
    if (createdNotes.length !== 1) throw new Error('created_unique_note_missing');
    const noteId = createdNotes[0].id;
    const editedUi = await scriptPhase('edit'); const edited = snapshot('edited-db');
    const normal = checkSnapshot(edited, { id: 'note.text_crud.normal:oracle:1', notes: [{ where: { title }, fields: { id: noteId, type: 'NOTE', folder: 'NOTES', body: editedBody } }] });
    const initial = checkSnapshot(created, { id: 'created-exact-body', notes: [{ where: { title }, fields: { id: noteId, type: 'NOTE', folder: 'NOTES', body: originalBody } }] });
    const preserved = isDeepStrictEqual(baseline.data.notes, created.data.notes.filter((note) => note.id !== noteId))
      && isDeepStrictEqual(baseline.data.notes, edited.data.notes.filter((note) => note.id !== noteId));
    const editedNote = edited.data.notes.find((note) => note.id === noteId);
    const timestampValid = editedNote && editedNote.modifiedTimestamp >= createdNotes[0].modifiedTimestamp && editedNote.timestamp === createdNotes[0].timestamp;
    normal.checks.push({ field: 'created_body_then_same_id_edit', verdict: initial.verdict }, { field: 'prior_notes_preserved', verdict: preserved ? 'passed' : 'failed' }, { field: 'timestamps_preserved_and_monotonic', verdict: timestampValid ? 'passed' : 'failed' });
    normal.verdict = normal.checks.every((check) => check.verdict === 'passed') ? 'passed' : 'failed'; normal.ok = normal.verdict === 'passed'; record('note.text_crud.normal', normal);
    record('note.text_crud.normal', checkTextUi({ id: 'note.text_crud.normal:oracle:2', runId: options.runId, title, hostPhases, target: scriptTarget,
      checkpoints: [...createdUi.checkpoints, ...editedUi.checkpoints], expectedCheckpoints: [
        { name: 'created-editor', screen: 'editor', body: originalBody }, { name: 'created-overview', screen: 'overview', body: originalBody },
        { name: 'reopened-editor', screen: 'editor', body: originalBody }, { name: 'edited-editor', screen: 'editor', body: editedBody }, { name: 'edited-overview', screen: 'overview', body: editedBody },
      ] }));
    Object.assign(executions.at(-1), { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [createdUi.operationId, editedUi.operationId] });
    write(path.join(out, 'normal-oracles.json'), oracleResults);
    executions.push({ scenarioId: 'note.text_crud.restart', attempt: 1, executionStatus: 'running', startedAtMs: normalStarted, sharedPrefixScenarioId: 'note.text_crud.normal' });
    await launch('edited'); const restartUi = await scriptPhase('restart'); const restarted = snapshot('restarted-db');
    const restart = checkSnapshot(restarted, { id: 'note.text_crud.restart:oracle:1', notes: [{ where: { title }, fields: { id: noteId, type: 'NOTE', folder: 'NOTES', body: editedBody } }] });
    restart.checks.push({ field: 'whole_note_rows_survive_restart', verdict: isDeepStrictEqual(edited.data.notes, restarted.data.notes) ? 'passed' : 'failed' });
    restart.verdict = restart.checks.every((check) => check.verdict === 'passed') ? 'passed' : 'failed'; restart.ok = restart.verdict === 'passed'; record('note.text_crud.restart', restart);
    record('note.text_crud.restart', checkTextUi({ id: 'note.text_crud.restart:oracle:2', runId: options.runId, title, hostPhases, target: scriptTarget,
      checkpoints: restartUi.checkpoints, expectedCheckpoints: [
        { name: 'restart-overview', screen: 'overview', body: editedBody }, { name: 'restart-editor', screen: 'editor', body: editedBody }, { name: 'restart-returned', screen: 'overview', body: editedBody },
      ] }));
    Object.assign(executions.at(-1), { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [createdUi.operationId, editedUi.operationId, restartUi.operationId] });
    await launch('restarted');
    const organizeStarted = Date.now();
    const related = ['labels.manage.normal', 'labels.assignment.normal', 'note.pin_color.normal'];
    for (const scenarioId of related) executions.push({ scenarioId, attempt: 1, executionStatus: 'running', startedAtMs: organizeStarted, partialFlow: 'single-note-label-pin-color' });
    const organizeUi = await scriptPhase('organize'); const organized = snapshot('organized-db');
    const expectedLabels = [...restarted.data.labels, { value: label, order: restarted.data.labels.length ? Math.max(...restarted.data.labels.map((row) => row.order)) + 1 : 0 }];
    const organizeDb = checkSnapshot(organized, { id: 'observed.label-pin-color:database', labels: expectedLabels,
      notes: [{ where: { title }, fields: { id: noteId, type: 'NOTE', folder: 'NOTES', body: editedBody, labels: [label], pinned: true, color: '#AFCCDC' } }] });
    const unaffected = isDeepStrictEqual(restarted.data.notes.filter((note) => note.id !== noteId), organized.data.notes.filter((note) => note.id !== noteId));
    organizeDb.checks.push({ field: 'other_note_rows_unchanged', verdict: unaffected ? 'passed' : 'failed' });
    organizeDb.verdict = organizeDb.checks.every((check) => check.verdict === 'passed') ? 'passed' : 'failed'; organizeDb.ok = organizeDb.verdict === 'passed';
    const organizeOracle = checkTextUi({ id: 'observed.label-pin-color:ui', runId: options.runId, title, hostPhases, target: scriptTarget, checkpoints: organizeUi.checkpoints,
      expectedCheckpoints: ['label-pinned-editor', 'organized-editor'].map((name) => ({ name, screen: 'editor', body: editedBody, requiredSelectors: [{ text: label }, { contentDescription: '取消固定' }] }))
        .concat([{ name: 'organized-overview', screen: 'overview', body: editedBody, requiredSelectors: [{ text: label }] }]) });
    observedFlows.push({ id: 'single-note-label-pin-color', scenarioIds: related, oracleResults: [organizeDb, organizeOracle],
      verdict: [organizeDb, organizeOracle].every((result) => result.verdict === 'passed') ? 'passed' : [organizeDb, organizeOracle].some((result) => result.verdict === 'failed') ? 'failed' : 'inconclusive',
      remainingFrozenScope: 'This organization fragment alone excludes label rename/delete, which later label phases assess separately. The later optional assignment extension assesses batch save/cancel/removal separately. Unpin/re-pin and custom color replacement remain unexecuted.' });
    for (const row of executions.filter((row) => related.includes(row.scenarioId))) {
      Object.assign(row, { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [organizeUi.operationId] });
      for (const oracle of scenarios.scenarios.find((scenario) => scenario.id === row.scenarioId).oracles) record(row.scenarioId,
        { id: oracle.id, source: 'independent-host-business-oracle', verdict: observedFlows.at(-1).verdict === 'failed' ? 'failed' : 'inconclusive', reason: 'partial_flow_does_not_cover_all_frozen_acceptance_points', observedFlowId: 'single-note-label-pin-color' });
    }
    await launch('organized');
    const listStarted = Date.now();
    executions.push({ scenarioId: 'list.hierarchy.normal', attempt: 1, executionStatus: 'running', startedAtMs: listStarted });
    const listCreatedUi = await scriptPhase('list-create'); const listCreated = snapshot('list-created-db');
    const matchingLists = listCreated.data.notes.filter((note) => note.title === listTitle);
    if (matchingLists.length !== 1) throw new Error('created_unique_list_missing');
    const listId = matchingLists[0].id;
    const checkedTimestamp = matchingLists[0].items[3]?.checkedTimestamp;
    const validCheckedTime = Number.isSafeInteger(checkedTimestamp) && checkedTimestamp >= matchingLists[0].timestamp && checkedTimestamp <= matchingLists[0].modifiedTimestamp;
    const persistedItems = (hierarchy) => [
      { body: 'Parent-A', checked: false, isChild: false, order: 0 },
      { body: 'Child-A1', checked: false, isChild: hierarchy, order: 1 },
      { body: hierarchy ? 'Child-A2-edited' : 'Child-A2', checked: false, isChild: hierarchy, order: 2 },
      { body: 'Parent-B', checked: true, isChild: false, order: 3, checkedTimestamp },
    ];
    const listFields = (hierarchy) => ({ id: listId, type: 'LIST', folder: 'NOTES', body: '', items: persistedItems(hierarchy) });
    const listBefore = checkSnapshot(listCreated, { id: 'created-list-exact-items', notes: [{ where: { title: listTitle }, fields: listFields(false) }] });
    listBefore.checks.push({ field: 'checked_timestamp_within_new_note_device_times', verdict: validCheckedTime ? 'passed' : 'failed' });
    await launch('list-created');
    const hierarchyUi = await scriptPhase('list-hierarchy'); const hierarchical = snapshot('list-hierarchy-db');
    const listNormal = checkSnapshot(hierarchical, { id: 'list.hierarchy.normal:oracle:1', notes: [{ where: { title: listTitle }, fields: listFields(true) }] });
    listNormal.checks.push({ field: 'flat_creation_and_single_parent_check', verdict: listBefore.checks.every((check) => check.verdict === 'passed') ? 'passed' : 'failed' },
      { field: 'prior_notes_and_labels_preserved', verdict: [listCreated, hierarchical].every((observed) => isDeepStrictEqual(organized.data.notes, observed.data.notes.filter((note) => note.id !== listId))
        && isDeepStrictEqual(organized.data.labels, observed.data.labels)) ? 'passed' : 'failed' });
    listNormal.verdict = listNormal.checks.every((check) => check.verdict === 'passed') ? 'passed' : 'failed'; listNormal.ok = listNormal.verdict === 'passed';
    record('list.hierarchy.normal', listNormal);
    const uiItems = (edited = false, first = false, second = false, checked = true) => [
      { body: 'Parent-A', isChild: false, checked: false }, { body: 'Child-A1', isChild: first, checked: false },
      { body: edited ? 'Child-A2-edited' : 'Child-A2', isChild: second, checked: false }, { body: 'Parent-B', isChild: false, checked },
    ];
    const listChecks = [
      ...['list-created-flat-editor', 'list-reopened-flat-editor', 'list-checked-editor'].map((name) => ({ name, screen: 'list-editor', items: uiItems(false, false, false, name === 'list-checked-editor') })),
      ...['list-created-flat-overview', 'list-checked-overview'].map((name) => ({ name, screen: 'list-overview', items: uiItems(false, false, false, name === 'list-checked-overview') })),
      { name: 'list-first-child', screen: 'list-editor', items: uiItems(false, true, false) },
      { name: 'list-two-children', screen: 'list-editor', items: uiItems(false, true, true) },
      { name: 'list-child-edited', screen: 'list-editor', items: uiItems(true, true, true) },
      { name: 'list-child-outdented', screen: 'list-editor', items: uiItems(true, false, true) },
      ...['list-child-restored', 'list-hierarchy-reopened'].map((name) => ({ name, screen: 'list-editor', items: uiItems(true, true, true) })),
      ...['list-hierarchy-overview', 'list-hierarchy-returned'].map((name) => ({ name, screen: 'list-overview', items: uiItems(true, true, true) })),
    ];
    record('list.hierarchy.normal', checkTextUi({ id: 'list.hierarchy.normal:oracle:2', runId: options.runId, title: listTitle, target: scriptTarget, hostPhases,
      checkpoints: [...listCreatedUi.checkpoints, ...hierarchyUi.checkpoints], expectedCheckpoints: listChecks }));
    Object.assign(executions.at(-1), { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [listCreatedUi.operationId, hierarchyUi.operationId] });
    executions.push({ scenarioId: 'list.hierarchy.restart', attempt: 1, executionStatus: 'running', startedAtMs: listStarted, sharedPrefixScenarioId: 'list.hierarchy.normal' });
    await launch('list-hierarchy'); const listRestartUi = await scriptPhase('list-restart'); const listRestarted = snapshot('list-restarted-db');
    const listRestart = checkSnapshot(listRestarted, { id: 'list.hierarchy.restart:oracle:1', notes: [{ where: { title: listTitle }, fields: listFields(true) }] });
    listRestart.checks.push({ field: 'whole_note_rows_and_labels_survive_restart', verdict: isDeepStrictEqual(hierarchical.data.notes, listRestarted.data.notes)
      && isDeepStrictEqual(hierarchical.data.labels, listRestarted.data.labels) ? 'passed' : 'failed' });
    listRestart.verdict = listRestart.checks.every((check) => check.verdict === 'passed') ? 'passed' : 'failed'; listRestart.ok = listRestart.verdict === 'passed';
    record('list.hierarchy.restart', listRestart);
    record('list.hierarchy.restart', checkTextUi({ id: 'list.hierarchy.restart:oracle:2', runId: options.runId, title: listTitle, target: scriptTarget, hostPhases,
      checkpoints: listRestartUi.checkpoints, expectedCheckpoints: ['list-restart-overview', 'list-restart-editor', 'list-restart-returned'].map((name) =>
        ({ name, screen: name === 'list-restart-editor' ? 'list-editor' : 'list-overview', items: uiItems(true, true, true) })) }));
    Object.assign(executions.at(-1), { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [listCreatedUi.operationId, hierarchyUi.operationId, listRestartUi.operationId] });
    await launch('list-restarted');
    const labelsStarted = Date.now();
    const labelsNormalExecution = { scenarioId: 'labels.manage.normal', attempt: 2, executionStatus: 'running', startedAtMs: labelsStarted,
      reason: 'Complete label-management sequence separately follows the earlier partial organization flow.' };
    executions.push(labelsNormalExecution);
    const preparedUi = await scriptPhase('labels-prepare'); const labelsPrepared = snapshot('labels-prepared-db');
    const preparedDb = checkLabelTransition({ id: 'labels.prepare:database', before: listRestarted, after: labelsPrepared,
      transition: { type: 'prepare', noteIds: [noteId, listId], labelA, labelAb } });
    const preparedTextUi = checkTextUi({ id: 'labels.prepare:text-ui', runId: options.runId, title, hostPhases, target: scriptTarget, checkpoints: preparedUi.checkpoints,
      expectedCheckpoints: ['labels-text-assigned-editor', 'labels-text-assigned-overview'].map((name) => ({ name, screen: name.endsWith('editor') ? 'editor' : 'overview',
        body: editedBody, requiredSelectors: [{ text: label }, { text: labelA }] })) });
    const preparedListUi = checkTextUi({ id: 'labels.prepare:list-ui', runId: options.runId, title: listTitle, hostPhases, target: scriptTarget, checkpoints: preparedUi.checkpoints,
      expectedCheckpoints: ['labels-list-assigned-editor', 'labels-list-assigned-overview'].map((name) => ({ name, screen: name.endsWith('editor') ? 'list-editor' : 'list-overview',
        items: uiItems(true, true, true), requiredSelectors: [{ text: labelAb }] })) });
    acceptLabelStep('labels-prepare', [preparedDb, preparedTextUi, preparedListUi]);

    const labelsNegativeExecution = { scenarioId: 'labels.manage.negative', attempt: 1, executionStatus: 'running', startedAtMs: Date.now() };
    executions.push(labelsNegativeExecution);
    const labelsUi = (phase, names, present, absent = [], inputs = []) => checkTextUi({ id: `${phase.phase}:ui`, runId: options.runId, title, hostPhases, target: scriptTarget,
      checkpoints: phase.checkpoints, expectedCheckpoints: [...names.map((name) => ({ name, screen: 'labels', labels: { present, absent } })), ...inputs] });
    await launch('labels-prepared');
    const duplicateUi = await scriptPhase('labels-duplicate'); const duplicateRejected = snapshot('labels-duplicate-db');
    const duplicateDb = compareCanonical(labelsPrepared, duplicateRejected, { id: 'labels.duplicate:database', ignoreFields: [] });
    const duplicateScreen = labelsUi(duplicateUi, ['labels-before-duplicate', 'labels-duplicate-rejected'], [label, labelA, labelAb], [],
      [{ name: 'labels-duplicate-input', screen: 'label-input-dialog', input: { title: '添加标签', value: labelA } }]);
    acceptLabelStep('labels-duplicate', [duplicateDb, duplicateScreen]);
    await launch('labels-duplicate');
    const conflictUi = await scriptPhase('labels-conflict'); const conflictRejected = snapshot('labels-conflict-db');
    const conflictDb = compareCanonical(duplicateRejected, conflictRejected, { id: 'labels.conflict:database', ignoreFields: [] });
    const conflictScreen = labelsUi(conflictUi, ['labels-before-conflict', 'labels-rename-conflict-rejected'], [label, labelA, labelAb], [],
      [{ name: 'labels-conflict-original-dialog', screen: 'label-input-dialog', input: { title: '编辑标签', value: labelA } },
        { name: 'labels-conflict-input', screen: 'label-input-dialog', input: { title: '编辑标签', value: labelAb } }]);
    acceptLabelStep('labels-conflict', [conflictDb, conflictScreen]);
    await launch('labels-conflict');
    const renameUi = await scriptPhase('labels-rename'); const labelsRenamed = snapshot('labels-renamed-db');
    const renamedDb = checkLabelTransition({ id: 'labels.rename:database', before: conflictRejected, after: labelsRenamed,
      transition: { type: 'rename', old: labelA, new: labelRenamed } });
    const renamedScreen = checkTextUi({ id: 'labels.rename:management-ui', runId: options.runId, title, hostPhases, target: scriptTarget, checkpoints: renameUi.checkpoints,
      expectedCheckpoints: ['labels-renamed-manager', 'labels-renamed-navigation'].map((name) => ({ name, screen: name.endsWith('navigation') ? 'label-navigation' : 'labels',
        labels: { present: [label, labelRenamed, labelAb], absent: [labelA] } })) });
    const renamedText = checkTextUi({ id: 'labels.rename:text-ui', runId: options.runId, title, hostPhases, target: scriptTarget, checkpoints: renameUi.checkpoints,
      expectedCheckpoints: [{ name: 'labels-renamed-text', screen: 'editor', body: editedBody, requiredSelectors: [{ text: label }, { text: labelRenamed }], absentSelectors: [{ text: labelA }, { text: labelAb }] }] });
    const renamedList = checkTextUi({ id: 'labels.rename:list-ui', runId: options.runId, title: listTitle, hostPhases, target: scriptTarget, checkpoints: renameUi.checkpoints,
      expectedCheckpoints: [{ name: 'labels-renamed-list', screen: 'list-editor', items: uiItems(true, true, true), requiredSelectors: [{ text: labelAb }], absentSelectors: [{ text: labelA }, { text: labelRenamed }] }] });
    acceptLabelStep('labels-rename', [renamedDb, renamedScreen, renamedText, renamedList]);
    await launch('labels-renamed');
    const cancelledUi = await scriptPhase('labels-cancel-delete'); const labelsCancelled = snapshot('labels-cancelled-db');
    const cancelDb = compareCanonical(labelsRenamed, labelsCancelled, { id: 'labels.cancel:database', ignoreFields: [] });
    const cancelScreen = checkTextUi({ id: 'labels.cancel:ui', runId: options.runId, title, hostPhases, target: scriptTarget, checkpoints: cancelledUi.checkpoints,
      expectedCheckpoints: [{ name: 'labels-before-cancel', screen: 'labels', labels: { present: [label, labelRenamed, labelAb], absent: [labelA] } },
        { name: 'labels-cancel-dialog', screen: 'label-delete-dialog', dialog: 'delete-label-confirmation' },
        { name: 'labels-delete-cancelled', screen: 'labels', labels: { present: [label, labelRenamed, labelAb], absent: [labelA] } }] });
    acceptLabelStep('labels-cancel', [cancelDb, cancelScreen]);
    record('labels.manage.negative', combine('labels.manage.negative:oracle:1', [duplicateDb, conflictDb, cancelDb]));
    record('labels.manage.negative', combine('labels.manage.negative:oracle:2', [duplicateScreen, conflictScreen, cancelScreen]));
    Object.assign(labelsNegativeExecution, { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [duplicateUi.operationId, conflictUi.operationId, cancelledUi.operationId] });
    await launch('labels-cancelled');
    const deletedUi = await scriptPhase('labels-delete'); const labelsDeleted = snapshot('labels-deleted-db');
    const deleteDb = checkLabelTransition({ id: 'labels.delete:database', before: labelsCancelled, after: labelsDeleted, transition: { type: 'delete', value: labelRenamed } });
    const deletedScreen = checkTextUi({ id: 'labels.delete:management-ui', runId: options.runId, title, hostPhases, target: scriptTarget, checkpoints: deletedUi.checkpoints,
      expectedCheckpoints: [{ name: 'labels-before-delete', screen: 'labels', labels: { present: [label, labelRenamed, labelAb], absent: [labelA] } },
        { name: 'labels-confirm-delete-dialog', screen: 'label-delete-dialog', dialog: 'delete-label-confirmation' },
        { name: 'labels-deleted-manager', screen: 'labels', labels: { present: [label, labelAb], absent: [labelA, labelRenamed] } },
        { name: 'labels-deleted-navigation', screen: 'label-navigation', labels: { present: [label, labelAb], absent: [labelA, labelRenamed] } }] });
    const deletedNoteChecks = (phase, prefix, list = false) => checkTextUi({ id: `${prefix}:${list ? 'list' : 'text'}-ui`, runId: options.runId, title: list ? listTitle : title, hostPhases, target: scriptTarget,
      checkpoints: phase.checkpoints, expectedCheckpoints: [`${prefix}-${list ? 'list' : 'text'}-overview`, `${prefix}-${list ? 'list' : 'text'}`].map((name) => ({ name,
        screen: `${list ? 'list-' : ''}${name.endsWith('overview') ? 'overview' : 'editor'}`, ...(list ? { items: uiItems(true, true, true) } : { body: editedBody }),
        requiredSelectors: [{ text: list ? labelAb : label }], absentSelectors: [labelA, labelRenamed, list ? label : labelAb].map((text) => ({ text })) })) });
    const deletedText = deletedNoteChecks(deletedUi, 'labels-deleted'), deletedList = deletedNoteChecks(deletedUi, 'labels-deleted', true);
    acceptLabelStep('labels-delete', [deleteDb, deletedScreen, deletedText, deletedList]);
    record('labels.manage.normal', combine('labels.manage.normal:oracle:1', [preparedDb, renamedDb, cancelDb, deleteDb]), 2);
    record('labels.manage.normal', combine('labels.manage.normal:oracle:2', [preparedTextUi, preparedListUi, renamedScreen, renamedText, renamedList, cancelScreen, deletedScreen, deletedText, deletedList]), 2);
    Object.assign(labelsNormalExecution, { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [preparedUi.operationId, renameUi.operationId, cancelledUi.operationId, deletedUi.operationId] });

    const labelsRestartExecution = { scenarioId: 'labels.manage.restart', attempt: 1, executionStatus: 'running', startedAtMs: labelsStarted, sharedPrefixScenarioId: 'labels.manage.normal' };
    executions.push(labelsRestartExecution);
    await launch('labels-deleted');
    const labelsRestartUi = await scriptPhase('labels-restart'); const labelsRestarted = snapshot('labels-restarted-db');
    const labelRestartDb = compareCanonical(labelsDeleted, labelsRestarted, { id: 'labels.restart:database', ignoreFields: [] });
    const labelRestartScreen = checkTextUi({ id: 'labels.restart:management-ui', runId: options.runId, title, hostPhases, target: scriptTarget, checkpoints: labelsRestartUi.checkpoints,
      expectedCheckpoints: ['labels-restart-manager', 'labels-restart-navigation'].map((name) => ({ name, screen: name.endsWith('navigation') ? 'label-navigation' : 'labels',
        labels: { present: [label, labelAb], absent: [labelA, labelRenamed] } })) });
    const labelRestartText = deletedNoteChecks(labelsRestartUi, 'labels-restart'), labelRestartList = deletedNoteChecks(labelsRestartUi, 'labels-restart', true);
    acceptLabelStep('labels-restart', [labelRestartDb, labelRestartScreen, labelRestartText, labelRestartList]);
    record('labels.manage.restart', combine('labels.manage.restart:oracle:1', [preparedDb, renamedDb, deleteDb, labelRestartDb]));
    record('labels.manage.restart', combine('labels.manage.restart:oracle:2', [labelRestartScreen, labelRestartText, labelRestartList]));
    Object.assign(labelsRestartExecution, { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds: [preparedUi.operationId, renameUi.operationId, cancelledUi.operationId, deletedUi.operationId, labelsRestartUi.operationId] });
    if (assignmentCommon) {
      const hidden = labelsRestarted.data.preferences.labelsHiddenInNavigation || [];
      const visibleLabels = labelsRestarted.data.labels.filter(row => !hidden.includes(row.value)).sort((a, b) => b.order - a.order).slice(0, 5);
      if (!visibleLabels.some(row => row.value === assignmentCommon)) throw new Error('assignment_common_label_not_in_visible_navigation');
      assignmentMembers = {
        common: labelsRestarted.data.notes.filter(note => note.folder === 'NOTES' && note.id !== listId && (note.id === noteId || note.labels.includes(assignmentCommon))).map(note => note.title),
        unlabeled: labelsRestarted.data.notes.filter(note => note.folder === 'NOTES' && (note.id === listId || (note.id !== noteId && note.labels.length === 0))).map(note => note.title),
      };
      const assignmentStarted = Date.now();
      const assignmentRows = ['normal', 'negative', 'restart'].map(kind => ({ scenarioId: `labels.assignment.${kind}`, attempt: kind === 'normal' ? 2 : 1,
        executionStatus: 'running', startedAtMs: assignmentStarted, partialFlow: 'batch-save-cancel-single-remove-membership-restart' }));
      executions.push(...assignmentRows);
      const assess = (name, results) => {
        const assessment = combine(name, results); assignmentAssessments.push(assessment); write(path.join(out, `${name}-oracles.json`), assessment);
        if (!assessment.ok) throw new Error(`assignment_oracle:${name}:${assessment.verdict}`);
      };
      const ui = (phase, titleValue, expectedCheckpoints) => checkTextUi({ id: `${phase.phase}:${titleValue === title ? 'text' : 'list'}-ui`,
        runId: options.runId, title: titleValue, hostPhases, target: scriptTarget, checkpoints: phase.checkpoints, expectedCheckpoints });
      const selectors = values => values.map(text => ({ text }));
      const dialogs = phase => ['initial', 'changed'].map(suffix => ({ name: `${phase.phase}-${suffix}`, screen: 'assignment-dialog', assignment: { labels: [label, labelAb, assignmentCommon] } }));
      const overviewText = (name, present, absent) => ({ name, screen: 'overview', body: editedBody, requiredSelectors: selectors(present), absentSelectors: selectors(absent) });
      const listCheckpoint = (name, screen, present, absent) => ({ name, screen, items: uiItems(true, true, true), requiredSelectors: selectors(present), absentSelectors: selectors(absent) });
      const memberships = prefix => ['common', 'unlabeled'].map(name => ({ name: `${prefix}-${name}-members`, screen: 'membership',
        members: { title: name === 'common' ? assignmentCommon : '未加标签', titles: assignmentMembers[name] } }));
      await launch('assignment-before');
      const assignmentCancelledUi = await scriptPhase('assignment-cancel'); const assignmentCancelled = snapshot('assignment-cancelled-db');
      assess('assignment-cancel', [compareCanonical(labelsRestarted, assignmentCancelled, { id: 'assignment.cancel:database', ignoreFields: [] }),
        ui(assignmentCancelledUi, title, [...dialogs(assignmentCancelledUi), overviewText('assignment-cancel-text', [label], [labelAb, assignmentCommon])]),
        ui(assignmentCancelledUi, listTitle, [listCheckpoint('assignment-cancel-list', 'list-overview', [labelAb], [label, assignmentCommon])])]);
      await launch('assignment-cancelled');
      const assignmentAppliedUi = await scriptPhase('assignment-apply'); const assignmentApplied = snapshot('assignment-applied-db');
      assess('assignment-apply', [checkLabelAssignment({ id: 'assignment.apply:database', before: assignmentCancelled, after: assignmentApplied,
        expectedLabelsById: { [noteId]: [label, assignmentCommon], [listId]: [assignmentCommon] } }),
        ui(assignmentAppliedUi, title, [...dialogs(assignmentAppliedUi), overviewText('assignment-apply-text', [label, assignmentCommon], [labelAb])]),
        ui(assignmentAppliedUi, listTitle, [listCheckpoint('assignment-apply-list', 'list-overview', [assignmentCommon], [label, labelAb])])]);
      await launch('assignment-applied');
      const assignmentRemovedUi = await scriptPhase('assignment-remove'); const assignmentRemoved = snapshot('assignment-removed-db');
      assess('assignment-remove', [checkLabelAssignment({ id: 'assignment.remove:database', before: assignmentApplied, after: assignmentRemoved,
        expectedLabelsById: { [listId]: [] }, editorSave: true }),
        ui(assignmentRemovedUi, listTitle, [listCheckpoint('assignment-before-remove', 'list-editor', [assignmentCommon], [labelAb]),
          listCheckpoint('assignment-removed-editor', 'list-editor', [], [label, labelAb, assignmentCommon]),
          listCheckpoint('assignment-removed-overview', 'list-overview', [], [label, labelAb, assignmentCommon]), ...memberships('assignment')])]);
      await launch('assignment-removed');
      const assignmentRestartUi = await scriptPhase('assignment-restart'); const assignmentRestarted = snapshot('assignment-restarted-db');
      assess('assignment-restart', [compareCanonical(assignmentRemoved, assignmentRestarted, { id: 'assignment.restart:database', ignoreFields: [] }),
        ui(assignmentRestartUi, title, [overviewText('assignment-restart-text', [label, assignmentCommon], [labelAb])]),
        ui(assignmentRestartUi, listTitle, [listCheckpoint('assignment-restart-list', 'list-overview', [], [label, labelAb, assignmentCommon]), ...memberships('assignment-restart')])]);
      for (const row of assignmentRows) {
        Object.assign(row, { executionStatus: 'completed', finishedAtMs: Date.now(), sourceScriptOperationIds:
          [assignmentCancelledUi, assignmentAppliedUi, assignmentRemovedUi, assignmentRestartUi].map(phase => phase.operationId) });
        for (const oracle of scenarios.scenarios.find(scenario => scenario.id === row.scenarioId).oracles) record(row.scenarioId,
          { id: oracle.id, source: 'independent-host-business-oracle', verdict: 'inconclusive', reason: 'verified_assignment_fragments_do_not_machine_verify_custom_tristate_drawable',
            observedFlowId: 'batch-save-cancel-single-remove-membership-restart' }, row.attempt);
      }
    }
    await launch('final');
  } catch (error) {
    failure = error.message;
    for (const row of executions) if (row.executionStatus === 'running') Object.assign(row, { executionStatus: 'failed', finishedAtMs: Date.now(), error: failure });
    if (client && operationId) try { write(path.join(out, 'cancel.json'), await run('script', { operation: 'cancel', operationId })); } catch (cancelError) { write(path.join(out, 'cancel-error.json'), { error: cancelError.message }); }
  } finally {
    if (client) await client.close();
    timing.regression ||= { startedAtMs: Date.now() }; timing.regression.finishedAtMs = Date.now();
  }
  write(path.join(out, 'execution-records.json'), { executions, phases, snapshots, title, listTitle, label, labelA, labelAb, labelRenamed, originalBody, editedBody, labelAssessments, assignmentCommon, assignmentMembers, assignmentAssessments, failure });
  write(path.join(out, 'oracle-results.json'), { requiredResults: oracleResults, observedFlows });
  const artifacts = [{ role: 'apk', path: options.apk, sha256: identity.apkSha256 }, ...sourceProvenance.artifacts, ...labelsSourceProvenance.artifacts, ...(assignmentSourceProvenance?.artifacts || []), ...hostCode.artifacts];
  const roles = { 'regression-script.js': 'script', 'feature-inventory.json': 'inventory', 'scenarios.json': 'scenarios' };
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'host-facts') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file); else if (entry.isFile()) artifacts.push({ role: directory === frozen ? roles[entry.name] || 'frozen-support' : 'evidence', path: file, sha256: hash(file) });
  } };
  walk(out);
  const report = buildReport({ inventory, scenarios, executions, oracleResults, timing, artifacts, identity, budgetMs: 600000 });
  report.evidenceSourceIndex = sourceIndex;
  report.sourceProvenance = sourceProvenance;
  report.labelsSourceProvenance = labelsSourceProvenance;
  report.assignmentSourceProvenance = assignmentSourceProvenance;
  report.timing.regression.finishedAtMs = Date.now();
  report.timing.regression.wallMs = report.timing.regression.finishedAtMs - report.timing.regression.startedAtMs;
  report.acceptance.withinBudget = report.timing.regression.wallMs <= report.acceptance.budgetMs;
  report.ok = report.acceptance.fullFrozenScopePassed && report.acceptance.artifactIntegrityPassed && report.acceptance.withinBudget;
  const coreIds = ['note.text_crud.normal', 'note.text_crud.restart', 'list.hierarchy.normal', 'list.hierarchy.restart', 'labels.manage.normal', 'labels.manage.negative', 'labels.manage.restart'];
  report.core = { scope: 'text-list-label-management-restart-candidate', assignmentExtension: !!assignmentCommon, fullAppClaim: false, failure: failure || null, observedFlows, labelAssessments, assignmentAssessments,
    cases: report.scenarios.filter((row) => coreIds.includes(row.id)),
    expectedCaseCount: coreIds.length, passed: report.scenarios.filter((row) => coreIds.includes(row.id) && row.verdict === 'passed').length };
  report.core.ok = !failure && report.core.passed === coreIds.length && labelAssessments.length === 7 && labelAssessments.every((assessment) => assessment.ok)
    && (!assignmentCommon || assignmentAssessments.length === 4 && assignmentAssessments.every(assessment => assessment.ok))
    && observedFlows.length === 1 && observedFlows.every((flow) => flow.verdict === 'passed') && report.acceptance.artifactIntegrityPassed && report.acceptance.withinBudget;
  if (assignmentCommon) report.notes.push('Four assignment phases verify exact cancellation, multi-note SQL changes, single-note removal, membership and restart. Dialog identity is checked, but custom tri-state selection remains a visual review boundary; full assignment templates stay inconclusive.');
  report.notes.push('This candidate attempts two text, two list hierarchy and three label management scenarios. Multi-note tri-state assignment and complete pin/color scenarios remain partial.',
    'Label negative acceptance requires separate canonical equality after duplicate-create, conflicting rename and cancelled deletion. Actual deletion must preserve all other note fields and update every label reference.',
    'The restart case explicitly reuses the normal case prefix, then executes its own force-stop/launch/read-back.',
    'Construction measures only input freezing here. Historical Intent exploration, coding and debugging duration is not estimated.',
    'All collectors and launches, APK preflight and independent oracle evaluation are included in the fixed regression clock.');
  const paths = writeReport(report, path.join(out, 'report'));
  return { ok: report.core.ok, fullAppPassed: report.ok, coverage: report.coverage, paths, failure };
}

if (require.main === module) main(parseArguments(process.argv.slice(2))).then((result) => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1; })
  .catch((error) => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main, parseArguments, apkPackage, hostCodeManifest };
