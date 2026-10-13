'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { capabilities, commandInputSchema } = require('../bin/command-discovery');
const { toolDefinitions } = require('../bin/mcp-server');
const { validateValue } = require('../bin/shared-kernel/argument-schema');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');

test('repository and packaged Bridge skills describe the same current contract', () => {
  assert.equal(fs.readFileSync(path.resolve(__dirname, '../../../skills/ai-app-bridge-use/SKILL.md'), 'utf8'),
    fs.readFileSync(path.resolve(__dirname, '../skills/ai-app-bridge-use/SKILL.md'), 'utf8'));
});

test('run guidance agrees with its schema about optional extraction', () => {
  const run = toolDefinitions().find(tool => tool.name === 'run');
  assert.equal(run.inputSchema.required.includes('extract'), false);
  assert.doesNotMatch(run.description, /extract is required/);
  assert.match(run.description, /auto/);
});

test('Script control discovery retains the full selected schema without repeating the authoring catalog', () => {
  for (const operation of ['decide', 'result', 'status', 'wait', 'pause', 'resume', 'cancel']) {
    const selected = capabilities({ command: 'script', operation });
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.inputSchema, commandInputSchema('script', { operation }));
    assert.equal(Object.hasOwn(selected, 'catalog'), false, operation);
  }
  const start = capabilities({ command: 'script', operation: 'start' });
  const full = capabilities({ command: 'script' });
  assert.deepEqual(start.catalog, full.catalog);
  assert.ok(start.catalog.permissions['app.workflow'].includes('intent'));
  assert.ok(start.catalog.permissions['app.expert'].includes('adb-exec'));
});

test('Script start examples run unchanged over real MCP with both language call envelopes', async t => {
  const schema = capabilities({ command: 'script', operation: 'start' }).inputSchema;
  assert.equal(schema.examples?.length, 2);
  assert.deepEqual(schema.examples.map(example => example.script.language), ['javascript', 'python']);
  for (const example of schema.examples) validateValue(example, schema);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-script-discovery-'));
  const client = createMcpClient({
    serverPath: path.resolve(__dirname, '../bin/mcp-server.js'),
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'stderr.log'),
    env: { AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtime'),
      AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' },
  });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.initialize();
  for (const example of schema.examples) {
    const receipt = payloadOf(await client.request('tools/call', {
      name: 'run', arguments: { command: 'script', arguments: example },
    }));
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
    assert.equal(receipt.result.status, 'running');
    assert.equal(receipt.result.identity.version, require('../package.json').version);
    assert.equal(receipt.result.compatible, true);
    assert.equal(receipt.persisted, true);
  }
});
