'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScriptSessionChannel } = require('./script-session-channel');

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
  let exited = Promise.resolve();
  let readControl = () => ({ status: 'running', pauseReason: null });

  async function terminate() {
    if (channel) channel.stop();
    await exited;
  }

  async function start({ spec, host, agent, emit, control }) {
    readControl = typeof control === 'function' ? control : () => control || { status: 'running', pauseReason: null };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-script-'));
    const artifact = path.join(directory, `main${extension}`);
    fs.writeFileSync(artifact, spec.source);
    const sdk = path.join(__dirname, sdkFile);
    const child = spawn(executable, argsPrefix.concat([sdk, artifact]), {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    channel = createScriptSessionChannel(child);
    exited = childExitPromise(child, onSpawnFailure);
    const finished = exited;
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ type: 'timeout' }), spec.policy.timeoutMs);
    });
    try {
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
      entrypoint: spec.entrypoint,
      control: control(),
    });
    while (true) {
      const message = await Promise.race([
        channel.nextMessage(),
        finished,
        timedOut,
      ]);
      if (message.type === 'timeout') {
        await terminate();
        emit('script_failed', { error: 'timeout' });
        return { ok: false, error: 'timeout' };
      }
      if (message.type === 'call') {
        const value = await Promise.race([
          host.call(message.command, message.args, message.options),
          timedOut,
        ]);
        if (value && value.type === 'timeout') {
          await terminate();
          emit('script_failed', { error: 'timeout' });
          return { ok: false, error: 'timeout' };
        }
        channel.send({ type: 'result', id: message.id, value, control: readControl() });
        continue;
      }
      if (message.type === 'assert') {
        const value = await Promise.race([
          host.assert(message.assertion),
          timedOut,
        ]);
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
        emit('progress', message.event);
        continue;
      }
      if (message.type === 'checkpoint') {
        if (jsonBytes(message.state) > spec.policy.maxOutputBytes) {
          await terminate();
          emit('script_failed', { error: 'checkpoint_too_large' });
          return { ok: false, error: 'checkpoint_too_large' };
        }
        const receipt = await Promise.race([
          Promise.resolve(emit('checkpoint', { name: message.name, state: message.state })),
          timedOut,
        ]);
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
        const value = await Promise.race([
          agent.askAgent(message.request),
          timedOut,
        ]);
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
        emit('script_failed', { error });
        return { ok: false, error };
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
    }
  }

  function stop() {
    return terminate();
  }

  function setControl(next) {
    if (!channel) return;
    channel.send({ type: 'control', control: next || readControl() });
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
