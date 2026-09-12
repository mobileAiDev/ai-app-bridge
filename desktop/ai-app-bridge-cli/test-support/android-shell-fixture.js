'use strict';

// Host-only Android execution-protocol simulator. Device acceptance uses real
// ADB separately. Existing fixture commands still run in real subprocesses.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function word(text, offset = 0) {
  if (text[offset] !== "'") throw new Error('Expected a shell-quoted protocol argument.');
  let value = '';
  for (let i = offset + 1; i < text.length;) {
    if (text.slice(i, i + 4) === "'\\''") { value += "'"; i += 4; }
    else if (text[i] === "'") return { value, end: i + 1 };
    else value += text[i++];
  }
  throw new Error('Unterminated protocol argument.');
}

function printed(script, destination) {
  const prefix = "printf '%s' ";
  for (let offset = 0;;) {
    const at = script.indexOf(prefix, offset);
    if (at < 0) throw new Error(`Missing protocol file ${destination}`);
    const item = word(script, at + prefix.length);
    if (script.slice(item.end).startsWith(` >"$job/${destination}"`)) return item.value;
    offset = item.end;
  }
}

function commandArgs(command) {
  if (!command.startsWith('exec ')) throw new Error('Expected exec argv.');
  const argv = [];
  let offset = 5;
  while (offset < command.length && command[offset] !== '\n') {
    const parsed = word(command, offset); argv.push(parsed.value);
    offset = parsed.end + 1;
  }
  return argv;
}

function handleAndroidShellFixture(args, { pending = false } = {}) {
  if (args[0] !== '-s' || args[2] !== 'shell' || args[3] !== 'sh' || args[4] !== '-c') return { handled: false, args };
  const script = word(args[5]).value;
  const directory = process.argv[1] + '.shell-jobs';
  fs.mkdirSync(directory, { recursive: true });
  const bootFile = path.join(directory, 'boot');
  if (!fs.existsSync(bootFile)) fs.writeFileSync(bootFile, randomUUID());
  const boot = fs.readFileSync(bootFile, 'utf8');
  const reply = value => { process.stdout.write(JSON.stringify(value)); return { handled: true }; };
  if (script.includes('"uptimeMs":%s')) return reply({ runtimeEpoch: boot, uptimeMs: Date.now() });
  const jobDirectory = word(script, script.indexOf('job=') + 4).value;
  const file = path.join(directory, path.basename(jobDirectory) + '.json');
  const save = state => fs.writeFileSync(file, JSON.stringify(state));
  if (script.includes('>"$job/identity.tmp"')) {
    const identity = JSON.parse(printed(script, 'identity.tmp'));
    const argv = commandArgs(printed(script, 'command.sh'));
    save({ identity, argv, launched: false, receipt: null, output: { stdout: '', stderr: '' } });
    return reply({ ok: true, prepared: true });
  }
  const identity = JSON.parse(word(script, script.indexOf('expected=') + 9).value);
  if (identity.runtimeEpoch !== boot) return reply({ ok: false, error: 'shell_runtime_changed' });
  if (!fs.existsSync(file)) return reply({ ok: false, error: 'shell_execution_not_found' });
  const state = JSON.parse(fs.readFileSync(file));
  if (JSON.stringify(state.identity) !== JSON.stringify(identity)) return reply({ ok: false, error: 'shell_execution_not_found' });
  const rejectAdmission = error => ({ ...identity, ok: false, error, settled: true, dispatched: false, ambiguous: false, exitCode: null });
  if (script.includes('mkdir "$job/launched"')) {
    if (state.launched) return reply({ ok: false, error: 'shell_action_id_reused' });
    state.launched = true;
    if (!state.receipt && Date.now() >= identity.deadlineUptimeMs) state.receipt = rejectAdmission('shell_action_timeout');
    if (!state.receipt && !pending) {
      const child = spawnSync(process.execPath, [process.argv[1], '-s', args[1], 'shell', ...state.argv], { encoding: 'utf8' });
      state.output = { stdout: child.stdout, stderr: child.stderr };
      state.receipt = { ...identity, ok: true, settled: true, dispatched: true, ambiguous: false, exitCode: child.status };
    }
    save(state); return reply({ ok: true, submitted: true });
  }
  if (script.includes('>"$job/cancel.tmp"')) {
    if (!state.launched && !state.receipt) { state.receipt = rejectAdmission('shell_action_cancelled'); save(state); }
    return reply(state.receipt || { ok: true, settled: false });
  }
  if (script.includes('>"$job/acknowledged.tmp"')) return reply({ ok: true, acknowledged: true });
  if (script.includes('base64 "$job/stdout"')) return reply({ ok: true,
    stdout: Buffer.from(state.output.stdout).toString('base64'), stderr: Buffer.from(state.output.stderr).toString('base64') });
  if (pending && state.launched && !state.receipt) return { handled: false, args: ['-s', args[1], 'shell', ...state.argv] };
  return reply(state.receipt || { ok: true, settled: false });
}

module.exports = { handleAndroidShellFixture };
