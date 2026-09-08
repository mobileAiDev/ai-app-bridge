#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

// Public MCP check of real SDK event payload recording, not a business test.
async function main({ server, serial, packageName, out }) {
  assert(server && serial && packageName && out, 'server_serial_package_out_required');
  const root = path.resolve(out); fs.mkdirSync(root);
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
  const open = (name, env) => createMcpClient({ serverPath: path.resolve(server),
    transcriptPath: path.join(root, name + '.jsonl'), stderrPath: path.join(root, name + '-stderr.log'), env });
  const client = open('live', { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(root, 'host-facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const target = { serial, packageName };
  const report = { ok: false, target, startedAtMs: Date.now(), archives: [] };
  let scriptId, intentId;
  try {
    await client.initialize();
    const launched = await run('launch-app', target); write('launch.json', launched); assert.equal(launched.ok, true);
    let status, probe = 0;
    const readyDeadline = Date.now() + 30000;
    do {
      status = await run('status', target); write('status-' + (++probe) + '.json', status);
      assert.equal(status.ok, true);
      if (status.capturePersistence?.persistent === true) break;
      assert.equal(status.capturePersistence?.attachmentState, 'opening', 'mobile_capture_open_failed');
      assert(Date.now() < readyDeadline, 'mobile_capture_open_timeout');
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
    write('status.json', status);
    assert.equal(status.ok, true); assert.equal(status.app.packageName, packageName);
    assert.equal(status._feedback.target.serial, serial);
    // Startup events may precede durable attachment. Produce real lifecycle
    // events after readiness, without injecting a synthetic HTTP capture record.
    const home = await run('keyevent', { serial, keyCode: 3 }); write('home.json', home); assert.equal(home.ok, true);
    const resumed = await run('launch-app', target); write('resume.json', resumed); assert.equal(resumed.ok, true);
    const tree = await run('tree', { ...target, compact: false }); write('source-tree.json', tree); assert.equal(tree.ok, true);
    let page;
    const eventsDeadline = Date.now() + 5000;
    probe = 0;
    do {
      page = await run('events', { ...target, view: 'decision-window', limit: 200 }); write('source-events-' + (++probe) + '.json', page);
      assert.equal(page.ok, true);
      if (page.refs.length > 0) break;
      assert(Date.now() < eventsDeadline, 'real_sdk_events_required');
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
    write('source-events.json', page);
    assert.equal(page.ok, true); assert(page.refs.length > 0, 'real_sdk_events_required');
    assert.equal(page.refs.length, page.items.length);
    const ref = page.refs.at(-1), item = page.items.at(-1);
    assert.equal(ref.captureId, item.id); assert.equal(ref.capturedAtMs, item.timestampMs);
    assert.equal(ref.runtimeEpoch, page.runtimeEpoch); assert.equal(ref.targetKey, packageName);
    const query = { view: 'decision-window', runtimeEpoch: ref.runtimeEpoch, mobileFactId: ref.mobileFactId, limit: 1 };
    const source = `exports.main = async ctx => {
      const found = await ctx.call('events', ctx.inputs.query);
      const verdict = await ctx.assert({ name: 'exact mobile fact payload', scope: 'device',
        condition: found.ok && JSON.stringify(found.result.items) === JSON.stringify([ctx.inputs.item])
          && JSON.stringify(found.evidence.refs) === JSON.stringify([ctx.inputs.ref]),
        evidence: found.evidence, requiredEvidence: ['events'] });
      if (verdict.verdict !== 'passed') throw new Error('exact capture:' + JSON.stringify(verdict));
      const missing = await ctx.call('events', { ...ctx.inputs.query, mobileFactId: 'aab-intentionally-missing-fact' });
      const rejected = await ctx.assert({ name: 'missing fact stays inconclusive', scope: 'device', condition: true,
        evidence: missing.evidence, requiredEvidence: ['events'] });
      if (missing.ok || missing.result.items.length || rejected.verdict !== 'inconclusive') throw new Error('missing fact accepted');
    };`;
    fs.writeFileSync(path.join(root, 'capture-script.js'), source);
    let state = await run('script', { operation: 'start', recordingDir: path.join(root, 'script-recording'), script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', source, target,
      inputs: { query, ref, item }, permissions: ['app.read', 'capture.read'], policy: { restartPolicy: 'none', timeoutMs: 30000 },
    } });
    assert.equal(state.ok, true); scriptId = state.operationId;
    let n = 0;
    while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
      write('script-' + n + '.json', state); assert(n++ < 40, 'script_wait_limit');
      state = await run('script', { operation: 'wait', operationId: scriptId, afterSequence: state.eventSequence, waitMs: 1000 });
    }
    write('script-terminal.json', state); assert.equal(state.status, 'completed', JSON.stringify(state));
    const scriptArchive = await run('evidence', { operation: 'export', namespace: 'script', operationId: scriptId,
      outputDir: path.join(root, 'script-archive'), includeRecordedPayloads: true });
    write('script-export.json', scriptArchive); assert.equal(scriptArchive.ok, true, JSON.stringify(scriptArchive));
    assert.deepEqual(scriptArchive.recordedPayloads.counts.assertions, { passed: 1, failed: 0, inconclusive: 1 });
    assert.equal(scriptArchive.recordedPayloads.counts.mobilePages, 2);
    assert.equal(scriptArchive.recordedPayloads.counts.boundMobileItems, 1);
    report.archives.push(scriptArchive); scriptId = null;
    const intent = await run('intent', { operation: 'start', goal: 'Observe current UI and retain one real SDK event', target,
      provider: 'native', recordingDir: path.join(root, 'intent-recording'), require: { ...query, streams: ['events'] } });
    write('intent-start.json', intent); intentId = intent.operationId; assert.equal(intent.ok, true, JSON.stringify(intent));
    assert.deepEqual(intent.capture.items, [item]); assert.deepEqual(intent.capture.refs, [ref]);
    const terminal = await run('intent', { operation: 'decide', operationId: intentId,
      decision: { decisionId: 'finish-capture', agentDecision: 'complete', reason: 'Requested SDK fact retrieved unchanged' } });
    write('intent-terminal.json', terminal); assert.equal(terminal.status, 'completed');
    const intentArchive = await run('evidence', { operation: 'export', namespace: 'intent', operationId: intentId,
      outputDir: path.join(root, 'intent-archive'), includeRecordedPayloads: true });
    write('intent-export.json', intentArchive); assert.equal(intentArchive.ok, true, JSON.stringify(intentArchive));
    assert.equal(intentArchive.recordedPayloads.counts.boundMobileItems, 1);
    report.archives.push(intentArchive); intentId = null;
    report.source = { ref, item };
  } finally {
    if (scriptId) await run('script', { operation: 'cancel', operationId: scriptId });
    if (intentId) await run('intent', { operation: 'cancel', operationId: intentId });
    report.hostExit = await client.close(); write('report.json', report);
  }
  const unavailable = path.join(root, 'unavailable-store'); fs.writeFileSync(unavailable, 'not a directory');
  for (let pass = 1; pass <= 2; pass += 1) {
    const offline = open('offline-' + pass, { AI_APP_BRIDGE_FACT_STORE_DIR: unavailable, PATH: path.join(root, 'no-executables') });
    try {
      await offline.initialize();
      for (const archive of report.archives) {
        const moved = path.join(root, archive.namespace + '-moved');
        if (pass === 1) fs.cpSync(archive.archiveDir, moved, { recursive: true, errorOnExist: true, force: false });
        const verified = payloadOf(await offline.request('tools/call', { name: 'run', arguments: { command: 'evidence',
          arguments: { operation: 'verify', archiveDir: moved, manifestSha256: archive.manifestSha256 } } }));
        write(archive.namespace + '-offline-' + pass + '.json', verified);
        assert.equal(verified.ok, true, JSON.stringify(verified)); assert.equal(verified.integrity, 'verified');
        assert.deepEqual(verified.recordedPayloads, archive.recordedPayloads);
      }
    } finally { assert.deepEqual(await offline.close(), { code: 0, signal: null }); }
  }
  report.ok = true; report.finishedAtMs = Date.now(); report.offlineVerifierProcesses = 2;
  write('report.json', report);
  console.log(JSON.stringify({ ok: true, target, archives: report.archives.map(a => ({ namespace: a.namespace,
    operationId: a.operationId, counts: a.recordedPayloads.counts, manifestSha256: a.manifestSha256 })) }));
  return report;
}

if (require.main === module) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    assert(['--server', '--serial', '--package', '--out'].includes(key) && process.argv[i + 1] && !args[key], 'explicit_unique_arguments_required');
    args[key] = process.argv[i + 1];
  }
  main({ server: args['--server'], serial: args['--serial'], packageName: args['--package'], out: args['--out'] })
    .catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { main };
