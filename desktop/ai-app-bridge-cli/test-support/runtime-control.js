'use strict';

const assert = require('node:assert/strict');
const { runCli } = require('./cli-client');

async function stopRuntime(options = {}) {
  const reply = await runCli('runtime', { operation: 'stop' }, options);
  assert.equal(reply.value.ok, true, JSON.stringify(reply));
  assert.equal(reply.value.status, 'stopped');
}

async function killRuntime(options = {}) {
  const owner = (await runCli('runtime', { operation: 'status' }, options)).value;
  assert.equal(owner.status, 'running', JSON.stringify(owner));
  assert(Number.isSafeInteger(owner.pid));
  process.kill(owner.pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  do {
    const current = (await runCli('runtime', { operation: 'status' }, options)).value;
    if (current.status === 'stopped') return owner;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail('The controlled runtime did not release its OS lock after SIGKILL.');
}

module.exports = { stopRuntime, killRuntime };
