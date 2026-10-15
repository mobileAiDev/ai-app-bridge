'use strict';

const spawn = require('cross-spawn');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createProcessScope } = require('./windows-process');

function gatedWindowsSpawn(file, args, options) {
  const child = fork(path.join(__dirname, 'windows-command-worker.js'), [], {
    cwd: options.cwd, env: options.env, windowsHide: true, execArgv: [],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json',
  });
  child.dispatchPending = true;
  const kill = child.kill.bind(child);
  let scope;
  let stopped = false;
  const closeScope = () => {
    if (!scope) return true;
    try { scope.close(); scope = null; return true; }
    catch (error) { child.emit('error', error); return false; }
  };
  child.kill = signal => { stopped = true; closeScope(); return kill(signal); };
  child.on('message', message => {
    if (message.event === 'ready') {
      if (stopped) return;
      try {
        scope = createProcessScope(child.pid);
        child.emit('dispatch');
        child.send({ file, args, options });
      } catch (error) { child.emit('error', error); child.kill('SIGKILL'); }
    } else if (message.event === 'result') {
      child.commandResult = message;
      if (!closeScope()) kill('SIGKILL');
    }
  });
  child.once('close', closeScope);
  return child;
}

// execFile cannot launch Windows command shims. Use cross-spawn's argument
// quoting/PATHEXT handling, retaining execFile's buffered callback contract.
function portableExecFile(file, args, options, callback) {
  const { encoding = 'utf8', maxBuffer = 1024 * 1024, killSignal = 'SIGTERM', ...spawnOptions } = options;
  const child = process.platform === 'win32' ? gatedWindowsSpawn(file, args, spawnOptions)
    : spawn(file, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
  const streams = { stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 } };
  let failure;
  // Job cleanup can fail both when stopping and when the worker closes. Keep
  // listening through close so a second failure cannot escape the Runtime.
  child.on('error', error => { failure ||= error; });
  for (const [name, stream] of Object.entries(streams)) child[name].on('data', chunk => {
    const remaining = maxBuffer - stream.bytes;
    stream.chunks.push(chunk.subarray(0, Math.max(0, remaining)));
    stream.bytes += chunk.length;
    if (stream.bytes > maxBuffer && !failure) {
      failure = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      child.kill(killSignal);
    }
  });
  child.once('close', (code, signal) => {
    if (child.commandResult) {
      ({ code, signal } = child.commandResult);
      if (child.commandResult.failure) failure ||= Object.assign(new Error(child.commandResult.failure.message), child.commandResult.failure);
    }
    if (!failure && (code !== 0 || signal)) failure = Object.assign(new Error(`Command failed: ${file}`), { code, signal });
    if (failure) {
      failure.killed = child.killed;
      // ENOENT alone is insufficient: cross-spawn may already have started a
      // shell. Only the worker's explicit no-child receipt proves no dispatch.
      if (child.commandResult?.spawned === false) {
        failure.dispatched = false;
        failure.ambiguous = false;
      }
    }
    const output = name => {
      const bytes = Buffer.concat(streams[name].chunks);
      return encoding === null || encoding === 'buffer' ? bytes : bytes.toString(encoding);
    };
    callback(failure || null, output('stdout'), output('stderr'));
  });
  return child;
}

module.exports = { portableExecFile };
