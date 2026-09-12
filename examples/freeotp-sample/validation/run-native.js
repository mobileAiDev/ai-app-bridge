'use strict';

// One physical run through the public MCP. Inputs are explicit; existing output
// directories are refused and a failed run is archived without an action retry.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const { createMcpClient, payloadOf } = require(path.join(root, 'desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  assert(['javascript', 'python'].includes(config.language), 'explicit language must be javascript or python');
  assert.equal(config.target.platform, 'ios');
  for (const key of ['deviceId', 'bundleId', 'wdaRunnerBundleId']) assert(config.target[key], key);
  assert(config.inputs.wdaSessionId, 'explicit initial WDA session');
  assert.equal(config.target.wdaSessionId, undefined, 'session lifecycle belongs to the Script');
  const out = path.resolve(config.outputDir);
  fs.mkdirSync(out, { recursive: false });
  write(path.join(out, 'config.json'), config);
  const source = path.resolve(config.sourcePath), frozenSource = path.join(out, config.language === 'python' ? 'script.py' : 'script.js');
  fs.copyFileSync(source, frozenSource, fs.constants.COPYFILE_EXCL);
  const sourceSha256 = hash(frozenSource);
  const spec = { schemaVersion: 'aab.code-script/v1', name: config.name, language: config.language, sourcePath: frozenSource,
    target: config.target, inputs: { ...config.inputs, outputDir: path.join(out, 'device') },
    permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 600000, restartPolicy: 'none' } };
  write(path.join(out, 'spec.json'), spec);
  const client = createMcpClient({ serverPath: path.join(root, 'desktop/ai-app-bridge-cli/bin/mcp-server.js'),
    transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'), timeoutMs: 90000 });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  let page = 0, cursor = 0, lastPrintedAtMs = 0;
  const events = [];
  function collect(state) {
    write(path.join(out, `execution-${++page}.json`), state);
    assert.equal(state.ok, true, JSON.stringify(state));
    for (const event of state.events || []) {
      if (event.sequence <= cursor) { assert.deepEqual(events[event.sequence - 1], event); continue; }
      assert.equal(event.sequence, cursor + 1);
      events.push(event); cursor = event.sequence;
    }
    if (Date.now() - lastPrintedAtMs > 15000 || state.status !== 'running') {
      lastPrintedAtMs = Date.now();
      console.log(JSON.stringify({ status: state.status, operationId: state.operationId,
        eventCount: events.length, lastEvent: events.at(-1)?.type, assertions: state.rollingSummary?.assertions }));
    }
  }
  try {
    await client.initialize();
    const startedAtMs = Date.now();
    let state = await run('script', { operation: 'start', script: spec, recordingDir: path.join(out, 'recording') });
    collect(state);
    const operationId = state.operationId;
    while (!['completed', 'failed', 'cancelled', 'interrupted', 'timed_out'].includes(state.status)) {
      assert(Date.now() - startedAtMs < 660000, 'controller time budget exceeded');
      assert.equal(state.status.startsWith('paused') || state.status === 'waiting_for_agent', false, 'run needs intervention; no automatic decision');
      state = await run('script', { operation: 'wait', operationId, afterSequence: cursor, waitMs: 30000, limit: 500 });
      collect(state);
    }
    const durationMs = Date.now() - startedAtMs;
    write(path.join(out, 'events.json'), events);
    const archive = await run('evidence', { operation: 'export', namespace: 'script', operationId,
      outputDir: path.join(out, 'archive'), includeRecordedPayloads: true });
    write(path.join(out, 'export.json'), archive); assert.equal(archive.ok, true, JSON.stringify(archive));
    const verified = await run('evidence', { operation: 'verify', archiveDir: archive.archiveDir, manifestSha256: archive.manifestSha256 });
    write(path.join(out, 'verify.json'), verified); assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(hash(source), sourceSha256); assert.equal(hash(frozenSource), sourceSha256);
    const assertions = events.filter(event => event.type.startsWith('assertion_'))
      .map(({ name, verdict, reason, observationId }) => ({ name, verdict, reason, observationId }));
    const resultEnvelope = state.status === 'completed' ? await run('script', { operation: 'result', operationId }) : null;
    if (resultEnvelope) { assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true); }
    const result = resultEnvelope?.result;
    const report = { operationId, status: state.status, durationMs, sourceSha256, assertions, result,
      manifestSha256: archive.manifestSha256, failure: events.findLast(event => event.type === 'script_failed') };
    write(path.join(out, 'report.json'), report);
    console.log(JSON.stringify({ operationId, status: report.status, durationMs, sourceSha256,
      assertions, reportPath: path.join(out, 'report.json') }));
    assert.equal(state.status, config.expectedStatus || 'completed', JSON.stringify(report));
    if (state.status === 'completed') {
      assert.equal(result?.ok, true);
      assert(result.checks.length > 0 && result.checks.every(item => item.verdict === 'passed'));
      for (const artifact of result.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
    } else if (config.expectedFailedAssertion) {
      assert(assertions.some(item => item.name === config.expectedFailedAssertion && item.verdict === 'failed'));
      assert.equal(assertions.some(item => item.verdict === 'inconclusive'), false);
    }
  } finally { console.log(JSON.stringify({ mcpClosed: await client.close({ stdinEof: true }) })); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
