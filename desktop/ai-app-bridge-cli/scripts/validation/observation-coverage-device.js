#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main(serial, apk, destination) {
  assert.match(serial, /^emulator-\d+$/, 'Use an explicitly provisioned disposable emulator.');
  const out = path.resolve(destination); fs.mkdirSync(out);
  const root = path.resolve(__dirname, '../..');
  const adb = '/Users/macbook/Library/Android/sdk/platform-tools/adb';
  const packageName = 'io.github.mobileaidev.aiappbridge.sample', app = { serial, packageName };
  const client = createMcpClient({ serverPath: path.join(root, 'bin/mcp-server.js'), env: {
    ADB: adb, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
    AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership'),
  }, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.stderr') });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: {
    command, arguments: args, extract: null, output: { maxBytes: 262144 },
  } }));
  const write = (name, value) => fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
  const nodes = root => root ? [root, ...(root.children || []).flatMap(nodes)] : [];
  const report = { ok: false, serial, physicalDevicesTouched: false, checks: {},
    apkSha256: createHash('sha256').update(fs.readFileSync(apk)).digest('hex') };
  try {
    await client.initialize();
    const installed = await run('adb-exec', { serial, argv: ['install', '-r', path.resolve(apk)], timeoutMs: 120000 });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    const launched = await run('adb-exec', { serial, argv: ['shell', 'am', 'start', '-n', `${packageName}/.ObservationCoverageFixtureActivity`] });
    assert.equal(launched.ok, true, JSON.stringify(launched));
    const ready = await run('wait-text', { ...app, provider: 'uia', targetText: '观察就绪', timeoutMs: 30000 });
    assert.equal(ready.ok, true, JSON.stringify(ready));
    const snapshot = await run('tree', { ...app, compact: false }); write('partial-native', snapshot);
    const captured = snapshot.windows.flatMap(window => nodes(window.root));
    assert.equal(snapshot.nodeCount, captured.length, 'Each window tree is traversed only once.');
    assert.deepEqual(snapshot.root, snapshot.windows.find(window => window.activityDecor).root);
    assert.equal(new Set(captured.map(node => node.nodeId)).size, captured.length);
    assert.equal(snapshot.coverage.status, 'partial');
    assert.ok(snapshot.coverage.omittedChildren > 0); assert.ok(snapshot.coverage.truncatedTextNodes > 0);
    const long = captured.find(node => node.contentDescription === '长文本预览');
    assert.equal(long.text, 'x'.repeat(299)); assert.equal(long.textTruncated, true); assert.equal(long.textLength, 307);
    assert.equal(captured.some(node => node.text === '深层仍在加载'), false);
    report.checks.singleNativeTraversalAndCoverage = { capturedNodes: captured.length, legacyRootMatchesWindow: true, longTextLength: long.textLength };
    const positive = await run('wait-text', { ...app, provider: 'native', targetText: '观察就绪', timeoutMs: 3000 });
    assert.equal(positive.ok, true); assert.equal(positive.matched.coverage.status, 'partial');
    const strict = await run('wait-text', { ...app, provider: 'native', absentText: ['深层仍在加载'], timeoutMs: 700, intervalMs: 100 }); write('absence-complete', strict);
    assert.equal(strict.ok, false); assert.equal(strict.lastCheck.absenceProven, false);
    const partial = await run('wait-text', { ...app, provider: 'native', absentText: ['深层仍在加载'], absenceScope: 'observed', timeoutMs: 3000 }); write('absence-observed', partial);
    assert.equal(partial.ok, true); assert.equal(partial.matched.coverage.status, 'partial'); assert.equal(partial.matched.absenceScope, 'observed');
    const actual = await run('wait-text', { ...app, provider: 'uia', targetText: '深层仍在加载', timeoutMs: 5000 });
    assert.equal(actual.ok, true, JSON.stringify(actual));
    report.checks.partialObservationDoesNotProveAbsence = true;
    const intent = await run('intent', { operation: 'start', target: { platform: 'android', serial, packageName, adb }, provider: 'native', goal: 'Observe coverage facts' });
    assert.equal(intent.status, 'waiting_for_decision'); assert.equal(intent.summary.coverage.source.status, 'partial');
    write('intent-summary', intent);
    await run('intent', { operation: 'decide', operationId: intent.operationId, decision: { decisionId: randomUUID(), basedOnRevision: intent.revision, agentDecision: 'complete' } });
    report.checks.intentRetainsSourceCoverage = true;
    const cleaned = await run('tap-native', { ...app, selector: { text: '清理部分观察', clickable: true }, feedback: 'off' });
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
    const complete = await run('wait-text', { ...app, provider: 'native', targetText: '完整观察就绪', absentText: ['深层仍在加载'], timeoutMs: 3000 }); write('absence-after-cleanup', complete);
    assert.equal(complete.ok, true); assert.equal(complete.matched.coverage.status, 'complete');
    report.checks.completeObservationCanProveAbsence = true;
    report.ok = true;
  } catch (error) { report.error = error.message; throw error; }
  finally { await client.close(); write('report', report); }
  process.stdout.write(JSON.stringify(report) + '\n');
}
if (require.main === module) main(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
