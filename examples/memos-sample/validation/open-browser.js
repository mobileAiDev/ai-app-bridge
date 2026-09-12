#!/usr/bin/env node
'use strict';

// Browser setup only. All business operations arrive as public MCP requests.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const root = path.resolve(__dirname, '../../..');
const { createMcpClient, payloadOf } = require(path.join(root,
  'desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client'));
const { values } = parseArgs({ options: {
  output: { type: 'string' }, session: { type: 'string' },
  url: { type: 'string', default: 'http://127.0.0.1:18881/' },
  'storage-state': { type: 'string' }, headed: { type: 'boolean', default: false },
  'capture-bodies': { type: 'boolean', default: false },
} });
if (!values.output || !values.session || !process.env.AAB_PLAYWRIGHT_MODULE
  || !process.env.AAB_CHROMIUM_EXECUTABLE) {
  throw new Error('Required: --output NEW_DIRECTORY --session UNIQUE_ID, AAB_PLAYWRIGHT_MODULE and AAB_CHROMIUM_EXECUTABLE.');
}
const url = new URL(values.url);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  throw new Error('This sample harness accepts only a local HTTP Memos instance.');
}
const { chromium } = require(process.env.AAB_PLAYWRIGHT_MODULE);
const directory = path.resolve(values.output);
fs.mkdirSync(directory, { mode: 0o700 });
const client = createMcpClient({ serverPath: path.join(root, 'desktop/ai-app-bridge-cli/bin/mcp-server.js'),
  transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'stderr.log'),
  timeoutMs: 180000, cwd: root,
  env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts') } });
let browser, context;

async function call(name, command, args) {
  const output = path.join(directory, `${name}.json`);
  if (fs.existsSync(output)) throw new Error(`Evidence already exists: ${name}`);
  const startedAtMs = Date.now();
  const result = payloadOf(await client.request('tools/call', {
    name: 'run', arguments: { command, arguments: args },
  }));
  fs.writeFileSync(output, JSON.stringify({ startedAtMs, completedAtMs: Date.now(), command, args, result }, null, 2),
    { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ name, output, ok: result.ok, error: result.error,
    status: result.status, operationId: result.operationId }));
  return result;
}

async function main() {
  await client.initialize();
  const server = await call('web-server', 'web-session-start', { webPort: 0 });
  if (!server.ok) throw new Error(server.error);
  browser = await chromium.launch({ executablePath: process.env.AAB_CHROMIUM_EXECUTABLE, headless: !values.headed });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    ...(values['storage-state'] ? { storageState: path.resolve(values['storage-state']) } : {}) });
  await context.addInitScript({ path: path.join(root, 'web/ai-app-bridge-web/src/index.js') });
  await context.addInitScript(config => document.addEventListener('DOMContentLoaded', () => {
    window.memosBridge = window.AiAppBridgeWeb.createAiAppBridge(config).start();
  }, { once: true }), { endpoint: server.endpoint, token: server.token, appName: 'Memos Bridge sample',
    sessionId: values.session, capture: { console: true, errors: true, fetch: true, xhr: true, ui: true },
    captureRequestBodies: values['capture-bodies'], captureResponseBodies: values['capture-bodies'] });
  const page = await context.newPage();
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.memosBridge?.isConnected(), { timeout: 15000 });
  const sessions = await call('web-sessions', 'web-sessions', {});
  const matches = sessions.sessions.filter(session => session.sessionId === values.session);
  if (matches.length !== 1) throw new Error(`Expected one connected sample session, received ${matches.length}`);
  const { sessionId, runtimeEpoch, targetId } = matches[0];
  const target = { platform: 'web', sessionId, runtimeEpoch, targetId };
  fs.writeFileSync(path.join(directory, 'target.json'), JSON.stringify(target, null, 2), { flag: 'wx', mode: 0o600 });
  await call('initial-dom', 'web-dom', { sessionId, runtimeEpoch, targetId });
  console.log(JSON.stringify({ ready: true, directory, browser: browser.version(), target }));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const lines = readline.createInterface({ input: process.stdin });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (request.close === true) break;
      if (!/^[A-Za-z0-9_-]+$/.test(request.name)) throw new Error('A unique alphanumeric evidence name is required.');
      if (request.screenshot === true) {
        const file = path.join(directory, `${request.name}.png`);
        if (fs.existsSync(file)) throw new Error(`Screenshot already exists: ${request.name}`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(JSON.stringify({ screenshot: file, source: 'browser-harness' }));
      } else await call(request.name, request.command, request.arguments);
    }
  } finally { lines.close(); }
}

main().catch(error => {
  fs.writeFileSync(path.join(directory, 'controller-error.json'), JSON.stringify({ error: error.stack }, null, 2), { mode: 0o600 });
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  try {
    if (context) {
      const state = path.join(directory, 'browser-state.json');
      await context.storageState({ path: state }); fs.chmodSync(state, 0o600);
    }
  } finally {
    try { if (browser) await browser.close(); }
    finally {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      console.log(JSON.stringify({ closed: await client.close({ stdinEof: true }) }));
    }
  }
});
