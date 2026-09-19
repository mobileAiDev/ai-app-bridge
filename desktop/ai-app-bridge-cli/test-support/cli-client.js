'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Runs the CLI as callers do: every command carries --extract (null unless the
// test passes its own). The result exposes the public reply as `reply`, the
// decoded original result as `value` and the Host history as `history`.
async function runCli(command, args, { cwd, env = {}, cliPath = path.resolve(__dirname, '../bin/ai-app-bridge.js'), timeoutMs = 20000, extract = null } = {}) {
  const argv = [cliPath, command, '--extract', JSON.stringify(extract)];
  for (const [key, value] of Object.entries(args)) {
    const flag = `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    if (['category', 'extra'].includes(key)) { for (const item of value) argv.push(flag, item); }
    else argv.push(flag, typeof value === 'string' && key !== 'decision' ? value : JSON.stringify(value));
  }
  let result;
  let code = 0;
  try { result = await promisify(execFile)(process.execPath, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { if (typeof error.code !== 'number' || typeof error.stdout !== 'string') throw error; result = error; code = error.code; }
  const reply = JSON.parse(result.stdout);
  return { code, reply, ...decodePublicReply(reply), stderr: result.stderr };
}

function decodePublicReply(reply) {
  const value = reply.kind === 'bytes' ? Buffer.from(reply.value, 'base64') : reply.value;
  return { value, ...(reply.control?.history ? { history: reply.control.history } : {}) };
}

module.exports = { runCli, decodePublicReply };
