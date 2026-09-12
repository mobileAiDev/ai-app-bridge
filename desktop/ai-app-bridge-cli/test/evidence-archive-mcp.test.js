'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { createFactStore } = require('../bin/fact-store');
const { createSegmentedEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createUiaRuntimeFixture } = require('../test-support/uia-runtime-fixture');

const MCP_SERVER = path.join(__dirname, '..', 'bin', 'mcp-server.js');
const OPERATION_ID = 'archive-mcp-intent';

test('public Script recording exports actual child calls and all assertion verdicts for offline verification', async t => {
  const root = temporaryDirectory(t);
  const client = await openMcp(t, path.join(root, 'facts'));
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript',
    target: { platform: 'android', serial: 'no-device', packageName: 'offline.fixture' }, source: `
      exports.main = async ctx => {
        await ctx.call('page-summary', { provider: 'native', rawTreeId: 'fixture-tree', rawTree: { nodes: [] } });
        await ctx.assert({ name: 'positive', scope: 'code', condition: true });
        await ctx.assert({ name: 'negative', scope: 'code', condition: false });
        await ctx.assert({ name: 'missing', scope: 'device', condition: true });
      };
    ` };
  const started = await client.call('run', { command: 'script', arguments: { operation: 'start', script,
    recordingDir: path.join(root, 'recording') } });
  assert.equal(started.ok, true, JSON.stringify(started));
  let state = started;
  for (let i = 0; i < 20 && !['completed', 'failed'].includes(state.status); i += 1) {
    state = await client.call('run', { command: 'script', arguments: { operation: 'wait',
      operationId: started.operationId, afterSequence: state.eventSequence, waitMs: 1000 } });
  }
  assert.equal(state.status, 'completed', JSON.stringify(state));
  const exported = await client.evidence({ operation: 'export', namespace: 'script', operationId: started.operationId,
    outputDir: path.join(root, 'archive'), includeRecordedPayloads: true });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.recordedPayloads.counts.scriptCalls, 1);
  assert.deepEqual(exported.recordedPayloads.counts.assertions, { passed: 1, failed: 1, inconclusive: 1 });
  await client.close();
  const moved = path.join(root, 'moved');
  fs.renameSync(exported.archiveDir, moved);
  fs.rmSync(path.join(root, 'recording'), { recursive: true });
  const unavailable = path.join(root, 'unavailable-store'); fs.writeFileSync(unavailable, 'not a directory');
  const offline = await openMcp(t, unavailable);
  const verified = await offline.evidence({ operation: 'verify', archiveDir: moved, manifestSha256: exported.manifestSha256 });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.integrity, 'verified');
  assert.deepEqual(verified.recordedPayloads, exported.recordedPayloads);
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('public Script agent decisions preserve JSON values and retry structured answers by content', async t => {
  const root = temporaryDirectory(t);
  const client = await openMcp(t, path.join(root, 'facts'));
  const answers = [{ verdict: 'passed', observedSettings: { theme: 'dark', color: 'system' } },
    ['one', 2, null], null, false, 0, ''];
  const started = await client.call('run', { command: 'script', arguments: { operation: 'start', script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript',
    target: { platform: 'android', serial: 'no-device', packageName: 'offline.fixture' }, source: `
      exports.main = async ctx => {
        const answers = [];
        for (let index = 0; index < ${answers.length}; index++) {
          answers.push(await ctx.askAgent({ question: 'Return a JSON value', context: { index } }));
        }
        return { answers };
      };
    `,
  } } });
  assert.equal(started.ok, true, JSON.stringify(started));
  const script = args => client.call('run', { command: 'script', arguments: { operationId: started.operationId, ...args } });
  let state = started;
  const deadline = Date.now() + 20000;
  for (let index = 0; index < answers.length; index++) {
    let question;
    while (!(question = state.events.find(event => event.type === 'agent_question_created' && event.request.context.index === index))) {
      assert(Date.now() < deadline, JSON.stringify(state));
      assert(!['completed', 'failed', 'cancelled'].includes(state.status), JSON.stringify(state));
      state = await script({ operation: 'wait', afterSequence: state.eventSequence, waitMs: 1000 });
    }
    const request = { operation: 'decide', requestId: question.requestId, revision: question.revision };
    if (index === 0) {
      const missing = await script(request);
      assert.equal(missing.ok, false);
      assert.equal(missing.field, 'decision');
    }
    const decided = await script({ ...request, decision: answers[index] });
    assert.equal(decided.ok, true, JSON.stringify(decided));
    if (index === 0) {
      const again = await script({ ...request, decision: {
        observedSettings: { color: 'system', theme: 'dark' }, verdict: 'passed',
      } });
      assert.equal(again.ok, true, JSON.stringify(again));
      const conflict = await script({ ...request, decision: { ...answers[index], verdict: 'failed' } });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.field, 'decision');
    }
    state = await script({ operation: 'status' });
  }
  while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
    assert(Date.now() < deadline, JSON.stringify(state));
    state = await script({ operation: 'wait', afterSequence: state.eventSequence, waitMs: 1000 });
  }
  state = await script({ operation: 'status' });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  assert.deepEqual((await script({ operation: 'result' })).result, { answers });
  assert.equal(state.events.filter(event => event.type === 'agent_decision').length, answers.length);
});

