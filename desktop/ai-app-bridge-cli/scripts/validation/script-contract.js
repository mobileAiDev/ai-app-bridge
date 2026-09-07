#!/usr/bin/env node
'use strict';

// Explicit real-device integration test. Importing it never starts a server/device.
// The supplied server may be a development checkout or an installed package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);

function optionsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--server', '--serial', '--package', '--out'].includes(key) || !argv[index + 1]) {
      throw new Error('Require --server <mcp-server.js> --serial <serial> --package <package> --out <new-directory>');
    }
    options[key.slice(2)] = argv[index + 1];
  }
  for (const key of ['server', 'serial', 'package', 'out']) assert.ok(options[key], `Missing --${key}`);
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = optionsOf(argv);
  const serverPath = fs.realpathSync(options.server);
  const out = path.resolve(options.out);
  fs.mkdirSync(out, { recursive: false });
  const target = { serial: options.serial, packageName: options.package };
  const report = { schemaVersion: 'aab.script-contract-validation/v1', ok: false, startedAt: new Date().toISOString(),
    target, serverPath, serverSha256: sha(serverPath), node: process.version,
    scope: 'Public MCP and real Node child on an Android Bridge target. Checks are runtime contracts, not business acceptance.', checks: [], operations: {} };
  const write = (name, value) => {
    fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    return value;
  };
  const save = () => write('report', report);
  const sourcePath = path.join(out, 'scenario.js');
  fs.copyFileSync(path.join(__dirname, 'script-contract-scenario.js'), sourcePath);
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  fs.copyFileSync(path.join(__dirname, 'mcp-jsonrpc-client.js'), path.join(out, 'mcp-jsonrpc-client.js'));
  report.scenarioSha256 = sha(sourcePath);
  const runtimeRoot = path.dirname(serverPath);
  report.runtimeFiles = [];
  const indexRuntime = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) indexRuntime(file);
      else if (entry.isFile()) report.runtimeFiles.push({ path: file, sha256: sha(file) });
    }
  };
  indexRuntime(runtimeRoot);
  let client, hostIndex = 0;
  const live = new Set();
  async function newHost() {
    if (client) write(`host-${hostIndex}-exit`, await client.close());
    hostIndex += 1;
    client = createMcpClient({ serverPath, transcriptPath: path.join(out, `host-${hostIndex}.jsonl`),
      stderrPath: path.join(out, `host-${hostIndex}.log`),
      env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'host-facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
    await client.initialize();
    live.clear();
  }
  const tool = async (name, args) => payloadOf(await client.request('tools/call', { name, arguments: args }));
  const script = args => tool('run', { command: 'script', arguments: args });
  async function waitFor(operationId, predicate = item => terminal(item.status)) {
    const deadline = Date.now() + 90_000;
    let state = await script({ operation: 'status', operationId, afterSequence: 0 });
    while (!predicate(state)) {
      assert.equal(state.ok, true, JSON.stringify(state));
      assert.ok(!terminal(state.status), `Unexpected terminal: ${JSON.stringify(state)}`);
      assert.ok(Date.now() < deadline, `Operation timeout: ${operationId}`);
      state = await script({ operation: 'wait', operationId, afterSequence: state.eventSequence, waitMs: 1000 });
    }
    const full = await script({ operation: 'status', operationId, afterSequence: 0, limit: 500 });
    if (terminal(full.status)) live.delete(operationId);
    write(`${operationId}-${hostIndex}-${full.status}`, full);
    return full;
  }
  async function start(scenario, inputs = {}, restartPolicy = 'none') {
    const directory = path.join(out, scenario);
    fs.mkdirSync(directory);
    const spec = { schemaVersion: 'aab.code-script/v1', name: scenario, language: 'javascript', sourcePath, target,
      inputs: { scenario, out: directory, ...inputs }, permissions: ['app.read', 'app.interact'],
      policy: { timeoutMs: 120000, restartPolicy } };
    const begun = write(`${scenario}-start`, await script({ operation: 'start', script: spec }));
    assert.equal(begun.ok, true, JSON.stringify(begun));
    live.add(begun.operationId);
    report.operations[scenario] = { operationId: begun.operationId, spec };
    save();
    return begun.operationId;
  }
  const resultOf = state => {
    assert.equal(state.status, 'completed', JSON.stringify(state));
    const event = state.events.find(item => item.type === 'script_completed');
    assert.ok(event, 'Missing completed event');
    return event.result;
  };
  const verdict = (value, expected, reason) => {
    assert.equal(value.verdict, expected, JSON.stringify(value));
    if (reason) assert.equal(value.reason, reason);
  };
  const check = (name, observed) => {
    report.checks.push({ name, verdict: 'passed', observed }); save();
    process.stdout.write(`${JSON.stringify(report.checks.at(-1))}\n`);
  };
  const factsOf = state => {
    assert.equal(state.history.hasMore, false, 'Contract reviewer requires complete history');
    assert.equal(state.history.gap, false, 'Contract reviewer rejects truncated history');
    return state.history.items;
  };
  const issuedTree = relative => {
    const read = JSON.parse(fs.readFileSync(path.join(out, relative), 'utf8'));
    assert.equal(read.ok, true);
    assert.ok(read.result.nodes.some(node => node.visible === true));
    assert.equal(read.evidence.source.command, 'tree');
    assert.equal(read.evidence.source.payloadSha256, crypto.createHash('sha256').update(JSON.stringify(read.result)).digest('hex'));
    return read;
  };
  const checkScreenshot = scenario => {
    const read = JSON.parse(fs.readFileSync(path.join(out, scenario, 'screenshot.json'), 'utf8'));
    assert.equal(read.ok, true);
    const file = path.join(out, scenario, 'screen.png');
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const ref = read.evidence.refs.find(item => item.stream === 'screenshot');
    assert.equal(ref.screenshotId, file);
    assert.equal(ref.sha256, sha(file));
  };

  try {
    save(); await newHost();
    const capabilities = write('script-capabilities', await tool('capabilities', { command: 'script', includeOptions: true }));
    assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
    assert.equal(capabilities.catalog.schemaVersion, 'aab.code-script/v1');
    const status = write('initial-status', await tool('run', { command: 'status', arguments: target }));
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.app.packageName, target.packageName);
    assert.equal(status._feedback.target.serial, target.serial);
    report.device = { app: status.app, android: status.android, debugBridge: status.debugBridge };
    check('public-entry-and-device', { schema: capabilities.catalog.schemaVersion, app: status.app.packageName });

    const seedId = await start('seed');
    const seed = await waitFor(seedId);
    const seedResult = resultOf(seed);
    issuedTree('seed/tree.json');
    checkScreenshot('seed');
    verdict(seedResult.verdict, 'passed');
    check('fresh-observation', { execution: seed.status, assertion: seedResult.verdict });

    const evidenceId = await start('evidence', { foreignEvidence: seedResult.evidence });
    const evidence = await waitFor(evidenceId);
    const values = resultOf(evidence).verdicts;
    issuedTree('evidence/before.json'); issuedTree('evidence/after.json');
    verdict(values.fresh, 'passed'); verdict(values.refreshed, 'passed');
    verdict(values.falsePredicate, 'failed');
    verdict(values.missing, 'inconclusive', 'evidence_not_host_issued');
    verdict(values.wrongStream, 'inconclusive', 'required_evidence_missing');
    verdict(values.tampered, 'inconclusive', 'evidence_not_host_issued');
    verdict(values.foreign, 'inconclusive', 'evidence_not_host_issued');
    verdict(values.stale, 'inconclusive', 'evidence_action_window_stale');
    assert.deepEqual(evidence.rollingSummary.assertionScopes, {
      code: { passed: 1, failed: 0, inconclusive: 0 }, device: { passed: 2, failed: 1, inconclusive: 5 },
    });
    check('execution-and-assertion-separation', { execution: evidence.status, assertions: evidence.rollingSummary.assertionScopes });
    for (const key of ['missing', 'wrongStream', 'tampered', 'foreign', 'stale', 'refreshed']) check(`evidence-${key}`, values[key]);

    const cancelId = await start('cancel');
    await waitFor(cancelId, state => state.status === 'waiting_for_agent');
    const cancelled = write('cancel-reply', await script({ operation: 'cancel', operationId: cancelId }));
    assert.equal(cancelled.status, 'cancelled'); live.delete(cancelId);
    const afterCancelId = await start('after-cancel');
    verdict(resultOf(await waitFor(afterCancelId)).verdict, 'passed');
    checkScreenshot('after-cancel');
    const cancelledFull = await waitFor(cancelId);
    assert.equal(factsOf(cancelledFull).some(item => item.kind === 'action_receipt'), false);
    assert.equal(fs.existsSync(path.join(out, 'cancel/after-cancel-mutation.json')), false);
    check('cancel-stops-continuation-and-next-script-runs', { status: cancelledFull.status, mutationReceipts: 0 });

    const crashId = await start('child-crash', {}, 'checkpoint');
    const crashed = await waitFor(crashId);
    assert.equal(crashed.status, 'failed'); assert.equal(crashed.error, 'child_crashed');
    const effectId = await start('effect-after-checkpoint', {}, 'checkpoint');
    const effected = await waitFor(effectId);
    assert.equal(effected.status, 'failed'); assert.equal(effected.error, 'child_crashed');
    const lostId = await start('host-restart', {}, 'checkpoint');
    await waitFor(lostId, state => state.status === 'waiting_for_agent');
    const noneId = await start('no-restart');
    await waitFor(noneId, state => state.status === 'waiting_for_agent');
    await newHost();

    for (const [name, id, expectedStatus] of [['completed', seedId, 'completed'], ['cancelled', cancelId, 'cancelled']]) {
      const restored = write(`${name}-after-host-restart`, await script({ operation: 'status', operationId: id }));
      assert.equal(restored.status, expectedStatus); assert.equal(restored.resumable, false);
      const rejected = write(`${name}-resume-rejected`, await script({ operation: 'resume', operationId: id }));
      assert.equal(rejected.error, 'not_resumable');
      check(`terminal-${name}-cannot-replay`, { status: restored.status, resumeError: rejected.error });
    }
    const none = write('no-restart-restored', await script({ operation: 'status', operationId: noneId }));
    assert.equal(none.status, 'failed'); assert.equal(none.error, 'runtime_lost'); assert.equal(none.resumable, false);
    const blocked = write('no-restart-resume', await script({ operation: 'resume', operationId: noneId, script: report.operations['no-restart'].spec }));
    assert.equal(blocked.error, 'not_resumable');
    check('restart-policy-none', { status: none.status, error: none.error, resumeError: blocked.error });

    const ambiguous = write('effect-after-checkpoint-resume', await script({ operation: 'resume', operationId: effectId }));
    assert.equal(ambiguous.error, 'ambiguous');
    check('effect-after-checkpoint-no-replay', { resumeError: ambiguous.error });

    for (const [name, id, expectedError] of [['child-crash', crashId, 'child_crashed'], ['host-restart', lostId, 'runtime_lost']]) {
      const restored = write(`${name}-restored`, await script({ operation: 'status', operationId: id }));
      assert.equal(restored.status, 'failed'); assert.equal(restored.error, expectedError); assert.equal(restored.resumable, true);
      const resumed = write(`${name}-resume`, await script({ operation: 'resume', operationId: id }));
      assert.equal(resumed.ok, true, JSON.stringify(resumed)); live.add(id);
      const completed = await waitFor(id);
      const result = resultOf(completed);
      issuedTree(`${name}/after-restart.json`);
      verdict(result.old, 'inconclusive', 'evidence_not_host_issued'); verdict(result.fresh, 'passed');
      assert.equal(result.app.packageName, target.packageName);
      check(`${name}-real-provider-recovery`, { initialError: expectedError, execution: completed.status, old: result.old, fresh: result.fresh });
    }
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (client) {
      for (const operationId of live) {
        try { write(`${operationId}-cleanup`, await script({ operation: 'cancel', operationId })); }
        catch (error) { report.cleanupError = error.message; report.ok = false; }
      }
      write(`host-${hostIndex}-exit`, await client.close());
    }
    if (report.ok) {
      try {
        const durable = await reviewDurable({ out, runtimeRoot, operations: report.operations });
        check('durable-reopen-and-no-repeated-actions', durable);
      } catch (error) {
        report.ok = false; report.error = error.stack || String(error); process.exitCode = 1;
      }
    }
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    save();
    const artifacts = [];
    const index = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) index(file);
        else if (entry.isFile()) artifacts.push({ path: path.relative(out, file), bytes: fs.statSync(file).size, sha256: sha(file) });
      }
    };
    index(out); write('archive-manifest', { artifacts });
    if (!report.ok) process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: report.checks.length, elapsedMs: report.elapsedMs, out, error: report.error })}\n`);
  }
  return report;
}

async function reviewDurable({ out, runtimeRoot, operations }) {
  const { createFactStore } = require(path.join(runtimeRoot, 'fact-store'));
  const { verifyChecksum } = require(path.join(runtimeRoot, 'shared-kernel/evidence-schema'));
  const source = path.join(out, 'host-facts');
  const review = path.join(out, 'durable-review');
  fs.mkdirSync(review);
  const copy = path.join(review, 'facts-copy');
  const fileHashes = directory => {
    const files = [];
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) walk(file);
        else { assert.ok(entry.isFile()); files.push({ path: path.relative(directory, file), sha256: sha(file) }); }
      }
    };
    walk(directory); return files.sort((a, b) => a.path.localeCompare(b.path));
  };
  const sourceBefore = fileHashes(source);
  fs.cpSync(source, copy, { recursive: true });
  let first;
  for (let pass = 0; pass < 2; pass += 1) {
    const store = createFactStore({ directory: copy });
    const results = [];
    try {
      for (const [scenario, { operationId }] of Object.entries(operations)) {
        let cursor; const records = [];
        do {
          const page = store.read({ targetKey: `evidence:script:${operationId}`, limit: 1000, ...(cursor ? { cursor } : {}) });
          assert.equal(page.ok, true, JSON.stringify(page));
          records.push(...page.items.map(item => item.payload));
          if (!page.hasMore) break;
          assert.ok(page.cursor); assert.notEqual(page.cursor, cursor); cursor = page.cursor;
        } while (true);
        assert.ok(records.length > 0, `No durable records: ${scenario}`);
        for (const record of records) {
          assert.equal(record.operationId, operationId);
          assert.equal(verifyChecksum(record).ok, true, record.evidenceId);
        }
        const markers = records.filter(item => item.kind === 'dispatch-marker');
        const receipts = records.filter(item => item.kind === 'action-receipt');
        const expected = scenario === 'cancel' ? 0 : 1;
        assert.equal(markers.length, expected, `Repeated prepared action: ${scenario}`);
        assert.equal(receipts.length, expected, `Repeated receipt: ${scenario}`);
        for (const receipt of receipts) {
          assert.equal(receipt.actionId, `${operationId}:action-1`);
          assert.equal(receipt.dispatched, true); assert.equal(receipt.ambiguous, false);
          assert.equal(receipt.mechanicalStatus, 'ok');
        }
        const identities = records.map(item => ({ evidenceId: item.evidenceId, checksum: item.checksum, kind: item.kind }));
        assert.equal(new Set(identities.map(item => item.evidenceId)).size, records.length);
        results.push({ scenario, operationId, records: records.length, dispatchedActions: receipts.length, identities });
        if (pass === 0) fs.writeFileSync(path.join(review, `${scenario}.json`), `${JSON.stringify(records, null, 2)}\n`);
      }
    } finally { await store.close(); }
    if (pass === 0) first = results;
    else assert.deepEqual(results, first, 'Durable evidence changed after close/reopen');
  }
  assert.deepEqual(fileHashes(source), sourceBefore, 'Original closed facts were modified by review');
  const summary = { reopenPasses: 2, originalFilesUnchanged: true, records: first.reduce((total, item) => total + item.records, 0),
    dispatchedActions: first.reduce((total, item) => total + item.dispatchedActions, 0),
    operations: first.map(({ identities, ...item }) => item) };
  fs.writeFileSync(path.join(review, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, optionsOf, reviewDurable };
