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

const MCP_SERVER = path.join(__dirname, '..', 'bin', 'mcp-server.js');
const OPERATION_ID = 'archive-mcp-intent';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

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
      serial: 'test-serial',
      packageName: 'com.example.test',
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

  const capabilities = await mcp.call('capabilities', { domain: 'advanced', includeOptions: true });
  const command = capabilities.domains.advanced.find((item) => item.command === 'evidence');
  assert.ok(command);
  assert.equal(command.targetKind, 'none');
  assert.deepEqual(command.options, ['operation', 'namespace', 'operationId', 'outputDir', 'archiveDir', 'manifestSha256']);
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
    assert.equal(result.error, 'invalid_argument');
    assert.equal(result.field, field);
  }
  const unknown = await mcp.evidence({ operation: 'erase', namespace: 'intent', operationId: 'op' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'invalid_operation');
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
