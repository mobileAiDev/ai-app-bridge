'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const artifactPath = process.argv[2];
const replies = new Map();
const controlWaiters = [];
let nextId = 0;
let control = { status: 'running', pauseReason: null };

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  fs.writeSync(1, `${JSON.stringify(message)}\n`);
}

function writeStderr(args) {
  fs.writeSync(2, `${args.map(String).join(' ')}\n`);
}

console.log = (...args) => writeStderr(args);
console.info = (...args) => writeStderr(args);
console.debug = (...args) => writeStderr(args);

function waitReply(id) {
  return new Promise((resolve) => {
    if (replies.size >= 32) {
      send({ type: 'fail', error: 'channel_backlog' });
      process.exit(1);
      return;
    }
    replies.set(id, resolve);
  });
}

rl.on('line', (line) => {
  if (!line) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ type: 'fail', error: 'malformed_frame' });
    process.exit(1);
    return;
  }
  if (message.type === 'start') {
    applyControl(message.control);
    run(message).catch((error) => {
      send({ type: 'fail', error: error.message || String(error) });
      process.exit(1);
    });
    return;
  }
  if (message.type === 'control') {
    applyControl(message.control);
    return;
  }
  if (message.id && replies.has(message.id)) {
    applyControl(message.control);
    const resolve = replies.get(message.id);
    replies.delete(message.id);
    resolve(message);
  }
});

send({ type: 'ready' });

function applyControl(next) {
  if (!next) return;
  control = next;
  while (controlWaiters.length > 0) controlWaiters.shift()();
}

function isHeld(status) {
  return status === 'pause_requested'
    || status === 'paused_manual'
    || status === 'paused_live'
    || status === 'paused_ambiguous';
}

function holdIfPaused() {
  return new Promise((resolve) => {
    const tick = () => {
      if (!isHeld(control.status)) {
        resolve();
        return;
      }
      controlWaiters.push(tick);
    };
    tick();
  });
}

async function run(start) {
  const loaded = require(artifactPath);
  const entry = start.entrypoint || 'main';
  const main = typeof loaded === 'function' && entry === 'main' ? loaded : loaded[entry];
  if (typeof main !== 'function') {
    send({ type: 'fail', error: 'unsupported_entrypoint' });
    process.exit(1);
  }
  const ctx = {
    inputs: start.inputs || {},
    call: async (command, args, options) => {
      await holdIfPaused();
      const id = `c${nextId += 1}`;
      send({ type: 'call', id, command, args: args || {}, options: options || {} });
      const reply = await waitReply(id);
      await holdIfPaused();
      return reply.value;
    },
    assert: async (assertion) => {
      await holdIfPaused();
      const id = `a${nextId += 1}`;
      send({ type: 'assert', id, assertion });
      const reply = await waitReply(id);
      await holdIfPaused();
      return reply.value;
    },
    progress: async (event) => {
      await holdIfPaused();
      send({ type: 'progress', event });
      await holdIfPaused();
    },
    checkpoint: async (name, state) => {
      await holdIfPaused();
      const id = `k${nextId += 1}`;
      send({ type: 'checkpoint', id, name, state });
      const reply = await waitReply(id);
      await holdIfPaused();
      return reply.value;
    },
    askAgent: async (request) => {
      await holdIfPaused();
      const id = `q${nextId += 1}`;
      send({ type: 'ask', id, request });
      const reply = await waitReply(id);
      await holdIfPaused();
      return reply.value;
    },
    controlPoint: () => control,
    resume: () => {
      const state = control || {};
      if (!state.checkpoint) return null;
      return state.checkpoint.state;
    },
  };
  const result = await main(ctx);
  send({ type: 'return', result });
  process.exit(0);
}
