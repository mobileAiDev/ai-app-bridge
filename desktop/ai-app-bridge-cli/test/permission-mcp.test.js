'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { verifyPermissionContract, verifyPermissionShutdown } = require('../scripts/validation/verify-permission-contract');

test('public MCP executes permission Intent outcomes and Script fixture commands through real subprocesses', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-mcp-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const client = createMcpClient({ serverPath: path.join(__dirname, '../bin/mcp-server.js'), transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  t.after(() => client.close()); await client.initialize();
  const call = client => async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const report = await verifyPermissionContract({ out, run: call(client) });
  await client.close({ stdinEof: true });
  const restarted = createMcpClient({ serverPath: path.join(__dirname, '../bin/mcp-server.js'), transcriptPath: path.join(out, 'restarted-mcp.jsonl'), stderrPath: path.join(out, 'restarted-stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  t.after(() => restarted.close()); await restarted.initialize();
  await verifyPermissionShutdown({ out, run: call(restarted), operationId: report.shutdownOperationId });
});
