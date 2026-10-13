#!/usr/bin/env node
'use strict';

// Setup and evidence transport only; business requests go to the public Bridge harness.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const out = process.argv[2];
const startedAt = process.argv[3];
if (!out || !startedAt) throw new Error('Usage: first-use-controller.js NEW_DIRECTORY TASK_STARTED_AT');
fs.mkdirSync(out, { mode: 0o700 });
const event = (name, details = {}) => fs.appendFileSync(path.join(out, 'timeline.jsonl'),
  JSON.stringify({ at: new Date().toISOString(), atMs: Date.now(), name, ...details }) + '\n', { mode: 0o600 });
event('task-start', { at: startedAt, atMs: Date.parse(startedAt) });
event('controller-source-written-and-started');
const binary = '/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.6-2026-10-12/k2-live-demo-1791808027918/web-memos-preparation/build/memos';
const runtimeHome = path.join(out, 'runtime');
const data = path.join(out, 'data');
const browserDir = path.join(out, 'browser');
fs.mkdirSync(data, { mode: 0o700 });
fs.mkdirSync(runtimeHome, { mode: 0o700 });
let memos, harness, pending, server, closing = false;
let ready = false;
const freePort = () => new Promise(resolve => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
async function cleanup() {
  if (closing) return;
  closing = true;
  event('cleanup-start');
  if (harness && harness.exitCode === null) {
    harness.stdin.write(JSON.stringify({ close: true }) + '\n');
    await new Promise(resolve => harness.once('exit', resolve));
  }
  if (memos && memos.exitCode === null) {
    memos.kill('SIGTERM');
    await new Promise(resolve => memos.once('exit', resolve));
  }
  event('cleanup-complete');
  if (server) server.close();
}
async function main() {
  event('environment-preparation-start');
  const memosPort = await freePort();
  const memosLog = fs.openSync(path.join(out, 'memos.log'), 'wx', 0o600);
  memos = spawn(binary, ['--addr', '127.0.0.1', '--port', String(memosPort), '--data', data],
    { stdio: ['ignore', memosLog, memosLog] });
  event('memos-start', { pid: memos.pid, memosPort, data });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${memosPort}/`)).ok) break; } catch {}
    if (attempt === 99) throw new Error('Memos did not become ready');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  event('memos-http-ready');
  const env = { ...process.env,
    AI_APP_BRIDGE_RUNTIME_HOME: runtimeHome,
    AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership'),
    AAB_PLAYWRIGHT_MODULE: '/Users/macbook/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
    AAB_CHROMIUM_EXECUTABLE: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
  const session = 'first-use-' + Date.now();
  const harnessErr = fs.openSync(path.join(out, 'harness-stderr.log'), 'wx', 0o600);
  harness = spawn(process.execPath, [path.join(__dirname, 'open-browser.js'), '--output', browserDir,
    '--session', session, '--url', `http://127.0.0.1:${memosPort}/`, '--headed', '--locale', 'en-US'],
    { env, cwd: root, stdio: ['pipe', 'pipe', harnessErr] });
  event('harness-start', { pid: harness.pid, session });
  readline.createInterface({ input: harness.stdout }).on('line', line => {
    fs.appendFileSync(path.join(out, 'harness-stdout.jsonl'), line + '\n', { mode: 0o600 });
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.name === 'initial-dom') event('first-dom-complete', value);
    if (value.ready) { ready = true; event('environment-ready', value); }
    if (pending && (value.name === pending.name || value.output?.endsWith('/' + pending.name + '.json')
      || value.screenshot?.endsWith('/' + pending.name + '.png'))) {
      const request = pending;
      pending = null;
      const body = value.output ? JSON.parse(fs.readFileSync(value.output, 'utf8')) : value;
      event('outer-call-complete', { name: request.name, startedAtMs: request.startedAtMs,
        elapsedMs: Date.now() - request.startedAtMs, responseBytes: Buffer.byteLength(JSON.stringify(body)),
        error: body.result?.error ?? null });
      request.response.end(JSON.stringify(body));
    }
  });
  harness.once('exit', (code, signal) => { event('harness-exit', { code, signal });
    if (pending) { pending.response.statusCode = 500; pending.response.end(JSON.stringify({ error: 'harness-exit', code, signal })); pending = null; } });
  server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/status') return response.end(JSON.stringify({ ready, browserDir, out, memosPort }));
    if (request.url === '/close') { await cleanup(); response.end(JSON.stringify({ closed: true })); return; }
    if (request.method !== 'POST' || request.url !== '/command') { response.statusCode = 404; response.end('{}'); return; }
    if (!ready || pending) { response.statusCode = 409; response.end(JSON.stringify({ error: !ready ? 'not-ready' : 'busy' })); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body);
    const startedAtMs = Date.now();
    event('outer-call-start', { name: value.name, command: value.command ?? null, requestBytes: Buffer.byteLength(body) });
    pending = { name: value.name, response, startedAtMs };
    harness.stdin.write(JSON.stringify(value) + '\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controlPort = server.address().port;
  const identity = { controlPort, memosPort, controllerPid: process.pid, memosPid: memos.pid,
    harnessPid: harness.pid, binary, binarySha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    session, runtimeHome, data, browserDir, startedAt };
  fs.writeFileSync(path.join(out, 'identity.json'), JSON.stringify(identity, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(identity));
}
process.on('SIGTERM', () => cleanup().catch(error => { event('cleanup-error', { error: error.stack }); process.exitCode = 1; }));
main().catch(async error => { event('controller-error', { error: error.stack }); console.error(error); process.exitCode = 1; await cleanup(); });
