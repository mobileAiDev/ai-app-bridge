'use strict';

const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { execFileBounded } = require('../shared-kernel/execution-io');
const { currentExecution, checkExecution, markExecutionDispatched, executionFailure } = require('../shared-kernel/execution-scope');
const protocol = 'aab.android-test-executor/v1';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

class AndroidExecutorPort {
  constructor(descriptor, { run = execFileBounded, protocolVersion = protocol } = {}) { this.descriptor = descriptor; this.port = null; this.run = run; this.protocolVersion = protocolVersion; }
  forwardEndpoint() { return `localabstract:aab-test-${this.descriptor.sessionId}`; }
  recordDirectory() { return `no_backup/ai-app-bridge-executors/${this.descriptor.sessionId}`; }
  invoke(args, timeoutMs = 10000) {
    return this.run(this.descriptor.adb, ['-s', this.descriptor.serial, ...args], { timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  }
  async connect() {
    const descriptor = this.descriptor;
    const remote = this.forwardEndpoint();
    const inventory = async () => (await this.invoke(['forward', '--list'])).stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [serial, local, remote] = line.trim().split(/\s+/); return { serial, local, remote };
    });
    const existing = (await inventory()).filter(item => item.serial === descriptor.serial && item.remote === remote);
    if (existing.length > 1) throw new CommandError('executor_forward_ambiguous', 'Multiple forwards target this exact executor.');
    const local = existing.length === 1 ? existing[0].local : `tcp:${(await this.invoke(['forward', 'tcp:0', remote])).stdout.trim()}`;
    if (!/^tcp:[1-9][0-9]{0,4}$/.test(local) || Number(local.slice(4)) > 65535) throw new CommandError('executor_forward_invalid', 'ADB returned an invalid executor forward.');
    const confirmed = (await inventory()).filter(item => item.local === local);
    if (confirmed.length !== 1 || confirmed[0].serial !== descriptor.serial || confirmed[0].remote !== remote)
      throw new CommandError('executor_forward_mismatch', 'Executor forward belongs to another target.');
    this.port = Number(local.slice(4));
  }
  async request(args) {
    if (this.port === null) await this.connect();
    checkExecution();
    const scope = currentExecution();
    const payload = { protocol: this.protocolVersion, token: this.descriptor.token, sessionId: this.descriptor.sessionId,
      ...(this.descriptor.runtimeEpoch ? { runtimeEpoch: this.descriptor.runtimeEpoch } : {}), requestId: randomUUID(), ...args };
    const body = JSON.stringify(payload) + '\n';
    if (Buffer.byteLength(body) > 1024 * 1024) throw new CommandError('executor_request_limit', 'Executor request exceeds 1 MiB.', { dispatched: false, ambiguous: false });
    return new Promise((resolve, reject) => {
      let data = '', bytes = 0, failure, result, timer, dispatched = false;
      const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
      const stop = error => { failure ||= error; socket.destroy(); };
      const abort = () => stop(executionFailure(scope));
      timer = setTimeout(() => stop(new CommandError('executor_transport_timeout', 'Executor reply did not complete within the request deadline.')), args.timeoutMs ?? 30000);
      scope?.signal.addEventListener('abort', abort, { once: true });
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        try { checkExecution(); } catch (error) { stop(error); return; }
        if (['act', 'close'].includes(args.operation)) { dispatched = true; markExecutionDispatched(); }
        socket.write(body);
      });
      socket.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) { stop(new CommandError('executor_response_limit', 'Executor reply exceeds 4 MiB.')); return; }
        data += chunk;
        if (data.endsWith('\n')) {
          try {
            result = JSON.parse(data);
            if (result.protocol !== this.protocolVersion || result.sessionId !== payload.sessionId || (payload.runtimeEpoch && result.runtimeEpoch !== payload.runtimeEpoch))
              throw new CommandError('executor_session_mismatch', 'Executor reply identity does not match the original request.');
            socket.destroy();
          } catch (error) { stop(error); }
        }
      });
      socket.on('error', error => { failure ||= error; });
      socket.on('close', () => {
        clearTimeout(timer); scope?.signal.removeEventListener('abort', abort);
        if (!result) failure ||= new CommandError('executor_disconnected', 'Executor disconnected without a complete reply.');
        if (failure) { failure.dispatched = dispatched; failure.ambiguous = dispatched; reject(failure); }
        else resolve(result);
      });
      if (scope?.signal.aborted) abort();
    });
  }
  async readRecord(name) {
    if (!/^(session|starting|failed|closed)\.json$/.test(name) && !/^receipts\/[a-f0-9]{64}\.json$/.test(name)) throw new Error('Invalid executor record');
    const file = `${this.recordDirectory()}/${name}`;
    const script = `if [ -f ${quote(file)} ]; then cat ${quote(file)}; else printf '%s' null; fi`;
    const result = await this.invoke(['shell', 'run-as', this.descriptor.targetPackage, 'sh', '-c', quote(script)]);
    const record = JSON.parse(result.stdout.trim());
    if (record && (record.protocol !== this.protocolVersion || record.sessionId !== this.descriptor.sessionId
      || record.targetPackage !== this.descriptor.targetPackage || record.bootId !== this.descriptor.bootId
      || (this.descriptor.runtimeEpoch && record.runtimeEpoch !== this.descriptor.runtimeEpoch))) throw new CommandError('executor_receipt_mismatch', 'Retained device record belongs to a different session.');
    return record;
  }
  async disconnect() {
    if (this.port !== null) { await this.invoke(['forward', '--remove', `tcp:${this.port}`]); this.port = null; }
  }
  async processEnded() {
    if (await this.bootChanged()) return true;
    if (!Number.isInteger(this.descriptor.pid) || this.descriptor.pid < 1) throw new CommandError('executor_process_identity_missing', 'The executor did not publish its process identity.');
    if (!/^[0-9]+$/.test(this.descriptor.processStartTicks)) throw new CommandError('executor_process_identity_missing', 'The executor did not publish its process start identity.');
    const script = `if [ -d /proc/${this.descriptor.pid} ]; then cat /proc/${this.descriptor.pid}/stat; else printf '%s' gone; fi`;
    const result = (await this.invoke(['shell', 'run-as', this.descriptor.targetPackage, 'sh', '-c', quote(script)])).stdout.trim();
    if (result === 'gone') return true;
    const start = result.slice(result.lastIndexOf(') ') + 2).split(/\s+/)[19];
    if (!/^[0-9]+$/.test(start)) throw new CommandError('executor_process_probe_invalid', 'The device did not confirm the executor process state.');
    return start !== this.descriptor.processStartTicks;
  }
  async bootId() {
    const id = (await this.invoke(['shell', 'cat', '/proc/sys/kernel/random/boot_id'])).stdout.trim();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new CommandError('executor_boot_identity_invalid', 'The device did not publish a valid boot identity.');
    return id;
  }
  async bootChanged() {
    if (typeof this.descriptor.bootId !== 'string' || !/^[a-f0-9-]{36}$/.test(this.descriptor.bootId))
      throw new CommandError('executor_boot_identity_missing', 'The original executor boot identity is unavailable.');
    return await this.bootId() !== this.descriptor.bootId;
  }
}

module.exports = { AndroidExecutorPort, protocol, quote };
