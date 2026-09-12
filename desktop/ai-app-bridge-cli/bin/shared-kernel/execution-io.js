'use strict';

const { execFile } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const { CommandError } = require('../command-errors');
const { requestDirectory } = require('./request-context');
const { runExecution, currentExecution, checkExecution, executionFailure, markExecutionDispatched } = require('./execution-scope');

function ioFailure(code, message, scope) {
  return new CommandError(code, message, { dispatched: scope?.dispatched === true, ambiguous: scope?.dispatched === true });
}

// Cancellation requests termination but resolves only after the subprocess has
// closed. Releasing a device lease on a Promise.race would leave a live writer.
function execFileBounded(file, args, { timeoutMs = 15000, mutation = false, execFileImpl = execFile, ...options } = {}) {
  if (!currentExecution()) return runExecution({ mutation }, () => execFileBounded(file, args, { ...options, timeoutMs, mutation, execFileImpl }));
  checkExecution();
  const scope = currentExecution();
  return new Promise((resolve, reject) => {
    let stopped;
    let killTimer;
    let timer;
    let completed = false;
    const abort = () => stop(executionFailure(scope));
    const child = execFileImpl(file, args, { cwd: requestDirectory(), ...options, timeout: 0, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      completed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      scope?.signal.removeEventListener('abort', abort);
      if (stopped) error = stopped;
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        error.dispatched ??= scope?.dispatched === true;
        error.ambiguous ??= error.dispatched;
        reject(error);
      } else resolve({ stdout, stderr });
    });
    if (completed) return;
    if (mutation && child.pid) markExecutionDispatched();
    const stop = error => {
      if (stopped) return;
      stopped = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    };
    timer = setTimeout(() => stop(ioFailure('provider_timeout', `Subprocess timed out after ${timeoutMs} ms.`, scope)), timeoutMs);
    scope?.signal.addEventListener('abort', abort, { once: true });
    if (scope?.signal.aborted) abort();
  });
}

function httpRequestBounded(url, { method = 'GET', payload, headers = {}, timeoutMs = 10000, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!currentExecution()) return runExecution({ mutation: method !== 'GET' }, () => httpRequestBounded(url, { method, payload, headers, timeoutMs, maxBytes }));
  checkExecution();
  const scope = currentExecution();
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const protocol = new URL(url).protocol;
  if (!['http:', 'https:'].includes(protocol)) throw ioFailure('invalid_argument', 'HTTP transport requires an http or https URL.', scope);
  checkExecution();
  return new Promise((resolve, reject) => {
    let failure;
    let data = '';
    let bytes = 0;
    let ended = false;
    const request = (protocol === 'https:' ? https : http).request(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }) },
    }, response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) stop(ioFailure('provider_response_too_large', `HTTP response exceeds ${maxBytes} bytes.`, scope));
        else data += chunk;
      });
      response.on('error', error => stop(error));
      response.on('end', () => {
        ended = true;
        if (response.statusCode < 200 || response.statusCode >= 300) failure = Object.assign(new Error(`HTTP ${response.statusCode}: ${data}`),
          { statusCode: response.statusCode, responseBody: data });
      });
    });
    const stop = error => { failure ||= error; request.destroy(); };
    const abort = () => stop(executionFailure(scope));
    const timer = setTimeout(() => stop(ioFailure('provider_timeout', `HTTP request timed out after ${timeoutMs} ms.`, scope)), timeoutMs);
    scope?.signal.addEventListener('abort', abort, { once: true });
    request.on('error', error => { failure ||= error; });
    request.on('close', () => {
      clearTimeout(timer);
      scope?.signal.removeEventListener('abort', abort);
      if (!ended) failure ||= ioFailure('provider_disconnected', 'HTTP response closed before completion.', scope);
      if (failure) {
        failure.url = url;
        failure.dispatched ??= scope?.dispatched === true;
        failure.ambiguous ??= failure.dispatched;
        reject(failure);
      } else resolve(data);
    });
    try { checkExecution(); } catch (error) { stop(error); return; }
    if (method !== 'GET' && scope?.mutation) markExecutionDispatched();
    request.end(body);
  });
}

module.exports = { execFileBounded, httpRequestBounded };
