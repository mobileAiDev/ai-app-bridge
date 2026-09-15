'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { currentExecution, markExecutionDispatched, checkExecution } = require('../shared-kernel/execution-scope');
const { executorHome, packageLocation, packageStatus, preparePackage, readJson } = require('./managed-runtime');
const { ReceiptJournal } = require('./receipt-journal');

const protocol = 'aab.playwright-worker/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mutation = args => ['open', 'act', 'navigate', 'close'].includes(args.operation);

class PlaywrightHost {
  constructor({ home = executorHome() } = {}) { this.home = home; this.sessions = new Map(); this.closed = false; }

  async run(args) {
    if (this.closed) throw new CommandError('executor_host_closed', 'Browser executor Host is closed.');
    for (const [id, worker] of this.sessions) if (worker.closed) this.sessions.delete(id);
    if (args.operation === 'status') return { ...packageStatus(args.browser || 'chromium', this.home),
      sessions: [...this.sessions.values()].map(worker => ({ ...worker.identity, state: worker.closed ? 'closed' : 'running' })) };
    if (args.operation === 'prepare') return preparePackage(args.browser || 'chromium', { home: this.home });
    if (args.operation === 'open') {
      let url;
      try { url = new URL(args.url); } catch { /* rejected below */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CommandError('invalid_argument', 'Browser URLs must use HTTP(S) without embedded credentials.', { field: 'url' });
      const status = packageStatus(args.browser || 'chromium', this.home);
      if (!status.available) throw new CommandError('executor_not_prepared', 'Prepare this browser executor before opening a session.', { details: status });
      if (this.sessions.size >= 16) throw new CommandError('executor_session_capacity', 'Close a browser executor session before opening another.');
      const identity = { sessionId: randomUUID(), runtimeEpoch: randomUUID() };
      const directory = path.join(this.home, 'sessions', 'playwright', identity.sessionId);
      const location = packageLocation('playwright', this.home);
      const worker = new WorkerClient(location, directory, identity);
      this.sessions.set(identity.sessionId, worker);
      try {
        const result = await worker.request(args);
        if (!result.ok) { await worker.stop(); this.sessions.delete(identity.sessionId); }
        return result;
      } catch (error) { await worker.stop(); this.sessions.delete(identity.sessionId); throw error; }
    }
    for (const field of ['sessionId', 'runtimeEpoch', 'targetId']) if (!uuid.test(args[field] || '')) throw new CommandError('executor_session_mismatch', 'Executor identity is invalid.', { field });
    if (args.operation === 'receipt') {
      const directory = path.join(this.home, 'sessions', 'playwright', args.sessionId);
      const descriptor = readJson(path.join(directory, 'session.json'));
      if (!descriptor || descriptor.runtimeEpoch !== args.runtimeEpoch) throw new CommandError('executor_session_mismatch', 'No retained executor session matches this identity.');
      const receipt = new ReceiptJournal(path.join(directory, 'receipts'),
        { sessionId: args.sessionId, runtimeEpoch: args.runtimeEpoch, targetId: args.targetId }).receipt(args.actionId);
      return { ok: Boolean(receipt), ...(receipt ? { receipt } : { error: 'executor_receipt_not_found' }) };
    }
    const worker = this.sessions.get(args.sessionId);
    if (!worker || worker.closed || worker.identity.runtimeEpoch !== args.runtimeEpoch) throw new CommandError('executor_session_unavailable', 'This browser session is no longer live. Retained receipts remain queryable.');
    if (args.operation === 'navigate') {
      let url;
      try { url = new URL(args.url); } catch { /* rejected below */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CommandError('invalid_argument', 'Navigation requires an HTTP(S) URL without credentials.', { field: 'url' });
    }
    const request = { ...args };
    if (['act', 'navigate'].includes(args.operation)) request.actionId = args.actionId || args.runtimeActionId || randomUUID();
    const result = await worker.request(request);
    if (args.operation === 'close' && result.ok) { await worker.stop(); this.sessions.delete(args.sessionId); }
    return result;
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.sessions.values()].map(worker => worker.stop()));
    this.sessions.clear();
  }
}

class WorkerClient {
  constructor(location, directory, identity) {
    this.identity = identity; this.pending = new Map(); this.closed = false;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.child = fork(path.join(__dirname, 'playwright-worker.js'), [location.directory, directory, identity.sessionId, identity.runtimeEpoch],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: process.platform !== 'win32', serialization: 'json',
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: location.browsersPath } });
    this.stderr = '';
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-8192); });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.ended = new Promise(resolve => this.child.once('close', () => {
      this.closed = true;
      const error = new CommandError('executor_worker_closed', 'The browser worker closed before completion.', { details: { stderr: this.stderr } });
      this.rejectReady(error);
      for (const pending of this.pending.values()) pending.fail(error);
      this.pending.clear(); resolve();
    }));
    this.child.on('error', error => this.rejectReady(error));
    this.child.on('message', message => {
      if (message?.protocol !== protocol) return;
      if (message.type === 'ready') { this.resolveReady(); return; }
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); pending.finish(message.result); }
    });
    this.startTimer = setTimeout(() => { this.rejectReady(new CommandError('executor_start_timeout', 'Browser worker did not initialize.')); void this.stop(); }, 15000);
    this.ready.finally(() => clearTimeout(this.startTimer)).catch(() => {});
  }

  async request(args) {
    await this.ready;
    checkExecution();
    if (this.closed) throw new CommandError('executor_worker_closed', 'Browser worker is closed.');
    const id = randomUUID(), scope = currentExecution();
    return new Promise((resolve, reject) => {
      let timer, killTimer;
      const clean = () => { clearTimeout(timer); clearTimeout(killTimer); scope?.signal.removeEventListener('abort', abort); };
      const abort = () => {
        if (this.child.connected) this.child.send({ protocol, type: 'cancel', id });
        killTimer ||= setTimeout(() => { void this.stop(); }, 5000);
      };
      this.pending.set(id, {
        finish: result => { clean(); resolve(result); },
        fail: error => { clean(); reject(new CommandError(error.code || 'executor_worker_closed', error.message,
          { dispatched: mutation(args), ambiguous: mutation(args), details: { ...error.details, ...this.identity, actionId: args.actionId } })); },
      });
      scope?.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, args.timeoutMs ?? 30000);
      if (mutation(args)) markExecutionDispatched();
      this.child.send({ protocol, type: 'request', id, args }, error => {
        if (error) { const pending = this.pending.get(id); this.pending.delete(id); pending?.fail(error); }
      });
      if (scope?.signal.aborted) abort();
    });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      clearTimeout(this.startTimer);
      if (this.closed) return;
      const kill = signal => {
        try { if (process.platform === 'win32') this.child.kill(signal); else process.kill(-this.child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 1000);
      try { await this.ended; } finally { clearTimeout(timer); }
    })();
    return this.stopPromise;
  }
}

module.exports = { PlaywrightHost };
