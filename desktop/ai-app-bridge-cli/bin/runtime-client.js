'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { CommandError, commandFailure } = require('./command-errors');
const { validateRunRequest } = require('./command-request');
const { protocol, maxMessageBytes, readJson, decodeReply } = require('./runtime-protocol');
const { runtimeLocation, runtimeIdentity, acquireRuntimeLock, readEndpoint, prepareDirectory } = require('./runtime-directory');
const { executablePath } = require('./shared-kernel/executable-path');
const starting = new Map();

// Transport failures do not retry execution or cancel its owner. Once the
// request has been written, the device outcome is unknown to this connection.
function exchange(endpoint, method, args, { identity, signal, timeoutMs, cwd = process.cwd() } = {}) {
  if (signal?.aborted) return Promise.reject(new CommandError('runtime_client_disconnected', 'The client connection was closed.'));
  const body = JSON.stringify({ protocol, runtimeId: endpoint.runtimeId, method, identity, arguments: args, cwd });
  if (Buffer.byteLength(body) > maxMessageBytes) return Promise.reject(new CommandError('runtime_message_too_large', 'Runtime messages are limited to 128 MiB.'));
  return new Promise((resolve, reject) => {
    let written = false;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const failure = (code, message) => new CommandError(code, message, {
      dispatched: written ? null : false, ambiguous: written,
      details: { runtimeId: endpoint.runtimeId, pid: endpoint.pid },
    });
    const request = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: '/rpc', method: 'POST', agent: false,
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' } }, async response => {
      try {
        const message = await readJson(response);
        if (message.protocol !== protocol || message.runtimeId !== endpoint.runtimeId) throw failure('runtime_protocol_error', 'Runtime reply identity did not match the connection.');
        finish(null, decodeReply(message.reply));
      } catch (error) { finish(failure('runtime_protocol_error', error.message)); }
    });
    const abort = () => request.destroy(failure('runtime_client_disconnected', 'The client disconnected; execution was not cancelled.'));
    request.once('finish', () => { written = true; });
    request.once('error', error => finish(error instanceof CommandError ? error : failure('runtime_connection_lost', error.message)));
    if (timeoutMs !== undefined) timer = setTimeout(() => request.destroy(failure('runtime_connection_timeout', 'The runtime did not answer the connection probe.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    request.end(body);
  });
}

async function probe(location, signal) {
  const endpoint = readEndpoint(location);
  let cause;
  if (endpoint) {
    try {
      const reply = await exchange(endpoint, 'status', {}, { signal, timeoutMs: 1500 });
      if (reply.value.ok !== true) throw new CommandError(reply.value.error, reply.value.message);
      return { state: 'running', endpoint, status: reply.value };
    } catch (error) { cause = error; if (signal?.aborted) throw error; }
  }
  const lock = acquireRuntimeLock(location);
  if (lock) { lock.close(); return { state: 'stopped' }; }
  // A busy OS lock is authoritative even when health or startup publication
  // times out. Never replace this owner based on elapsed time or its PID file.
  return { state: endpoint ? 'unresponsive' : 'starting', cause };
}

function requireCompatible(status, expected) {
  if (status.identity.code !== expected.code) throw new CommandError('runtime_code_mismatch', 'The running runtime uses different code. Inspect runtime status and explicitly stop it before starting this build.', { details: { runtimeId: status.runtimeId, pid: status.pid } });
  if (status.identity.config !== expected.config) throw new CommandError('runtime_configuration_mismatch', 'The running runtime uses different persistent/provider configuration. Use the same configuration or explicitly stop it first.', { details: { runtimeId: status.runtimeId, pid: status.pid } });
}

function launch(location) {
  prepareDirectory(location);
  const log = fs.openSync(location.logFile, 'a', 0o600);
  let child;
  try {
    // Pin the provider chosen by this client before requests change cwd. Other
    // clients may reach the same executable through a different PATH or alias.
    const adb = executablePath(process.env.ADB || 'adb');
    child = fork(path.join(__dirname, 'execution-runtime.js'), [], {
      detached: true, execArgv: [], stdio: ['ignore', log, log, 'ipc'],
      env: { ...process.env, ...(adb ? { ADB: adb } : {}), AI_APP_BRIDGE_FACT_STORE_DIR: location.facts },
    });
  } finally { fs.closeSync(log); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new CommandError('runtime_start_timeout', 'Runtime startup did not report readiness. No running owner was terminated.', { details: { logFile: location.logFile } })), 10000);
    let done = false;
    function finish(error, message) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeAllListeners('message');
      if (child.connected) child.disconnect();
      child.unref();
      error ? reject(error) : resolve(message);
    }
    child.once('message', message => {
      if (message.status === 'ready' || message.status === 'owned') finish(null, message);
      else finish(new CommandError(message.error || 'runtime_start_failed', message.message || 'Runtime startup failed.', { details: { logFile: location.logFile } }));
    });
    child.once('error', error => finish(new CommandError('runtime_start_failed', error.message)));
    child.once('exit', (code, signal) => finish(new CommandError('runtime_start_failed', `Runtime exited before readiness: ${code ?? signal}.`, { details: { logFile: location.logFile } })));
  });
}

