#!/usr/bin/env node
'use strict';

// Known Memos policy, new server/data/browser/Host. No business operation uses
// Playwright or SQL writes. The outer timer includes preparation and oracles.
const enteredAtMs = Date.now();
const fs = require('node:fs'), path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify, parseArgs } = require('node:util');
const { createHash, randomBytes } = require('node:crypto');
const net = require('node:net');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../../..');
const { values } = parseArgs({ options: {
  'memos-binary': { type: 'string' }, 'playwright-module': { type: 'string' },
  'chromium-executable': { type: 'string' }, output: { type: 'string' },
} });
for (const key of ['memos-binary', 'playwright-module', 'chromium-executable', 'output'])
  if (!values[key]) throw Error(`Required: --${key}`);
process.umask(0o077);
const out = path.resolve(values.output), browserDir = path.join(out, 'browser'), dataDir = path.join(out, 'data');
fs.mkdirSync(out, { mode: 0o700 }); fs.mkdirSync(dataDir, { mode: 0o700 });
const binary = path.resolve(values['memos-binary']);
const env = { ...process.env, AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
  AAB_PLAYWRIGHT_MODULE: path.resolve(values['playwright-module']),
  AAB_CHROMIUM_EXECUTABLE: path.resolve(values['chromium-executable']) };
const report = { ok: false, scope: 'known Memos policy in an entirely new local environment',
  startedAtMs: enteredAtMs, extraModelTurns: 0, phases: [], artifacts: out, cleanup: {} };
let server, browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function phase(name, run) {
  const item = { name, startedAtMs: Date.now() }; report.phases.push(item);
  try { const result = await run(); item.ok = true; return result; }
  catch (error) { item.ok = false; item.error = error.message; throw error; }
  finally { item.finishedAtMs = Date.now(); item.elapsedMs = item.finishedAtMs - item.startedAtMs;
    console.log(JSON.stringify({ phase: name, ok: item.ok, elapsedMs: item.elapsedMs })); }
}

function loggedProcess(command, args, name, jsonLines = false) {
  const stdout = fs.openSync(path.join(out, `${name}.stdout.log`), 'w', 0o600);
  const stderr = fs.openSync(path.join(out, `${name}.stderr.log`), 'w', 0o600);
  const child = spawn(command, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const processState = { child, messages: [], exit: null, error: null };
  let pending = '';
  child.stdout.on('data', chunk => {
    fs.writeSync(stdout, chunk);
    if (!jsonLines) return;
    pending += chunk.toString(); let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      if (line) try { processState.messages.push(JSON.parse(line)); }
      catch (error) { processState.error = new Error(`Invalid ${name} JSON: ${error.message}`); }
    }
  });
  child.stderr.on('data', chunk => fs.writeSync(stderr, chunk));
  child.once('error', error => { processState.error = error; });
  child.once('close', (code, signal) => {
    processState.exit = { code, signal }; fs.closeSync(stdout); fs.closeSync(stderr);
  });
  return processState;
}

async function waitFor(test, processState, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await test(); if (result) return result;
    if (processState.error) throw processState.error;
    if (processState.exit) throw Error(`${label}: process exited ${JSON.stringify(processState.exit)}`);
    await delay(20);
  }
  throw Error(`${label}: ${timeoutMs} ms deadline`);
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function sourceManifest() {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ['desktop/ai-app-bridge-cli/bin', 'desktop/ai-app-bridge-cli/runtime',
    'web/ai-app-bridge-web/src', 'examples/memos-sample/validation']) walk(path.join(root, directory));
  for (const file of ['desktop/ai-app-bridge-cli/package.json', 'web/ai-app-bridge-web/package.json',
    'desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client.js', 'examples/memos-sample/source.json'])
    files.push(path.join(root, file));
  return Object.fromEntries(files.sort().map(file => [path.relative(root, file), sha256(file)]));
}

