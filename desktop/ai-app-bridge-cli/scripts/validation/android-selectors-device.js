#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const { createOwnershipStore, schemaVersion } = require('../../bin/shared-kernel/device-ownership-store');

// Requires an explicitly provisioned disposable emulator. No physical device
// is selected or modified. Keep public MCP transcripts and independent UI reads.
async function main(serial, apk, destination) {
  assert.match(serial, /^emulator-\d+$/);
  const out = path.resolve(destination); fs.mkdirSync(out);
  const root = path.resolve(__dirname, '../..'), adb = '/Users/macbook/Library/Android/sdk/platform-tools/adb';
  const packageName = 'io.github.mobileaidev.aiappbridge.sample';
  const env = { ADB: adb, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
    AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership') };
  const makeClient = (name, extra = {}) => createMcpClient({ serverPath: path.join(root, 'bin/mcp-server.js'), env: { ...env, ...extra },
    transcriptPath: path.join(out, `${name}.jsonl`), stderrPath: path.join(out, `${name}.stderr`) });
  const client = makeClient('mcp');
  const runWith = async (client, command, args) => payloadOf(await client.request('tools/call', { name: 'run',
    arguments: { command, arguments: args, extract: null, output: { maxBytes: 262144 } } }));
  const run = (command, args) => runWith(client, command, args);
  const write = (name, value) => fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
  const app = { serial, packageName }, target = { platform: 'android', ...app };
  const objects = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(objects)];
  const ui = async text => {
    const tree = await run('tree', { ...app, compact: false });
    assert.ok(objects(tree).some(node => typeof node.text === 'string' && node.text.startsWith(text)), `UI text missing: ${text}`);
    return tree;
  };
  const finish = state => run('intent', { operation: 'decide', operationId: state.operationId,
    decision: { decisionId: randomUUID(), basedOnRevision: state.revision, agentDecision: 'complete', reason: 'Fixture assertion completed.' } });
  const choose = state => run('intent', { operation: 'decide', operationId: state.operationId,
    decision: { decisionId: randomUUID(), basedOnRevision: state.revision, agentDecision: 'act',
      action: { provider: 'native', action: 'tap', selector: { contentDescription: '动态按钮' } } } });
  const report = { ok: false, serial, physicalDevicesTouched: false, checks: {} };
  try {
    await client.initialize();
    const installed = await run('adb-exec', { serial, argv: ['install', '-r', path.resolve(apk)], timeoutMs: 120000 });
    write('installed', installed); assert.equal(installed.ok, true, JSON.stringify(installed));
    const launched = await run('adb-exec', { serial, argv: ['shell', 'am', 'start', '-n', `${packageName}/.AgentChoiceFixtureActivity`] });
    assert.equal(launched.ok, true, JSON.stringify(launched));
    const ready = await run('wait-text', { ...app, provider: 'uia', targetText: '个人账户', timeoutMs: 30000 });
    assert.equal(ready.ok, true, JSON.stringify(ready));
    const initial = await ui('选择结果：尚未点击'); write('initial-tree', initial);
    const scope = { text: '企业账户', ancestor: { className: 'android.widget.LinearLayout', contentDescription: '协议行' } };
    for (const provider of ['native', 'uia']) {
      const ambiguous = await run(`tap-${provider}`, { ...app, selector: { text: '同意' }, feedback: 'off' });
      write(`${provider}-candidates`, ambiguous);
      assert.equal(ambiguous.dispatched, false); assert.equal(ambiguous.matched, 3);
      const selected = await run(`tap-${provider}`, { ...app, selector: { textContains: '同意', className: 'android.widget.Button',
        clickable: true, within: scope }, feedback: 'off' });
      write(`${provider}-scoped`, selected); assert.equal(selected.ok, true, JSON.stringify(selected));
      await ui('选择结果：按钮2');
      report.checks[`${provider}CompoundAndNeighborScope`] = true;
      const multipleScopes = await run(`tap-${provider}`, { ...app, selector: { text: '同意', className: 'android.widget.Button',
        contentDescription: '同意按钮1', within: { contentDescription: '协议行' } }, feedback: 'off' });
      assert.equal(multipleScopes.ok, true, JSON.stringify(multipleScopes)); await ui('选择结果：按钮1');
      report.checks[`${provider}MultipleScopesUniqueTarget`] = true;
    }
    const started = await run('intent', { operation: 'start', target, provider: 'native', goal: 'Click a changing View without mistaking it for a replacement.' });
    write('intent-start', started); assert.equal(started.status, 'waiting_for_decision');
    await new Promise(resolve => setTimeout(resolve, 800));
    const changed = await choose(started); write('intent-attribute-change', changed);
    assert.equal(changed.lastAction.dispatched, true);
    assert.ok(objects(changed).some(item => item.code === 'native_target_attributes_changed'), 'Attribute warning must reach public Intent reply');
    await ui('选择结果：动态按钮'); await finish(changed);
    report.checks.sameViewChangingLabel = true;
    const prior = await run('intent', { operation: 'start', target, provider: 'native', goal: 'Check replacement of an observed View.' });
    assert.equal(prior.status, 'waiting_for_decision');
    const replaced = await run('tap-native', { ...app, selector: { text: '替换动态按钮' }, feedback: 'off' });
    assert.equal(replaced.ok, true);
    const stale = await choose(prior); write('intent-replaced', stale);
    assert.equal(stale.lastAction.dispatched, false); assert.equal(stale.lastAction.error, 'native_target_replaced');
    await ui('选择结果：已替换，尚未点击'); await finish(stale);
    report.checks.replacementNeverReceivesOldAction = true;

    // The SDK result is real. Only the local archived-owner wrapper is a fixture,
    // so we can query the original receipt without crashing another process.
    const last = await run('tap-native', { ...app, selector: { contentDescription: '同意按钮1' }, feedback: 'off' });
    assert.equal(last.ok, true); const receipt = last.executionReceipt;
    assert.ok(receipt?.actionId && receipt.runtimeEpoch);
    const directory = path.join(out, 'query-ownership'); fs.mkdirSync(directory);
    const store = createOwnershipStore(directory);
    const pending = { id: randomUUID(), kind: 'native', actionId: receipt.actionId, runtimeEpoch: receipt.runtimeEpoch, target: { ...app, adb } };
    store.write(serial, { schemaVersion, serial, phase: 'unresolved', owner: null, pending, reservations: [], pendingAcknowledgements: [] });
    const saved = store.archive(serial), original = fs.readFileSync(saved.archivePath);
    const queryClient = makeClient('query-mcp', { AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: directory,
      AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'query-runtimes'), AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'query-facts') });
    try {
      await queryClient.initialize();
      const args = { serial, operation: 'reconcile-archive', archiveId: saved.archiveId, entryId: pending.id };
      const queried = await runWith(queryClient, 'device-ownership', args); write('original-query', queried);
      assert.equal(queried.result.settled, true); assert.equal(queried.result.actionId, receipt.actionId);
      assert.equal(queried.result.responseSha256, receipt.responseSha256);
      assert.equal((await runWith(queryClient, 'device-ownership', args)).cached, true);
      assert.deepEqual(fs.readFileSync(saved.archivePath), original);
      await ui('选择结果：按钮1');
      report.checks.originalNativeCompletionQuery = { deviceReceipt: true, localArchiveWrapper: 'controlled fixture', originalBytesPreserved: true, cachedSecondQuery: true, originalReceiptHashMatches: true };
    } finally { await queryClient.close(); }
    report.ok = true;
  } catch (error) { report.error = error.message; throw error; }
  finally { await client.close(); write('report', report); }
  process.stdout.write(JSON.stringify(report) + '\n');
}

if (require.main === module) main(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
