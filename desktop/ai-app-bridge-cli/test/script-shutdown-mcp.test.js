'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { startShutdownScripts, verifyScriptShutdown } = require('../scripts/validation/verify-script-shutdown');

for (const stdinEof of [true, false]) {
  test(`runtime stop settles JS/Python providers before its MCP client closes by ${stdinEof ? 'EOF' : 'SIGTERM'}`, async t => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-shutdown-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const create = name => createMcpClient({ serverPath: path.join(__dirname, '../bin/mcp-server.js'),
      env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' },
      transcriptPath: path.join(out, `${name}.jsonl`), stderrPath: path.join(out, `${name}.log`) });
    const run = client => async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    const first = create('first'); t.after(() => first.close());
    await first.initialize();
    const operations = await startShutdownScripts({ out, run: run(first) });
    const closed = await first.close({ stdinEof });
    assert.equal(closed.code, 0, JSON.stringify(closed));
    assert.equal(closed.signal, null);
    const reopened = create('reopened'); t.after(() => reopened.close());
    await reopened.initialize();
    await verifyScriptShutdown({ out, run: run(reopened), operations });
  });
}
