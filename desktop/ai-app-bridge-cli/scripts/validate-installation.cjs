'use strict';

// Validates an actual tarball in a newly created directory on this machine.
// Never publishes, operates a device, or reuses the workspace node_modules.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMcpClient, payloadOf } = require('./validation/mcp-jsonrpc-client');

const tarball = path.resolve(process.argv[2] || '');
const evidenceDir = path.resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3]) throw new Error('usage: validate-installation.cjs <tarball> <evidence-directory>');
fs.mkdirSync(evidenceDir, { recursive: true });
const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-install-rc-'));
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  tarball, tarballSha256: crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'), installDir, checks: {} };
const save = () => fs.writeFileSync(path.join(evidenceDir, 'installation-result.json'), `${JSON.stringify(report, null, 2)}\n`);
save();

function npmInstall() {
  fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'aab-clean-directory-check', version: '1.0.0', private: true }));
  const args = ['install', '--no-audit', '--no-fund', '--foreground-scripts', tarball];
  report.installCommand = ['npm', ...args];
  const installed = spawnSync('npm', args, { cwd: installDir, encoding: 'utf8', timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidenceDir, 'npm-install.log'), `${installed.stdout || ''}${installed.stderr || ''}`);
  assert.equal(installed.status, 0, installed.error?.message || installed.stderr);
  const buildLog = `${installed.stdout || ''}${installed.stderr || ''}`;
  assert.match(buildLog, /FactStore prebuild /);
  assert.doesNotMatch(buildLog, /node-gyp rebuild|gyp info/);
  report.checks.npmInstall = { exitCode: installed.status, lifecycleScriptsEnabled: true, nativePrebuildLoaded: true };
}

function inspectPackage(packageRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, require('../package.json').version);
  const forbidden = [];
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/^(fake-|p9-)/.test(entry.name) || entry.name === 'intent-device-adapter.js') forbidden.push(file);
  } };
  walk(path.join(packageRoot, 'bin'));
  assert.deepEqual(forbidden, []);
  assert.equal(typeof require(path.join(packageRoot, 'bin/intent/intent-entry')).handle, 'function');
  report.checks.packageContents = { version: pkg.version, forbiddenCount: forbidden.length, intentEntryLoadsWithoutTestAdapter: true };
}

function nativePersistence(packageRoot) {
  const { SegmentedFactStoreAdapter } = require(path.join(packageRoot, 'bin/segmented-fact-store'));
  const options = { directory: path.join(installDir, 'native-store'), profile: '64mb', segmentSize: 4096, budgetBytes: 98304, partitionQuotas: Array(8).fill(8192) };
  const first = new SegmentedFactStoreAdapter(options);
  assert.equal(first.engine.constructor.name, 'NativeSegmentEngine');
  const payload = { kind: 'installation-validation', retained: 'native-close-open-read' };
  const receipt = first.record({ partition: 'action', targetKey: 'local:installation', runtimeEpoch: 'validation-1', actionId: 'install-check',
    timestamps: { occurredAtMs: Date.now(), observedAtMs: Date.now() }, payload }, { durability: 'sync' });
  first.close();
  const second = new SegmentedFactStoreAdapter(options);
  const page = second.read({ targetKey: 'local:installation', partitions: ['action'], limit: 10 });
  assert.equal(page.ok, true);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0].payload, payload);
  second.close();
  const nativeRoot = path.dirname(require.resolve('@mobileaidev/segmented-fact-store-native', { paths: [packageRoot] }));
  const bindingPath = require(path.join(nativeRoot, 'binding-path')).resolveBinding().path;
  const bindingSha256 = crypto.createHash('sha256').update(fs.readFileSync(bindingPath)).digest('hex');
  report.checks.nativePersistence = { engine: 'NativeSegmentEngine', writeGlobalSeq: receipt.globalSeq, reopenedItems: page.items.length, bindingPath, bindingSha256 };
}

async function mcp(packageRoot) {
  const client = createMcpClient({ serverPath: path.join(packageRoot, 'bin/mcp-server.js'), cwd: installDir,
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(installDir, 'mcp-store'),
      AI_APP_BRIDGE_RUNTIME_HOME: path.join(installDir, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' },
    transcriptPath: path.join(evidenceDir, 'mcp.jsonl'), stderrPath: path.join(evidenceDir, 'mcp-stderr.log') });
  const run = async (command, args) => {
    const response = await client.request('tools/call', { name: 'run', arguments: { command, arguments: args, extract: null } });
    assert.notEqual(response.result.isError, true, JSON.stringify(response));
    return payloadOf(response);
  };
  try {
    await client.initialize();
    const list = await client.request('tools/list', {});
    const runTool = list.result.tools.find(item => item.name === 'run');
    assert(runTool.inputSchema.required.includes('extract'));
    const capabilities = payloadOf(await client.request('tools/call', { name: 'capabilities', arguments: {} }));
    report.checks.mcp = { toolNames: list.result.tools.map(item => item.name), capabilities };
    const start = await run('script', { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', permissions: [],
      source: 'module.exports.main=async(ctx)=>{const verdict=await ctx.assert({scope:"code",name:"arithmetic",condition:6*7===42});return {answer:42,verdict};};',
    } });
    assert.equal(start.ok, true, JSON.stringify(start));
    let done = start;
    const startedAt = Date.now();
    while (['running', 'finishing'].includes(done.status)) {
      assert(Date.now() - startedAt < 30000, 'script completion timeout');
      done = await run('script', { operation: 'wait', operationId: start.operationId, waitMs: 1000, afterSequence: done.eventSequence });
    }
    assert.equal(done.status, 'completed', JSON.stringify(done));
    const result = await run('script', { operation: 'result', operationId: start.operationId });
    assert.equal(result.persisted, true);
    assert.equal(result.result.answer, 42);
    assert.equal(result.result.verdict.verdict, 'passed');
    const full = await run('script', { operation: 'status', operationId: start.operationId, afterSequence: 0 });
    assert.equal(full.history.items.some(item => item.kind === 'call_started'), false);
    assert.equal(full.rollingSummary.assertionScopes.code.passed, 1);
    assert.equal(full.rollingSummary.assertionScopes.device.passed, 0);
    report.checks.script = { status: done.status, operationId: start.operationId, deviceCalls: 0,
      result: result.result, resultRef: result.resultRef, rollingSummary: full.rollingSummary };
  } finally { await client.close(); }
}

(async () => {
  npmInstall();
  const packageRoot = path.join(installDir, 'node_modules/@mobileaidev/ai-app-bridge');
  report.packageRoot = packageRoot;
  inspectPackage(packageRoot);
  nativePersistence(packageRoot);
  await mcp(packageRoot);
  report.status = 'passed'; report.completedAt = new Date().toISOString(); save();
  process.stdout.write(`${JSON.stringify({ status: report.status, installDir, tarballSha256: report.tarballSha256 })}\n`);
})().catch((error) => { report.status = 'failed'; report.error = error.stack || String(error); save(); console.error(error.message); process.exitCode = 1; });
