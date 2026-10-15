'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const protocol = 'aab.power/v1';
const failure = (code, message, details) => Object.assign(new Error(message), { code, details });

async function openChildChannel(command, args, { env, timeoutMs = 5000, spawnChild = spawn } = {}) {
  const child = spawnChild(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '', stderr = '', readyResolve, readyReject, settled = false, exited = false, releaseConfirmation = null, terminalError = null;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const end = error => {
    terminalError ||= error;
    if (!settled) { settled = true; readyReject(terminalError); }
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(terminalError); }
    pending.clear();
  };
  const exit = new Promise(resolve => child.once('close', (code, signal) => {
    exited = true; end(failure('power_worker_closed', 'The platform power worker closed.', { code, signal, stderr }));
    resolve({ code, signal, error: terminalError });
  }));
  child.once('error', error => end(error));
  child.stdin.on('error', error => end(error));
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  child.stdout.on('data', data => {
    buffer += data.toString();
    if (buffer.length > 65536) { end(failure('power_worker_protocol', 'The power worker exceeded its message limit.')); child.kill(); return; }
    let separator;
    while ((separator = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, separator).trim(); buffer = buffer.slice(separator + 1); if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { end(failure('power_worker_protocol', 'The power worker returned invalid JSON.', { line })); child.kill(); return; }
      if (message.protocol !== protocol) { end(failure('power_worker_protocol', 'The power worker protocol does not match.')); child.kill(); return; }
      if (message.type === 'released' && message.ok === true && message.released === true) releaseConfirmation = message;
      if (!settled && message.type === 'ready' && message.ok === true) { settled = true; readyResolve(message); continue; }
      if (!settled && message.ok === false) { end(failure(message.error, message.message)); child.kill(); return; }
      const request = pending.get(message.requestId);
      if (!request) continue;
      clearTimeout(request.timer); pending.delete(message.requestId);
      if (message.ok === true) request.resolve(message);
      else request.reject(failure(message.error || 'power_worker_failed', message.message || 'The power worker rejected the request.', message));
    }
  });
  const timer = setTimeout(() => { end(failure('power_worker_start_timeout', 'The power worker did not confirm its assertion.', { stderr })); child.kill(); }, timeoutMs);
  let initial;
  try { initial = await ready; } finally { clearTimeout(timer); }
  function request(operation, fields = {}) {
    if (exited) return Promise.reject(terminalError);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(failure('power_worker_timeout', 'The power worker did not confirm the request.')); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ operation, requestId, ...fields }) + '\n', error => {
        if (error && pending.has(requestId)) { clearTimeout(timer); pending.delete(requestId); reject(error); }
      });
    });
  }
  return { child, initial, request, exit,
    async release() {
      if (exited) return { released: true, reason: 'worker_exited', confirmed: releaseConfirmation !== null };
      try {
        const result = await request('release'); child.stdin.end();
        let timer;
        try {
          await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => {
            child.kill(); reject(failure('power_worker_exit_timeout', 'The released power worker did not exit.'));
          }, timeoutMs); })]);
        } finally { clearTimeout(timer); }
        return { released: true, result };
      }
      catch (error) { child.stdin.end(); child.kill(); throw error; }
    },
  };
}

module.exports = { openChildChannel, protocol };
