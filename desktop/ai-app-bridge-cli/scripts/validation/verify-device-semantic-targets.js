#!/usr/bin/env node
'use strict';

// NotallyX settings fixture observed on OPPO: open Theme and cancel it without
// changing settings. Accepts an installed MCP entry; no checkout module loading.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main({ out, serverPath, serial, packageName }) {
  fs.mkdirSync(out);
  const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
  const target = { serial, packageName };
  const preferences = () => execFileSync('adb', ['-s', serial, 'exec-out', 'run-as', packageName, 'cat', `shared_prefs/${packageName}_preferences.xml`]);
  const before = preferences(); fs.writeFileSync(path.join(out, 'preferences-before.xml'), before);
  const device = { serial, model: execFileSync('adb', ['-s', serial, 'shell', 'getprop', 'ro.product.model'], { encoding: 'utf8' }).trim(),
    brand: execFileSync('adb', ['-s', serial, 'shell', 'getprop', 'ro.product.brand'], { encoding: 'utf8' }).trim() };
  write('device.json', device);
  // This is the user-authorized OPPO serial. Its current Android image reports
  // OnePlus as ro.product.brand, so brand alone is not a device identity.
  assert.equal(serial, 'b46093e6'); assert.equal(device.model, 'PKR110');
  const client = createMcpClient({ serverPath, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  let sequence = 0;
  const run = async (command, args) => {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const check = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const wait = text => run('wait-text', { ...target, provider: 'native', targetText: text, timeoutMs: 5000, intervalMs: 100 });
  const screenshot = async name => check(await run('screenshot', { ...target, outFile: path.join(out, `${name}.png`), feedback: 'off' }));
  const report = { ok: false, target, serverPath, controllerSha256: sha(fs.readFileSync(__filename)), cases: [] };
  try {
    await client.initialize();
    check(await wait('外观'));
    await screenshot('settings-before');
    let state = check(await run('intent', { operation: 'start', operationId: `semantic-${Date.now()}`, goal: 'Open the observed theme dialog, verify its foreground scope, then cancel it.', provider: 'native', target: { platform: 'android', ...target } }));
    const operationId = state.operationId;
    const decide = async (decisionId, action) => run('intent', { operation: 'decide', operationId,
      decision: { decisionId, basedOnRevision: state.revision, agentDecision: 'act', action } });
    state = check(await decide('open-theme', { provider: 'native', action: 'tap', selector: { text: '主题' } }));
    check(await wait('浅'));
    state = check(await run('intent', { operation: 'observe', operationId }));
    await screenshot('theme-dialog');
    const covered = await run('tap-text', { ...target, targetText: '外观', provider: 'native', feedback: 'off' });
    assert.equal(covered.error, 'target_not_found'); assert.equal(covered.dispatched, false);
    const hidden = await run('wait-text', { ...target, targetText: '外观', provider: 'native', timeoutMs: 500, intervalMs: 50 });
    assert.equal(hidden.error, 'deadline_exceeded'); assert.equal(hidden.dispatched, false);
    state = check(await decide('cancel-theme', { provider: 'native', action: 'tap', selector: { text: '取消' } }));
    check(await wait('外观'));
    state = check(await run('intent', { operation: 'decide', operationId,
      decision: { decisionId: 'done', basedOnRevision: state.revision, agentDecision: 'complete' } }));
    assert.equal(state.status, 'completed');
    const intentArchive = check(await run('evidence', { operation: 'export', namespace: 'intent', operationId, outputDir: path.join(out, 'intent-archive') }));
    report.cases.push({ name: 'intent-theme-cancel', operationId, status: state.status, coveredTargetError: covered.error, hiddenWaitError: hidden.error, archive: intentArchive });
    const steps = [
      ['tap-text', { targetText: '主题', provider: 'native' }, null],
      ['wait-text', { targetText: '浅', provider: 'native', timeoutMs: 5000, intervalMs: 100 }, null],
      ['tap-text', { targetText: '外观', provider: 'native' }, 'target_not_found'],
      ['wait-text', { targetText: '外观', provider: 'native', timeoutMs: 500, intervalMs: 50 }, 'deadline_exceeded'],
      ['tap-text', { targetText: '取消', provider: 'native' }, null],
      ['wait-text', { targetText: '外观', provider: 'native', timeoutMs: 5000, intervalMs: 100 }, null],
    ];
    for (const language of ['javascript', 'python']) {
      const source = language === 'javascript'
        ? `module.exports.main = async ctx => { const steps = ${JSON.stringify(steps)}; for (const [command,args,error] of steps) { const r = await ctx.call(command,args); if (error ? r.ok || r.error !== error || r.dispatched !== false : !r.ok) throw new Error(JSON.stringify(r)); } return {checks:steps.length}; };`
        : `import json\ndef main(ctx):\n    steps = json.loads(${JSON.stringify(JSON.stringify(steps))})\n    for command, args, error in steps:\n        r = ctx.call(command, args)\n        if (r["ok"] or r["error"] != error or r["dispatched"] is not False) if error else not r["ok"]:\n            raise Exception(str(r))\n    return {"checks": len(steps)}\n`;
      const script = { schemaVersion: 'aab.code-script/v1', language, source, target: { platform: 'android', ...target }, policy: { timeoutMs: 30000 } };
      write(`${language}-script.json`, script);
      const startedAt = Date.now();
      let result = check(await run('script', { operation: 'start', script }));
      const scriptId = result.operationId;
      while (!['completed', 'failed', 'cancelled'].includes(result.status)) result = await run('script', { operation: 'wait', operationId: scriptId, afterSequence: result.eventSequence, waitMs: 1000 });
      result = await run('script', { operation: 'status', operationId: scriptId });
      assert.equal(result.status, 'completed', JSON.stringify(result));
      const actions = result.events.filter(event => event.type === 'action_receipt');
      assert.equal(actions.length, 3);
      assert.equal(actions.filter(event => event.payloadSummary.dispatched === true).length, 2);
      assert.equal(actions.filter(event => event.payloadSummary.dispatched === false).length, 1);
      check(await wait('外观'));
      const archive = check(await run('evidence', { operation: 'export', namespace: 'script', operationId: scriptId, outputDir: path.join(out, `${language}-archive`) }));
      report.cases.push({ name: language, operationId: scriptId, status: result.status, elapsedMs: Date.now() - startedAt,
        checks: steps.length, actionAttempts: actions.length, dispatched: 2, rejected: 1, archive });
    }
    await screenshot('settings-after');
    const after = preferences(); fs.writeFileSync(path.join(out, 'preferences-after.xml'), after);
    assert.equal(sha(after), sha(before), 'Theme cancellation must preserve the actual preference file.');
    report.preferences = { beforeSha256: sha(before), afterSha256: sha(after), equal: true };
    report.ok = true;
  } finally {
    report.mcpExit = await client.close({ stdinEof: true });
    write('report.json', report);
  }
  return report;
}

if (require.main === module) main({ out: path.resolve(process.argv[2]), serverPath: path.resolve(process.argv[3]), serial: process.argv[4], packageName: process.argv[5] })
  .then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
  .catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { main };