test('public UIA reads honor maxDepth and reject limits outside the actual compaction range', async t => {
  const root = temporaryDirectory(t);
  const client = await openMcp(t, path.join(root, 'facts'));
  const xml = '<hierarchy><node text="Root" bounds="[0,0][100,100]"><node text="Child" bounds="[0,0][20,20]"/></node></hierarchy>';
  const uia = await createUiaRuntimeFixture({ directory: path.join(root, 'uia'), serial: 'depth-contract-device', xml });
  t.after(() => uia.close());
  const log = path.join(uia.directory, 'adb.jsonl');
  const args = { serial: uia.serial, adb: uia.adb, compact: true, maxNodes: 1000 };
  for (const [maxDepth, expected] of [[0, ['Root']], [1, ['Root', 'Child']]]) {
    const tree = await client.call('run', { command: 'uia-tree', arguments: { ...args, maxDepth } });
    assert.equal(tree.ok, true, JSON.stringify(tree));
    assert.deepEqual(tree.nodes.map(node => node.text), expected);
    assert.equal(tree.options.maxDepth, maxDepth);
  }
  const before = fs.readFileSync(log, 'utf8');
  for (const invalid of [{ maxDepth: 201 }, { maxNodes: 1001 }, { maxNodes: 0 }]) {
    const result = await client.call('run', { command: 'uia-tree', arguments: { ...args, ...invalid } });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.dispatched, false);
    assert.equal(result.field, Object.keys(invalid)[0]);
  }
  assert.equal(fs.readFileSync(log, 'utf8'), before, 'invalid limits must not contact ADB');
});