async function ensureRuntime(location, identity, signal) {
  let state = await probe(location, signal);
  if (state.state === 'running') { requireCompatible(state.status, identity); return state.endpoint; }
  if (state.state === 'unresponsive') throw new CommandError('runtime_unresponsive', 'The runtime still owns its OS lock but did not answer. It was not restarted.');
  if (!starting.has(location.directory)) {
    const pending = (async () => {
      const deadline = Date.now() + 10000;
      do {
        let launched;
        if (state.state === 'stopped') launched = await launch(location);
        state = await probe(location, signal);
        if (state.state === 'running') { requireCompatible(state.status, identity); return state.endpoint; }
        if (state.state === 'stopped' && launched?.status === 'ready')
          throw new CommandError('runtime_start_failed', 'The runtime exited after reporting readiness.');
        // A candidate may lose to another client's short ownership probe,
        // rather than to a running server. A now-free OS lock allows another
        // startup election. No execute request has been sent at this point.
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new CommandError('runtime_start_timeout', 'The existing runtime owner has not reported readiness.');
    })();
    starting.set(location.directory, pending);
    pending.then(() => starting.delete(location.directory), () => starting.delete(location.directory));
  }
  return starting.get(location.directory);
}

async function run(request, { signal } = {}) {
  try {
    request = validateRunRequest(request);
    // Verification is an offline command in both transports; it neither
    // opens FactStore nor depends on a running owner or valid store profile.
    if (request.command === 'evidence' && request.arguments.operation === 'verify') {
      return { value: await require('./shared-kernel/evidence-archive').handle(request.arguments) };
    }
    const location = runtimeLocation();
    const identity = runtimeIdentity(location);
    if (request.command === 'runtime' && request.arguments.operation !== 'start') {
      const state = await probe(location, signal);
      if (state.state === 'stopped') return { value: { ok: true, command: 'runtime', status: 'stopped', facts: location.facts } };
      if (state.state !== 'running') throw new CommandError('runtime_unresponsive', 'A runtime owns the OS lock but has not answered. It was not restarted.');
      if (request.arguments.operation === 'stop') return await exchange(state.endpoint, 'stop', {}, { signal });
      return { value: { ...state.status, compatible: state.status.identity.code === identity.code && state.status.identity.config === identity.config } };
    }
    const endpoint = await ensureRuntime(location, identity, signal);
    if (request.command === 'runtime') return await exchange(endpoint, 'status', {}, { signal });
    return await exchange(endpoint, 'execute', request, { identity, signal });
  } catch (error) { return { value: commandFailure(error, request?.command) }; }
}

module.exports = { run, exchange };