async function runner(file, args, name) {
  const directory = path.join(out, name);
  try {
    const result = await execute(process.execPath, [path.join(__dirname, file), ...args],
      { cwd: root, env, maxBuffer: 16e6, timeout: 90000 });
    fs.writeFileSync(path.join(out, `${name}.stdout.log`), result.stdout, { mode: 0o600 });
    fs.writeFileSync(path.join(out, `${name}.stderr.log`), result.stderr, { mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(path.join(out, `${name}.stdout.log`), error.stdout || '', { mode: 0o600 });
    fs.writeFileSync(path.join(out, `${name}.stderr.log`), error.stderr || error.message, { mode: 0o600 });
    throw Error(`${name} failed; inspect ${directory}`);
  }
  const result = read(path.join(directory, 'report.json'));
  if (!result.ok || result.status !== 'completed') throw Error(`${name} did not complete successfully`);
  return result;
}

async function main() {
  await phase('source-and-binary-verification', async () => {
    fs.accessSync(binary, fs.constants.X_OK); fs.accessSync(env.AAB_CHROMIUM_EXECUTABLE, fs.constants.X_OK);
    require.resolve(env.AAB_PLAYWRIGHT_MODULE);
    const sources = sourceManifest(); save(path.join(out, 'source-sha256.json'), sources);
    report.sourceManifestSha256 = sha256(path.join(out, 'source-sha256.json'));
    report.sdkSourceSha256 = sources['web/ai-app-bridge-web/src/index.js'];
    report.memosBinary = { path: binary, sha256: sha256(binary), premise: 'Previously verified official binary; no download in this run.' };
    report.hostIdentity = require(path.join(root, 'desktop/ai-app-bridge-cli/bin/runtime-directory')).runtimeIdentity({
      facts: path.join(browserDir, 'facts'), profile: '64mb' });
  });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`; report.origin = origin;
  await phase('memos-server-start', async () => {
    server = loggedProcess(binary, ['--addr', '127.0.0.1', '--port', String(port), '--data', dataDir, '--log-level', 'warn'], 'memos');
    await waitFor(async () => {
      try { const response = await fetch(origin, { signal: AbortSignal.timeout(500) }); await response.arrayBuffer(); return response.ok; }
      catch (error) { if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return false; throw error; }
    }, server, 15000, 'Memos HTTP readiness');
  });
  await phase('browser-sdk-host-start', async () => {
    const storage = path.join(out, 'english-context.json');
    save(storage, { cookies: [], origins: [{ origin, localStorage: [{ name: 'memos-locale', value: 'en' }] }] });
    browser = loggedProcess(process.execPath, [path.join(__dirname, 'open-browser.js'), '--output', browserDir,
      '--session', `memos-e2e-${enteredAtMs}`, '--url', origin, '--locale', 'en-US', '--headed', '--storage-state', storage], 'browser', true);
    await waitFor(() => browser.messages.find(message => message.ready === true), browser, 20000, 'Browser/SDK/Host readiness');
    report.preparation = read(path.join(browserDir, 'preparation.json'));
    if (report.preparation.sdkSourceSha256 !== report.sdkSourceSha256) throw Error('Injected SDK differs from the source manifest');
  });
  const credentials = { username: `bridge${randomBytes(6).toString('hex')}`, password: randomBytes(24).toString('base64url') };
  save(path.join(browserDir, 'credentials.json'), credentials);
  report.signup = await phase('intent-signup', () => runner('run-current.js', [browserDir, dataDir, path.join(out, 'signup'), 'signup'], 'signup'));
  await phase('signup-sqlite-oracle', async () => {
    const source = `import sqlite3,json,sys\ndb=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nusers=db.execute('SELECT username,role FROM user').fetchall()\nchecks={'onlyIntendedAdmin':users==[(sys.argv[2],'ADMIN')],'noMemosBeforeBusiness':db.execute('SELECT count(*) FROM memo').fetchone()[0]==0}\nprint(json.dumps({'ok':all(checks.values()),'checks':checks}))`;
    const result = JSON.parse((await execute('python3', ['-c', source, path.join(dataDir, 'memos_prod.db'), credentials.username])).stdout);
    save(path.join(out, 'signup-oracle.json'), result); report.signupOracle = result;
    if (!result.ok) throw Error('Independent signup oracle failed');
  });
  report.javascript = await phase('javascript-five-flows-and-oracle', () => runner('run-long.js',
    [browserDir, dataDir, path.join(out, 'javascript'), '5'], 'javascript'));
  report.python = await phase('python-flow-and-oracle', () => runner('run-current.js',
    [browserDir, dataDir, path.join(out, 'python'), 'python'], 'python'));
  await phase('final-evidence-and-source-check', async () => {
    browser.child.stdin.write(JSON.stringify({ name: 'end-to-end-final', screenshot: true }) + '\n');
    await waitFor(() => browser.messages.find(message => message.screenshot), browser, 10000, 'Final screenshot');
    report.screenshot = path.join(browserDir, 'end-to-end-final.png');
    if (JSON.stringify(sourceManifest()) !== JSON.stringify(read(path.join(out, 'source-sha256.json'))))
      throw Error('Source changed during the end-to-end control');
  });
  report.ok = true;
}

async function cleanup() {
  const startedAtMs = Date.now();
  if (browser && !browser.exit) {
    browser.child.stdin.write('{"close":true}\n');
    try {
      await waitFor(() => browser.exit, browser, 20000, 'Normal browser/Host shutdown');
      report.cleanup.browser = browser.exit;
      if (browser.exit.code !== 0) throw Error('Browser/Host shutdown failed');
    } catch (error) { report.ok = false; report.cleanup.browserError = error.message; }
  }
  if (server && !server.exit) {
    server.child.kill('SIGTERM');
    try { await waitFor(() => server.exit, server, 10000, 'Memos shutdown'); report.cleanup.memos = server.exit; }
    catch (error) { report.ok = false; report.cleanup.memosError = error.message; }
  }
  report.cleanup.startedAtMs = startedAtMs; report.cleanup.elapsedMs = Date.now() - startedAtMs;
}

function countPublicRequests() {
  const transcript = path.join(browserDir, 'mcp.jsonl');
  const records = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const mcp = records.filter(record => record.direction === 'request').map(record => ({ method: record.message.method,
    command: record.message.params?.arguments?.command, operation: record.message.params?.arguments?.arguments?.operation }));
  const business = [];
  for (const name of ['signup', 'python']) {
    const file = path.join(out, name, 'replies.jsonl');
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      const item = JSON.parse(line); business.push({ phase: name, command: item.command, status: item.result.control.status });
    }
  }
  if (fs.existsSync(path.join(out, 'javascript/reply.json'))) {
    const reply = read(path.join(out, 'javascript/reply.json'));
    business.push({ phase: 'javascript', command: reply.command, status: reply.control.status });
  }
  return { publicCommandRpcs: mcp.filter(item => item.method === 'tools/call').length + business.length,
    includingMcpInitialize: mcp.length + business.length,
    initializedNotifications: records.filter(record => record.direction === 'notification').length,
    mcp, business, excludes: 'In-process Intent/Script commands are recorded separately, not additional model/client RPCs.' };
}

main().catch(error => { report.error = error.message; }).finally(async () => {
  report.finishedAtMs = Date.now(); report.endToEndMs = report.finishedAtMs - enteredAtMs;
  await cleanup();
  report.rpc = countPublicRequests(); report.totalIncludingCleanupMs = Date.now() - enteredAtMs;
  save(path.join(out, 'report.json'), report);
  console.log(JSON.stringify({ ok: report.ok, endToEndMs: report.endToEndMs, cleanupMs: report.cleanup.elapsedMs,
    totalIncludingCleanupMs: report.totalIncludingCleanupMs, extraModelTurns: report.extraModelTurns,
    publicCommandRpcs: report.rpc.publicCommandRpcs, report: path.join(out, 'report.json'), error: report.error }));
  if (!report.ok) process.exitCode = 1;
});
