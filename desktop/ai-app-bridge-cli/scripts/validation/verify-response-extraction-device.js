#!/usr/bin/env node
'use strict';

// Compare extraction with the SAME retained response, never a second device
// query. Requires a successful android-sample-capture-loop report.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createMcpClient, replyOf } = require('./mcp-jsonrpc-client');

function uiProjection(ctx) {
  const r = ctx.inputs.response;
  const nodes = [];
  const fields = ['nodeId', 'className', 'text', 'contentDescription', 'resourceName', 'bounds',
    'visible', 'enabled', 'clickable', 'longClickable', 'editable', 'checkable', 'checked',
    'selected', 'focused', 'focusable', 'scrollable'];
  function visit(node) {
    if (node.text || node.contentDescription || node.clickable || node.editable) {
      nodes.push(Object.fromEntries(fields.filter(key => Object.hasOwn(node, key)).map(key => [key, node[key]])));
    }
    for (const child of node.children || []) visit(child);
  }
  visit(r.root);
  return { activity: r.activity, updatedAtMs: r.updatedAtMs, foregroundWindowId: r.foregroundWindowId,
    windowCount: r.windowCount, nodeCount: r.nodeCount, nodes };
}

function networkProjection(ctx) {
  const fields = ['id', 'type', 'source', 'timestampMs', 'actionId', 'method', 'url', 'statusCode', 'durationMs', 'error'];
  return ctx.inputs.response.items.map(item => Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])));
}

function logsProjection(ctx) {
  const fields = ['id', 'type', 'source', 'timestampMs', 'actionId', 'level', 'tag', 'message', 'data'];
  return ctx.inputs.response.items.map(item => Object.fromEntries(fields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])));
}

async function main(reportPath, output) {
  const flow = JSON.parse(fs.readFileSync(reportPath));
  assert.equal(flow.status, 'passed');
  const out = path.resolve(output);
  fs.mkdirSync(out); // Never overwrite an earlier experiment.
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const report = { ok: false, target: flow.target, epoch: flow.beforeEpoch, measurements: [],
    sourceFlow: { path: path.resolve(reportPath), sha256: createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex') },
    nonNullExtractCalls: 0, refReads: 0, budgetOverflows: 0, deviceQueries: 0, captureSpeedClaim: false };
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../../bin/mcp-server.js'),
    transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.stderr'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes') } });
  const run = async (command, args, extract = null) => replyOf(await client.request('tools/call', {
    name: 'run', arguments: { command, arguments: args, extract, output: { maxBytes: 262144 } },
  }));
  try {
    await client.initialize();
    const status = await run('status', { ...flow.target, feedback: 'off' });
    assert.equal(status.execution.ok, true);
    assert.equal(status.value.debugBridge.runtimeEpoch, flow.beforeEpoch, 'the original flow epoch must still be live');
    assert.equal(status.value.debugBridge.version, require('../../package.json').version);
    report.sdk = status.value.debugBridge;
    report.runtime = (await run('runtime', { operation: 'status' })).value;
    const window = { ...flow.target, view: 'decision-window', runtimeEpoch: flow.beforeEpoch,
      sinceMs: flow.results.deviceSinceMs, limit: 200, feedback: 'off' };
    for (const [command, args, project] of [
      ['tree', { ...flow.target, feedback: 'off' }, uiProjection],
      ['network', window, networkProjection],
      ['logs', window, logsProjection],
    ]) {
      const extract = { mode: 'script', language: 'javascript', source: `module.exports.main = ${project.toString()};` };
      const extracted = await run(command, args, extract);
      report.deviceQueries++; report.nonNullExtractCalls++;
      write(`${command}-extract.json`, extracted);
      assert.equal(extracted.execution.ok, true, JSON.stringify(extracted));
      assert.equal(extracted.extraction.status, 'succeeded', JSON.stringify(extracted));
      assert.equal(extracted.control.source.persisted, true);
      const ref = extracted.control.source.ref;
      const original = await run('response', { operation: 'read', ref });
      report.refReads++;
      write(`${command}-original.json`, original);
      assert.equal(original.execution.ok, true, JSON.stringify(original));
      assert.equal(original.delivery.status, 'inline');
      assert.deepEqual(original.control.source.ref, ref);
      assert.deepEqual(extracted.value, project({ inputs: { response: original.value } }));
      // Independent business assertions apply to both forms. A successful
      // extraction or Script lifecycle by itself is never a passing verdict.
      if (command === 'tree') {
        assert.equal(original.value.windowCount, 1, 'this scenario expects a single sample window');
        assert.equal(original.value.activity, 'io.github.mobileaidev.aiappbridge.sample.debugbridge.DebugBridgeNativeTestActivity');
        assert(extracted.value.nodes.some(node => node.text === 'OkHttp auto capture: HTTP 200'));
        assert(extracted.value.nodes.some(node => node.text === 'Native Increment' && node.enabled === true));
      } else {
        for (const control of [original.control, extracted.control]) {
          assert.equal(control.runtimeEpoch, flow.beforeEpoch);
          assert.equal(control.targetKey, flow.target.packageName);
          assert.equal(control.window.sinceMs, flow.results.deviceSinceMs);
          assert.equal(control.hasMore, false, 'the full requested window must fit');
          assert.deepEqual(control.coverage, { status: 'complete', gap: false, committed: true });
        }
        if (command === 'network') {
          for (const items of [original.value.items, extracted.value]) {
            assert(items.some(item => item.url === flow.expectedNetworkUrl && item.source === 'okhttp-auto'
              && item.method === 'GET' && item.statusCode === 200 && item.error == null));
          }
        } else {
          for (const items of [original.value.items, extracted.value]) {
            assert(items.some(item => item.tag === 'NativeBridgeTest' && item.message === 'native counter incremented'
              && item.timestampMs >= flow.results.deviceSinceMs));
          }
        }
      }
      report.measurements.push({ command, source: extracted.control.source, originalValueBytes: Buffer.byteLength(JSON.stringify(original.value)),
        extractedValueBytes: Buffer.byteLength(JSON.stringify(extracted.value)), extractedReplyBytes: Buffer.byteLength(JSON.stringify(extracted)),
        originalReadReplyBytes: Buffer.byteLength(JSON.stringify(original)), assertions: 'passed' });
    }
    report.ok = true;
  } finally { write('report.json', report); await client.close(); }
  return report;
}

if (require.main === module) main(process.argv[2], process.argv[3]).then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
