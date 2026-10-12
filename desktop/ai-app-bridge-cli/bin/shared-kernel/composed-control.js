'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

// A force-stop must run outside the process it stops. Keep an independent
// control process and a local result file, including when the caller dies.
function start(command, args) {
  const directory = path.join(require('../runtime-directory').runtimeLocation().directory, 'controls');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const controlId = randomUUID();
  const resultPath = path.join(directory, `${controlId}.json`);
  const request = { command, arguments: args, extract: null };
  fs.writeFileSync(resultPath, JSON.stringify({ controlId, state: 'requested', request }), { mode: 0o600, flag: 'wx' });
  const log = fs.openSync(path.join(directory, `${controlId}.log`), 'ax', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [__filename, resultPath], {
      detached: true, stdio: ['ignore', log, log], windowsHide: true,
      cwd: require('./request-context').requestDirectory(),
    });
  } finally { fs.closeSync(log); }
  child.on('error', error => fs.writeFileSync(resultPath, JSON.stringify({ controlId, state: 'failed', error: error.message })));
  child.unref();
  return { ok: true, command, controlId, controlAccepted: true, completionScope: 'control-request',
    status: 'requested', resultPath, controlPid: child.pid, settled: true, dispatched: true, ambiguous: false,
    guidance: { message: 'An independent controller will stop the requested owner. This acknowledges the request, not completion. Read resultPath or query status from another call.',
      nextActions: [{ command, arguments: { ...(command === 'device-ownership' ? { serial: args.serial } : {}), operation: 'status' } }] } };
}

async function control(resultPath, run = request => require('../runtime-client').run(request)) {
  const pending = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  // Let the initiating RPC return its acknowledgement before cancelling its
  // owner. This is not a device-action retry or a completion guarantee.
  await new Promise(resolve => setTimeout(resolve, 100));
  let terminal;
  try {
    terminal = { state: 'returned', result: await run(pending.request) };
  } catch (error) {
    terminal = { state: 'failed', error: error.code || 'control_failed', message: error.message,
      outcome: 'unknown', guidance: 'Inspect runtime or device-ownership status before requesting another stop. The controller did not establish completion.' };
  }
  const temporary = `${resultPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...pending, ...terminal, completedAtMs: Date.now() }), { mode: 0o600 });
  fs.renameSync(temporary, resultPath);
}

if (require.main === module) control(process.argv[2]).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
module.exports = { start, control };
