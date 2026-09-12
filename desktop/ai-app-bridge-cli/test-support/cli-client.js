'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { decodeReply } = require('../bin/runtime-protocol');

async function runCli(command, args, { cwd, env = {}, cliPath = path.resolve(__dirname, '../bin/ai-app-bridge.js'), timeoutMs = 20000 } = {}) {
  const argv = [cliPath, command];
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
  return { code, reply, ...decodeReply(reply), stderr: result.stderr };
}

module.exports = { runCli };
