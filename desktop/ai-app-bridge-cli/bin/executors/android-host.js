'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { currentExecution, checkExecution, markExecutionDispatched, withoutExecution, runExecution, executionSleep } = require('../shared-kernel/execution-scope');
const { runDeviceEffect } = require('../shared-kernel/device-mutation-lease');
const { executorHome, atomicJson, readJson } = require('./managed-runtime');
const { AndroidExecutorPort, protocol, quote } = require('./android-port');

const hash = value => createHash('sha256').update(value).digest('hex');
function settlement(result, pending) {
  if (result?.executionReceipt?.settled === true && result.executionReceipt.sessionId === pending.sessionId
    && result.executionReceipt.runtimeEpoch === pending.runtimeEpoch && result.executionReceipt.actionId === pending.actionId) {
    return { kind: pending.kind, sessionId: pending.sessionId, runtimeEpoch: pending.runtimeEpoch, actionId: pending.actionId,
      settled: true, dispatched: result.executionReceipt.result?.dispatched === true, receipt: result.executionReceipt };
  }
  if (result?.ok === false && result.dispatched === false && result.ambiguous === false)
    return { kind: pending.kind, sessionId: pending.sessionId, actionId: pending.actionId, settled: true, dispatched: false };
  if (pending.operation === 'open' && result?.ok && result.protocol === pending.protocol && result.sessionId === pending.sessionId)
    return { kind: pending.kind, sessionId: pending.sessionId, runtimeEpoch: result.runtimeEpoch, settled: true, dispatched: true, state: 'ready' };
  if (['open', 'close'].includes(pending.operation) && result?.closed?.settled === true && result.closed.sessionId === pending.sessionId
    && (pending.runtimeEpoch === null || result.closed.runtimeEpoch === pending.runtimeEpoch))
    return { kind: pending.kind, sessionId: pending.sessionId, runtimeEpoch: pending.runtimeEpoch, settled: true, dispatched: true, state: 'closed' };
  return null;
}