function temporaryDirectory(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-archive-mcp-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function openMcp(t, factStoreDirectory) {
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: {
      ...process.env,
      AI_APP_BRIDGE_MCP_SURFACE: 'compact',
      AI_APP_BRIDGE_FACT_STORE_DIR: factStoreDirectory,
      AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  let stderr = '';
  let ended = false;
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (error) {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        continue;
      }
      const request = pending.get(frame.id);
      if (!request) continue;
      pending.delete(frame.id);
      if (frame.error) request.reject(new Error(JSON.stringify(frame.error)));
      else request.resolve(frame.result);
    }
  });
  const stopped = new Promise((resolve) => child.once('close', (code, signal) => {
    ended = true;
    for (const request of pending.values()) {
      request.reject(new Error(`MCP closed (${code}/${signal}): ${stderr}`));
    }
    pending.clear();
    resolve({ code, signal });
  }));
  child.once('error', (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  async function request(method, params) {
    assert.equal(ended, false, 'MCP must still be running');
    const id = ++sequence;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out: ${stderr}`));
        }, 10_000);
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(name, args) {
    const result = await request('tools/call', { name, arguments: args });
    assert.equal(result.content[0].type, 'text');
    const payload = JSON.parse(result.content[0].text);
    assert.equal(Boolean(result.isError), payload.ok === false);
    return payload;
  }

  async function close() {
    if (!ended) child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    let exit;
    try {
      exit = await stopped;
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  }

  t.after(close);
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'evidence-archive-mcp-test', version: '1' },
  });
  return { call, close, evidence: (args) => call('run', { command: 'evidence', arguments: args }) };
}

async function seedEvidence(directory) {
  const facts = createFactStore({ directory, profile: '64mb' });
  try {
    const adapter = createSegmentedEvidenceAdapter(facts);
    const intent = createIntentEvidenceStore({ adapter });
    const observation = {
      operationId: OPERATION_ID,
      evidenceId: 'intent-observation-1',
      revision: 1,
      target: { platform: 'android', serial: 'test-serial', packageName: 'com.example.test' },
      provider: 'native',
      capturedAtMs: 1_700_000_000_000,
      rawTreeId: 'intent-raw-tree-1',
      rawTree: { root: { id: 'home', text: 'Archive source', children: [] } },
    };
    assert.equal((await intent.persist('observation', observation)).ok, true);
    assert.equal((await intent.persist('summary', {
      operationId: OPERATION_ID,
      evidenceId: 'intent-summary-1',
      revision: 1,
      rawTreeId: observation.rawTreeId,
      summary: { text: 'Archive source' },
    })).ok, true);
    assert.equal((await intent.persist('observation', {
      ...observation,
      evidenceId: 'other-operation-observation',
      operationId: 'other-operation',
    })).ok, true);
    const script = createScriptEvidenceStore({ adapter });
    assert.equal((await script.persist('checkpoint', {
      operationId: 'archive-mcp-script',
      evidenceId: 'script-checkpoint-1',
      revision: 1,
      stepId: 'start',
    })).ok, true);
    await facts.drain();
  } finally {
    facts.close();
  }
}

test('evidence MCP discovery and invalid requests do not initialize FactStore', async (t) => {
  const root = temporaryDirectory(t);
  const blockedDirectory = path.join(root, 'not-a-directory');
  fs.writeFileSync(blockedDirectory, 'FactStore must not be opened here');
  const mcp = await openMcp(t, blockedDirectory);

  const capabilities = await mcp.call('capabilities', { domain: 'evidence', includeOptions: true });
  const command = capabilities.domains.evidence.find((item) => item.command === 'evidence');
  assert.ok(command);
  assert.equal(command.targetKind, 'operation');
  assert.deepEqual(command.options, ['operation', 'namespace', 'operationId', 'outputDir', 'includeRecordedPayloads', 'archiveDir', 'manifestSha256']);
  assert.equal((await mcp.call('capabilities', { command: 'evidence' })).ok, true);

  for (const [args, field] of [
    [{ operation: 'export', namespace: 'intent', outputDir: path.join(root, 'missing-id') }, 'operationId'],
    [{ operation: 'export', namespace: 'unknown', operationId: 'op', outputDir: path.join(root, 'invalid-namespace') }, 'namespace'],
    [{ operation: 'verify', archiveDir: root }, 'manifestSha256'],
    [{ operation: 'verify', archiveDir: root, manifestSha256: 'ABCDEF'.repeat(10) }, 'manifestSha256'],
    [{ operation: 'verify', archiveDir: root, manifestSha256: 'A'.repeat(64) }, 'manifestSha256'],
  ]) {
    const result = await mcp.evidence(args);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.error, Object.hasOwn(args, field) ? 'invalid_argument' : 'missing_argument');
    assert.equal(result.field, field);
  }
  const unknown = await mcp.evidence({ operation: 'erase', namespace: 'intent', operationId: 'op' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'invalid_argument');
  assert.equal(unknown.field, 'operation');
  assert.equal(fs.readFileSync(blockedDirectory, 'utf8'), 'FactStore must not be opened here');
  assert.deepEqual(fs.readdirSync(root), ['not-a-directory']);
  await mcp.close();
});

test('evidence MCP exports durable records and a new process verifies without FactStore', async (t) => {
  const root = temporaryDirectory(t);
  const storeDirectory = path.join(root, 'facts');
  const archiveDir = path.join(root, 'intent-archive');
  await seedEvidence(storeDirectory);
  const exporter = await openMcp(t, storeDirectory);
  const exported = await exporter.evidence({
    operation: 'export', namespace: 'intent', operationId: OPERATION_ID, outputDir: archiveDir,
  });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.archiveDir, archiveDir);
  assert.equal(exported.manifestPath, path.join(archiveDir, 'manifest.json'));
  assert.equal(exported.namespace, 'intent');
  assert.equal(exported.operationId, OPERATION_ID);
  assert.equal(exported.recordCount, 2);
  assert.match(exported.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(exported.manifestSha256, sha256(exported.manifestPath));
  assert.equal(exported.coverage.scope, 'retained-host-records');
  assert.equal(exported.coverage.priorHistoryComplete, 'unknown');
  assert.equal(exported.coverage.externalPayloads, 'not-included');
  const recordsPath = path.join(archiveDir, 'records.json');
  const records = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
  assert.deepEqual(records.map((record) => record.payload.kind), ['observation', 'summary']);
  assert.deepEqual(records.map((record) => record.globalSeq), [1, 2]);
  assert.ok(records.every((record) => record.targetKey === `evidence:intent:${OPERATION_ID}`));
  assert.equal(records[0].payload.rawTree.root.text, 'Archive source');

  const frozenFiles = [sha256(exported.manifestPath), sha256(recordsPath)];
  const duplicate = await exporter.evidence({
    operation: 'export', namespace: 'intent', operationId: OPERATION_ID, outputDir: archiveDir,
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'output_exists');
  assert.deepEqual([sha256(exported.manifestPath), sha256(recordsPath)], frozenFiles);

  const missingDir = path.join(root, 'missing-operation');
  const missing = await exporter.evidence({
    operation: 'export', namespace: 'intent', operationId: 'missing-operation', outputDir: missingDir,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'operation_not_found');
  assert.equal(fs.existsSync(missingDir), false);

  const script = await exporter.evidence({
    operation: 'export', namespace: 'script', operationId: 'archive-mcp-script', outputDir: path.join(root, 'script-archive'),
  });
  assert.equal(script.ok, true, JSON.stringify(script));
  assert.equal(script.namespace, 'script');
  assert.equal(script.recordCount, 1);
  await exporter.close();

  const blockedDirectory = path.join(root, 'no-fact-store');
  fs.writeFileSync(blockedDirectory, 'offline verification must not open this');
  const verifier = await openMcp(t, blockedDirectory);
  const verifyArgs = { operation: 'verify', archiveDir, manifestSha256: exported.manifestSha256 };
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const verified = await verifier.evidence(verifyArgs);
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.integrity, 'verified');
    assert.equal(verified.manifestSha256, exported.manifestSha256);
    assert.equal(verified.operationId, OPERATION_ID);
    assert.equal(verified.namespace, 'intent');
    assert.equal(verified.recordCount, 2);
    assert.deepEqual(verified.coverage, exported.coverage);
    assert.deepEqual([sha256(exported.manifestPath), sha256(recordsPath)], frozenFiles);
  }
  const verifiedScript = await verifier.evidence({
    operation: 'verify', archiveDir: script.archiveDir, manifestSha256: script.manifestSha256,
  });
  assert.equal(verifiedScript.ok, true);
  assert.equal(verifiedScript.namespace, 'script');
  assert.equal(fs.readFileSync(blockedDirectory, 'utf8'), 'offline verification must not open this');

  const wrongHash = await verifier.evidence({ ...verifyArgs, manifestSha256: '0'.repeat(64) });
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.error, 'manifest_checksum_mismatch');

  records[0].payload.rawTree.root.text = 'Tampered after export';
  fs.writeFileSync(recordsPath, JSON.stringify(records));
  const tamperedRecords = await verifier.evidence(verifyArgs);
  assert.equal(tamperedRecords.ok, false);
  assert.equal(typeof tamperedRecords.error, 'string');

  fs.appendFileSync(exported.manifestPath, '\n');
  const tamperedManifest = await verifier.evidence(verifyArgs);
  assert.equal(tamperedManifest.ok, false);
  assert.equal(tamperedManifest.error, 'manifest_checksum_mismatch');
  await verifier.close();
});
