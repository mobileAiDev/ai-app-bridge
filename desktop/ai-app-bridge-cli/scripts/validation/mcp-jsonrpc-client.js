'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

function createMcpClient({ serverPath, transcriptPath, stderrPath, timeoutMs = 120_000, env = {}, cwd }) {
  const transcript = fs.openSync(transcriptPath, 'a');
  const diagnostics = fs.openSync(stderrPath, 'a');
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, ...env },
  });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  let requests = 0;
  let notifications = 0;
  let closed = false;
  const log = (direction, message) => fs.writeSync(transcript, `${JSON.stringify({ at: new Date().toISOString(), direction, message })}\n`);
  function fail(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      closed = true;
      fail(new Error(`MCP exited: code=${code} signal=${signal}`));
      resolve({ code, signal });
    });
    child.once('error', (error) => { closed = true; fail(error); resolve({ error: error.message }); });
  });
  child.once('close', () => { fs.closeSync(transcript); fs.closeSync(diagnostics); });
  child.stderr.on('data', (chunk) => fs.writeSync(diagnostics, chunk));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch {
        fail(new Error('MCP stdout contained invalid JSON'));
        child.kill('SIGTERM');
        return;
      }
      log('response', response);
      const entry = pending.get(response.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(response.id);
      if (response.error) entry.reject(new Error(JSON.stringify(response.error)));
      else entry.resolve(response);
    }
  });
  function request(method, params, budgetMs = timeoutMs) {
    if (closed) return Promise.reject(new Error('MCP is closed'));
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`MCP request timed out: ${method}`);
        error.code = 'MCP_REQUEST_TIMEOUT';
        reject(error);
      }, budgetMs);
      pending.set(id, { timer, resolve, reject });
      log('request', message);
      requests += 1;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) fail(error); });
    });
  }
  return {
    request,
    get pid() { return child.pid; },
    counts: () => ({ requests, notifications }),
    async initialize() {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'localsend-route-comparison', version: '1' } });
      const message = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
      notifications += 1;
      log('notification', message);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    // This validation harness normally owns its isolated runtime as well as
    // its MCP subprocess. Connection-lifetime tests explicitly opt out.
    async close({ stdinEof = false, stopRuntime = true } = {}) {
      if (closed) return exited;
      let failure;
      try {
        if (stopRuntime) {
          const result = payloadOf(await request('tools/call', { name: 'run', arguments: { command: 'runtime', arguments: { operation: 'stop' } } }));
          if (result.ok !== true) throw new Error(`Validation runtime shutdown failed: ${JSON.stringify(result)}`);
        }
      } catch (error) { failure = error; }
      if (stdinEof) child.stdin.end(); else child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { const result = await exited; if (failure) throw failure; return result; } finally { clearTimeout(timer); }
    },
  };
}

function payloadOf(response) {
  const text = response?.result?.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('MCP response has no text payload');
  const payload = JSON.parse(text);
  if (response.result.isError && payload.ok !== false) return { ...payload, ok: false, error: 'MCP tool returned isError' };
  return payload;
}

module.exports = { createMcpClient, payloadOf };
