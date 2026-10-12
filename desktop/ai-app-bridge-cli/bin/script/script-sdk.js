'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { boundedText, errorDiagnostic } = require('./script-diagnostics');

const artifactPath = fs.realpathSync(process.argv[2]);
const replies = new Map();
const requests = [];
const outstanding = new Set();
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

function pumpRequests() {
  while (requests.length && replies.size < 32 && !isHeld(control.status)) {
    const { message, resolve, reject } = requests.shift();
    replies.set(message.id, resolve);
    try { send(message); }
    catch (error) { replies.delete(message.id); reject(error); }
  }
}

function request(message) {
  message.id = `r${nextId += 1}`;
  const pending = new Promise((resolve, reject) => { requests.push({ message, resolve, reject }); pumpRequests(); });
  outstanding.add(pending);
  pending.then(() => outstanding.delete(pending), () => outstanding.delete(pending));
  return pending.then(async reply => { await holdIfPaused(); return reply.value; });
}

rl.on('line', (line) => {
  if (!line) return;
  let message;
  const parseStarted = performance.now();
  try {
    message = JSON.parse(line);
  } catch {
    send({ type: 'fail', error: 'malformed_frame' });
    process.exit(1);
    return;
  }
  const inputParseMs = performance.now() - parseStarted;
  if (message.type === 'start') {
    applyControl(message.control);
    run(message, inputParseMs).catch((error) => {
      const diagnostic = errorDiagnostic(error);
      if (message.sourceName && message.sourceName !== artifactPath) {
        if (diagnostic.stack) {
          const mapped = diagnostic.stack.replaceAll(artifactPath, message.sourceName);
          diagnostic.stack = boundedText(mapped, 8192);
          diagnostic.stackTruncated ||= Buffer.byteLength(mapped) > 8192;
        }
        if (diagnostic.location?.file === artifactPath) diagnostic.location.file = boundedText(message.sourceName, 1024);
      }
      send({ type: 'fail', error: message.extraction ? (error.code || 'extraction_failed') : diagnostic.message,
        message: diagnostic.message, diagnostic });
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
    pumpRequests();
  }
});

send({ type: 'ready' });

function applyControl(next) {
  if (!next) return;
  control = next;
  for (const resume of controlWaiters.splice(0)) resume();
  pumpRequests();
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

async function run(start, inputParseMs) {
  if (start.extraction) {
    const executionStarted = performance.now();
    let result;
    if (start.extraction.mode === 'regex') result = require('../extraction/regex').extractRegex(start.inputs.response, start.extraction);
    else {
      const Module = require('node:module');
      const path = require('node:path');
      const filename = path.resolve(start.sourceName || artifactPath);
      const loaded = new Module(filename, module);
      loaded.filename = filename;
      loaded.paths = Module._nodeModulePaths(path.dirname(filename));
      loaded._compile(fs.readFileSync(artifactPath, 'utf8'), filename);
      const main = typeof loaded.exports === 'function' ? loaded.exports : loaded.exports.main;
      if (typeof main !== 'function') throw new TypeError('Extraction source must export main(ctx).');
      result = await main({ inputs: start.inputs });
    }
    require('../extraction/json-value').validateJsonValue(result);
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw Object.assign(new Error('Extraction result exceeds 256 KiB.'), { code: 'extraction_output_too_large' });
    send({ type: 'return', result, timings: { inputParseMs, executionMs: performance.now() - executionStarted } });
    process.exit(0);
    return;
  }
  const loaded = require(artifactPath);
  const entry = start.entrypoint || 'main';
  const main = typeof loaded === 'function' && entry === 'main' ? loaded : loaded[entry];
  if (typeof main !== 'function') {
    send({ type: 'fail', error: 'unsupported_entrypoint' });
    process.exit(1);
  }
  const ctx = {
    inputs: start.inputs || {},
    target: start.target ? Object.freeze(structuredClone(start.target)) : null,
    sourcePath: start.sourcePath ?? null,
    call: (command, args, options) => request({ type: 'call', command, args: args || {}, options: options || {} }),
    assert: assertion => request({ type: 'assert', assertion }),
    progress: event => request({ type: 'progress', event }),
    checkpoint: (name, state) => request({ type: 'checkpoint', name, state }),
    askAgent: value => request({ type: 'ask', request: value }),
    controlPoint: () => control,
    resume: () => {
      const state = control || {};
      if (!state.checkpoint) return null;
      return state.checkpoint.state;
    },
  };
  const result = await main(ctx);
  // A returned main must not discard calls already requested by the script.
  while (outstanding.size) await Promise.all([...outstanding]);
  await holdIfPaused();
  send({ type: 'return', result });
  process.exit(0);
}