class AndroidExecutorHost {
  constructor({ home = executorHome() } = {}) { this.home = home; this.sessions = new Map(); this.children = new Map(); }
  get kind() { return 'android-test-executor'; }
  createPort(descriptor) { return new AndroidExecutorPort(descriptor); }
  async finishClose(port) {
    if (!await port.processEnded()) return false;
    await require('../shared-kernel/uia-runtime-port').createUiaRuntimePort({ adb: port.descriptor.adb, serial: port.descriptor.serial }).releaseInstrumentation(port.descriptor.sessionId);
    return true;
  }
  directory(sessionId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) throw new CommandError('executor_session_mismatch', 'Invalid executor session ID.');
    return path.join(this.home, 'sessions', 'android', sessionId);
  }
  load(args) {
    const descriptor = readJson(path.join(this.directory(args.sessionId), 'session.json'));
    if (!descriptor || descriptor.serial !== args.serial || descriptor.packageName !== args.packageName
      || args.runtimeEpoch !== descriptor.runtimeEpoch) throw new CommandError('executor_session_mismatch', 'Executor target/session/generation does not match.');
    let port = this.sessions.get(descriptor.sessionId);
    if (!port) { port = this.createPort(descriptor); this.sessions.set(descriptor.sessionId, port); }
    return port;
  }
  async run(args) {
    const adb = args.adb || process.env.ADB || 'adb';
    if (args.operation === 'status') {
      const port = new AndroidExecutorPort({ adb, serial: args.serial });
      const listing = await port.invoke(['shell', 'pm', 'list', 'instrumentation']);
      const instruments = listing.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
        const match = /^instrumentation:(\S+) \(target=(\S+)\)$/.exec(line);
        if (!match) throw new CommandError('executor_instrumentation_inventory_invalid', 'Android returned an unexpected instrumentation entry.');
        return { component: match[1], targetPackage: match[2] };
      });
      return { ok: true, serial: args.serial, instruments,
        prerequisite: 'Use the existing application androidTest source set and install its matching test APK. Opening instrumentation restarts the target application; no separate business app is required.' };
    }
    if (args.operation === 'open') return this.open({ ...args, adb });
    const port = this.load(args), descriptor = port.descriptor;
    const request = { ...args, requestId: randomUUID() };
    delete request.adb; delete request.serial; delete request.packageName; delete request.feedback;
    if (args.operation === 'receipt') {
      const receipt = await port.readRecord(`receipts/${hash(args.actionId)}.json`);
      return { ok: Boolean(receipt), sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, receipt };
    }
    if (args.operation === 'observe') return port.request(request);
    const actionId = args.actionId || args.runtimeActionId || randomUUID();
    const pending = { kind: this.kind, protocol: descriptor.protocol, operation: args.operation, sessionId: descriptor.sessionId,
      runtimeEpoch: descriptor.runtimeEpoch, actionId, target: { serial: descriptor.serial, packageName: descriptor.packageName, adb: descriptor.adb },
      descriptorFile: path.join(this.directory(descriptor.sessionId), 'session.json') };
    return runDeviceEffect(pending, async () => {
      if (args.operation === 'close') {
        const response = await port.request(request);
        if (!response.ok) return response;
        while (true) {
          const closed = await port.readRecord('closed.json');
          if (closed?.settled === true && await this.finishClose(port)) {
            await port.disconnect(); this.sessions.delete(descriptor.sessionId); return { ok: true, closed };
          }
          await executionSleep(50);
        }
      }
      try { return await port.request({ ...request, actionId }); }
      catch (error) {
        if (error.dispatched === false) throw error;
        const recovered = await withoutExecution(() => runExecution({ timeoutMs: 5000, mutation: false }, async () => {
          await port.request({ operation: 'cancel', requestId: request.requestId, timeoutMs: 1000 });
          while (true) {
            const response = await port.request({ operation: 'receipt', actionId, timeoutMs: 1000 });
            if (response.receipt?.settled === true) return { ...response.receipt.result, executionReceipt: response.receipt, recovered: true };
            await executionSleep(50);
          }
        })).catch(recoveryError => ({ ok: false, error: 'executor_completion_unknown', message: error.message,
          recoveryError: recoveryError.code, dispatched: true, ambiguous: true, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, actionId }));
        return recovered;
      }
    }, result => settlement(result, pending));
  }
  async open(args) {
    const inventory = await this.run({ operation: 'status', adb: args.adb, serial: args.serial });
    const installed = inventory.instruments.find(item => item.component === args.instrumentation);
    if (!installed) throw new CommandError('executor_not_installed', 'The selected instrumentation component is not installed.', { dispatched: false, ambiguous: false });
    if (installed.targetPackage !== args.packageName) throw new CommandError('executor_target_mismatch', 'The test APK must target this exact application package.', { dispatched: false, ambiguous: false });
    if (!args.activity) throw new CommandError('missing_argument', 'The test executor requires the application Activity to launch.', { field: 'activity', dispatched: false, ambiguous: false });
    const sessionId = randomUUID(), directory = this.directory(sessionId);
    const descriptor = { protocol, sessionId, serial: args.serial, packageName: args.packageName, targetPackage: installed.targetPackage,
      adb: args.adb, token: randomBytes(32).toString('hex'), instrumentation: args.instrumentation, testClass: args.testClass };
    const file = path.join(directory, 'session.json');
    const port = new AndroidExecutorPort(descriptor);
    descriptor.bootId = await port.bootId();
    atomicJson(file, descriptor);
    await port.connect();
    const pending = { kind: this.kind, protocol, operation: 'open', sessionId, runtimeEpoch: null,
      target: { serial: args.serial, packageName: args.packageName, adb: args.adb }, descriptorFile: file };
    const uia = require('../shared-kernel/uia-runtime-port').createUiaRuntimePort({ adb: args.adb, serial: args.serial, timeoutMs: args.timeoutMs ?? 60000 });
    return uia.withInstrumentation(file, () => runDeviceEffect(pending, async () => {
      checkExecution();
      const command = ['am', 'instrument', '-w', '-r', '-e', 'class', args.testClass, '-e', 'bridgeSessionId', sessionId,
        '-e', 'bridgeToken', descriptor.token, '-e', 'bridgeLeaseMs', String(args.leaseMs ?? 600000),
        ...(args.activity ? ['-e', 'bridgeActivity', args.activity] : []), args.instrumentation];
      const child = spawn(args.adb, ['-s', args.serial, 'shell', command.map(quote).join(' ')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', exited = false, spawnError;
      child.on('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-65536); });
      child.once('close', code => {
        exited = true; this.children.delete(sessionId);
        atomicJson(path.join(directory, 'runner-result.json'), { sessionId, code, output: output.replaceAll(descriptor.token, '[REDACTED_SECRET]'), instrumentFinished: /INSTRUMENTATION_CODE: -?\d+/.test(output) });
      });
      this.children.set(sessionId, child);
      if (child.pid) markExecutionDispatched();
      this.sessions.set(sessionId, port);
      try {
      while (true) {
        checkExecution();
        if (spawnError) throw Object.assign(spawnError, { dispatched: false, ambiguous: false });
        if (exited) throw new CommandError('executor_runner_ended', 'Instrumentation ended before the executor was ready.', { dispatched: true, ambiguous: true, details: { sessionId, output: output.replaceAll(descriptor.token, '[REDACTED_SECRET]') } });
        let status;
        try { status = await port.request({ operation: 'status', timeoutMs: 1000 }); }
        catch (error) { if (!['ECONNRESET', 'ECONNREFUSED', 'executor_disconnected', 'executor_transport_timeout'].includes(error.code)) throw error; }
        if (status?.ok) {
          if (status.targetPackage !== installed.targetPackage || status.bootId !== descriptor.bootId || status.capabilities?.engine !== 'android-instrumentation')
            throw new CommandError('executor_engine_mismatch', 'The running test does not expose the requested executor.', { dispatched: true, ambiguous: true });
          Object.assign(descriptor, { runtimeEpoch: status.runtimeEpoch, pid: status.pid, processStartTicks: status.processStartTicks, openedAtMs: Date.now() });
          atomicJson(file, descriptor);
          return { ...status, serial: args.serial, packageName: args.packageName, targetPackage: installed.targetPackage,
            lifecycle: 'target-application-instrumented-and-restarted', leaseMs: args.leaseMs ?? 600000 };
        }
        await executionSleep(100);
      }
      } catch (error) {
        error.dispatched = Boolean(child.pid); error.ambiguous = error.dispatched;
        throw error;
      }
    }, result => settlement(result, pending)));
  }
  async close() {
    // Runtime teardown only disconnects its ADB clients. Device receipts survive;
    // the executor lease closes the test, and ownership remains unresolved until proof.
    for (const child of this.children.values()) child.kill('SIGTERM');
    this.children.clear();
  }
}

async function recoverAndroidExecutor(pending, createPort = descriptor => new AndroidExecutorPort(descriptor)) {
  const descriptor = readJson(pending.descriptorFile);
  if (!descriptor || descriptor.serial !== pending.target?.serial || descriptor.sessionId !== pending.sessionId)
    return { settled: false, error: 'executor_descriptor_mismatch' };
  const port = createPort(descriptor);
  if (await port.bootChanged()) return { kind: pending.kind, sessionId: pending.sessionId,
    runtimeEpoch: pending.runtimeEpoch, actionId: pending.actionId, settled: true, dispatched: null, state: 'device-rebooted-outcome-unknown' };
  if (pending.operation === 'open') {
    const session = await port.readRecord('session.json');
    if (session) {
      Object.assign(descriptor, { runtimeEpoch: session.runtimeEpoch, pid: session.pid, processStartTicks: session.processStartTicks });
      if (pending.kind === 'flutter-test-executor') descriptor.port = session.port;
      atomicJson(pending.descriptorFile, descriptor);
      return settlement({ ...session, ok: true }, pending);
    }
    const runner = readJson(path.join(path.dirname(pending.descriptorFile), 'runner-result.json'));
    if (runner?.sessionId === pending.sessionId && runner.instrumentFinished) return { kind: pending.kind, sessionId: pending.sessionId, settled: true, dispatched: true, state: 'runner-finished' };
  }
  if (pending.operation === 'act') {
    const receipt = await port.readRecord(`receipts/${hash(pending.actionId)}.json`);
    if (receipt?.settled) return settlement({ executionReceipt: receipt }, pending);
  }
  if (descriptor.pid && await port.processEnded()) return { kind: pending.kind, sessionId: pending.sessionId,
    runtimeEpoch: pending.runtimeEpoch, actionId: pending.actionId, settled: true, dispatched: null, state: 'executor-process-ended-outcome-unknown' };
  const closed = await port.readRecord('closed.json');
  return closed?.settled === true && await port.processEnded() ? { kind: pending.kind, sessionId: pending.sessionId, runtimeEpoch: closed.runtimeEpoch,
    actionId: pending.actionId, settled: true, dispatched: null, state: 'session-closed-outcome-unknown', closed }
    : { settled: false, error: 'executor_original_completion_unavailable', actionId: pending.actionId };
}

module.exports = { AndroidExecutorHost, recoverAndroidExecutor, settlement };
