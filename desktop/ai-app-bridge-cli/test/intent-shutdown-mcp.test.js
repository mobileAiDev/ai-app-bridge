'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { startShutdownIntents, verifyIntentShutdown } = require('../scripts/validation/verify-intent-shutdown');

for (const stdinEof of [true, false]) {
  test(`runtime stop drains pending Intent RPCs before its MCP client closes by ${stdinEof ? 'EOF' : 'SIGTERM'}`, { timeout: 20000 }, async t => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-intent-shutdown-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const create = name => createMcpClient({ serverPath: path.join(__dirname, '../bin/mcp-server.js'),
      env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' },
      transcriptPath: path.join(out, `${name}.jsonl`), stderrPath: path.join(out, `${name}.log`) });
    const run = client => async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    const first = create('first'); t.after(() => first.close());
    await first.initialize();
    const operations = await startShutdownIntents({ out, run: run(first) });
    const closed = await first.close({ stdinEof });
    assert.deepEqual(closed, { code: 0, signal: null });
    const reopened = create('reopened'); t.after(() => reopened.close());
    await reopened.initialize();
    await verifyIntentShutdown({ out, run: run(reopened), operations });
  });
}
