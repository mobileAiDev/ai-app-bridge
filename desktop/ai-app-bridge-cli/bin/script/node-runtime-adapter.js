'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requestDirectory, inRequestDirectory } = require('../shared-kernel/request-context');
const { createScriptSessionChannel } = require('./script-session-channel');
const { isMutationCommand } = require('../command-registry');
const { commandFailure } = require('../command-errors');

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function childExitPromise(child, onSpawnFailure) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on('exit', (code) => done({ type: 'exit', code }));
    child.on('error', (error) => {
      if (typeof onSpawnFailure === 'function') onSpawnFailure(error);
      if (child.pid == null) {
        done({ type: 'exit', code: null, error: error.message });
      }
    });
  });
}

function createChildRuntimeAdapter({
  kind,
  executable,
  argsPrefix = [],
  sdkFile,
  extension,
  onSpawnFailure,
} = {}) {
  let channel = null;
  let child = null;
  let exited = Promise.resolve();
  let readControl = () => ({ status: 'running', pauseReason: null });
  let active = false;
  const controlWaiters = new Set();

  function wakeControl() {
    for (const resolve of controlWaiters) resolve();
    controlWaiters.clear();
  }

  async function waitUntilRunning() {
    while (active && ['pause_requested', 'paused_manual', 'paused_live', 'paused_ambiguous'].includes(readControl().status)) {
      await new Promise(resolve => controlWaiters.add(resolve));
    }
    if (!active) throw new Error('runtime_stopped');
  }

  async function terminate() {
    active = false;
    wakeControl();
    if (channel) channel.stop();
    await exited;
    child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
  }

  async function start(args) {
    const result = await inRequestDirectory(args.spec.cwd ?? requestDirectory(), () => startInDirectory(args));
    if (!result.ok && channel) {
      const diagnostics = { ...channel.diagnostics(), ...result.diagnostics };
      if (Object.keys(diagnostics).length) result.diagnostics = diagnostics;
    }
    return result;
  }

  async function startInDirectory({ spec, host, agent, emit, control }) {
    readControl = typeof control === 'function' ? control : () => control || { status: 'running', pauseReason: null };
    let directory;
    let timer = null;
    channel = null;
    exited = Promise.resolve();
    active = true;
    try {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-script-'));
      const artifact = path.join(directory, `main${extension}`);
      fs.writeFileSync(artifact, spec.source);
      const sdk = path.join(__dirname, sdkFile);
      child = spawn(executable, argsPrefix.concat([sdk, artifact]), {
        shell: false,
        cwd: requestDirectory(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      channel = createScriptSessionChannel(child, {
        maxFrameBytes: Math.max(spec.policy.maxOutputBytes, spec.policy.maxProgressBytes, 1024 * 1024) + 64 * 1024,
      });
      exited = childExitPromise(child, onSpawnFailure);
      const finished = exited;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ type: 'timeout' }), spec.policy.timeoutMs);
      });
      const rpc = pending => Promise.race([pending, timedOut, finished.then(() => { throw new Error('child_crashed'); })]);
      const reads = new Set();
      const call = async message => {
        await waitUntilRunning();
        try { return await host.call(message.command, message.args, message.options); }
        catch (error) { return commandFailure(error, message.command); }
      };
      const read = message => {
        const pending = call(message).then(value => {
          if (active) channel.send({ type: 'result', id: message.id, value, control: readControl() });
        }).catch(error => {
          // Stopping releases paused work without dispatching it. A failed
          // read or reply encoding still receives a per-call error otherwise.
          if (active) channel.send({ type: 'result', id: message.id, value: commandFailure(error, message.command), control: readControl() });
        });
        reads.add(pending);
        pending.then(() => reads.delete(pending));
      };
      const ready = await Promise.race([
        channel.nextMessage(),
        finished,
        timedOut,
      ]);
      if (ready && ready.type === 'timeout') {
        await terminate();
        return { ok: false, error: 'timeout' };
      }
      if (!ready || ready.type !== 'ready') {
        await terminate();
        return { ok: false, error: ready && ready.type === 'fail' && ready.error === 'handshake_failed' ? 'handshake_failed' : 'child_crashed' };
      }
      emit('child_started', { kind });
      channel.send({
        type: 'start',
        inputs: spec.inputs,
        target: spec.target,
        sourcePath: spec.sourcePath,
        entrypoint: spec.entrypoint,
        sourceName: spec.sourcePath || artifact,
        control: readControl(),
      });
      while (true) {
        let message = await Promise.race([
          channel.nextMessage(),
          finished,
          timedOut,
        ]);
        // Reads submitted together can overlap. Writes, assertions, decisions
        // and checkpoints retain their position after all preceding reads.
        if (['assert', 'checkpoint', 'ask', 'return'].includes(message.type)
          || (message.type === 'call' && isMutationCommand(message.command, message.args))) {
          const settled = await rpc(Promise.all([...reads]));
          if (settled?.type === 'timeout') message = settled;
          else if (channel.failure && !['return', 'fail'].includes(message.type)) message = channel.failure;
        }
        if (message.type === 'timeout') {
          await terminate();
          emit('script_failed', { error: 'timeout' });
          return { ok: false, error: 'timeout' };
        }
        if (message.type === 'call') {
          if (!isMutationCommand(message.command, message.args)) { read(message); continue; }
          const value = await rpc(call(message));
          if (value && value.type === 'timeout') {
            await terminate();
            emit('script_failed', { error: 'timeout' });
            return { ok: false, error: 'timeout' };
          }
          channel.send({ type: 'result', id: message.id, value, control: readControl() });
          continue;
        }
        if (message.type === 'assert') {
          const value = await rpc(waitUntilRunning().then(() => host.assert(message.assertion)));
          if (value && value.type === 'timeout') {
            await terminate();
            emit('script_failed', { error: 'timeout' });
            return { ok: false, error: 'timeout' };
          }
          channel.send({ type: 'verdict', id: message.id, value, control: readControl() });
          continue;
        }
        if (message.type === 'control-point') {
          channel.send({ type: 'control-state', id: message.id, control: readControl() });
          continue;
        }
        if (message.type === 'progress') {
          if (jsonBytes(message.event) > spec.policy.maxProgressBytes) {
            await terminate();
            emit('script_failed', { error: 'progress_too_large' });
            return { ok: false, error: 'progress_too_large' };
          }
          const state = await rpc(waitUntilRunning());
          if (state?.type === 'timeout') { await terminate(); return { ok: false, error: 'timeout' }; }
          emit('progress', message.event);
          if (message.id) channel.send({ type: 'progress-receipt', id: message.id, value: null, control: readControl() });
          continue;
        }
        if (message.type === 'checkpoint') {
          if (jsonBytes(message.state) > spec.policy.maxOutputBytes) {
            await terminate();
            emit('script_failed', { error: 'checkpoint_too_large' });
            return { ok: false, error: 'checkpoint_too_large' };
          }
          const receipt = await rpc(waitUntilRunning().then(() => emit('checkpoint', { name: message.name, state: message.state })));
          if (receipt && receipt.type === 'timeout') {
            await terminate();
            emit('script_failed', { error: 'timeout' });
            return { ok: false, error: 'timeout' };
          }
          if (receipt && receipt.ok === false) {
            await terminate();
            const error = receipt.error || 'checkpoint_not_persisted';
            emit('script_failed', { error });
            return { ok: false, error };
          }
          channel.send({ type: 'checkpoint-receipt', id: message.id, value: receipt, control: readControl() });
          continue;
        }
        if (message.type === 'ask') {
          const value = await rpc(waitUntilRunning().then(() => agent.askAgent(message.request)));
          if (value && value.type === 'timeout') {
            await terminate();
            emit('script_failed', { error: 'timeout' });
            return { ok: false, error: 'timeout' };
          }
          channel.send({ type: 'decision', id: message.id, value, control: readControl() });
          continue;
        }
        if (message.type === 'return') {
          if (jsonBytes(message.result) > spec.policy.maxOutputBytes) {
            await terminate();
            emit('script_failed', { error: 'output_too_large' });
            return { ok: false, error: 'output_too_large' };
          }
          child.stdin.end();
          const ended = await Promise.race([finished, timedOut]);
          if (ended && ended.type === 'timeout') {
            await terminate();
          } else {
            await finished;
          }
          emit('script_completed', { result: message.result });
          return { ok: true, result: message.result };
        }
        if (message.type === 'fail') {
          await terminate();
          const error = message.error === 'channel_closed' || message.error === 'stopped'
            ? 'child_crashed'
            : (message.error || 'script_failed');
          const captured = channel.diagnostics();
          const diagnostics = { ...captured, ...(message.diagnostic ? { error: message.diagnostic } : {}) };
          const extra = Object.keys(diagnostics).length ? { diagnostics } : {};
          emit('script_failed', { error, ...extra });
          return { ok: false, error, ...extra };
        }
        if (message.type === 'exit') {
          await terminate();
          emit('script_failed', { error: 'child_crashed' });
          return { ok: false, error: 'child_crashed' };
        }
        await terminate();
        emit('script_failed', { error: 'child_crashed' });
        return { ok: false, error: 'child_crashed' };
      }
    } catch {
      await terminate();
      emit('script_failed', { error: 'child_crashed' });
      return { ok: false, error: 'child_crashed' };
    } finally {
      if (timer) clearTimeout(timer);
      await terminate();
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  function stop() {
    return terminate();
  }

  function setControl(next) {
    if (!channel) return;
    channel.send({ type: 'control', control: next || readControl() });
    wakeControl();
  }

  return { kind, start, stop, setControl };
}

function createNodeRuntimeAdapter() {
  return createChildRuntimeAdapter({
    kind: 'javascript',
    executable: process.execPath,
    sdkFile: 'script-sdk.js',
    extension: '.js',
  });
}

module.exports = { createNodeRuntimeAdapter, createChildRuntimeAdapter, childExitPromise };
