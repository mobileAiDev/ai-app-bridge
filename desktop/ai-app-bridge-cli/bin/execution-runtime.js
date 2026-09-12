#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { CommandError, commandFailure } = require('./command-errors');
const { protocol, maxMessageBytes, encodeReply, readJson } = require('./runtime-protocol');
const { runtimeLocation, runtimeIdentity, acquireRuntimeLock, publishEndpoint } = require('./runtime-directory');
const { inRequestDirectory } = require('./shared-kernel/request-context');

async function start() {
  const location = runtimeLocation();
  const owner = acquireRuntimeLock(location);
  if (!owner) { notify({ status: 'owned' }); return; }
  const runtimeId = randomUUID();
  const identity = runtimeIdentity(location);
  const token = randomBytes(32).toString('hex');
  const startedAtMs = Date.now();
  const host = require('./execution-host');
  let stopping;
  let phase = 'running';
  const status = () => ({ ok: true, command: 'runtime', status: phase, runtimeId, pid: process.pid, identity,
    startedAtMs, facts: location.facts, profile: location.profile, node: { executable: process.execPath, version: process.version } });
  const server = http.createServer(async (request, response) => {
    const send = reply => {
      if (response.destroyed) return;
      let message;
      try { message = JSON.stringify({ protocol, runtimeId, reply: encodeReply(reply) }); }
      catch (error) { message = JSON.stringify({ protocol, runtimeId, reply: encodeReply({ value: commandFailure(error) }) }); }
      if (Buffer.byteLength(message) > maxMessageBytes) message = JSON.stringify({ protocol, runtimeId,
        reply: encodeReply({ value: { ok: false, error: 'runtime_message_too_large', dispatched: null, ambiguous: true } }) });
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(message);
    };
    try {
      if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST' || request.url !== '/rpc') {
        request.resume(); throw new CommandError('runtime_access_denied', 'The local runtime connection is not authenticated.');
      }
      const message = await readJson(request);
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).some(key => !['protocol', 'runtimeId', 'method', 'identity', 'arguments', 'cwd'].includes(key))
        || message.protocol !== protocol || message.runtimeId !== runtimeId) throw new CommandError('runtime_protocol_error', 'Runtime request identity or fields are invalid.');
      if (message.method === 'status') { send({ value: status() }); return; }
      if (message.method === 'stop') { await stop(); send({ value: status() }); return; }
      if (message.method !== 'execute') throw new CommandError('runtime_protocol_error', 'Unknown runtime method.');
      if (phase !== 'running') throw new CommandError('runtime_stopping', 'The runtime is stopping.');
      if (message.identity?.code !== identity.code) throw new CommandError('runtime_code_mismatch', 'The runtime and client use different code.');
      if (message.identity?.config !== identity.config) throw new CommandError('runtime_configuration_mismatch', 'The runtime and client use different configuration.');
      let validDirectory = false;
      if (typeof message.cwd === 'string' && path.isAbsolute(message.cwd)) {
        try { validDirectory = fs.statSync(message.cwd).isDirectory(); }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      }
      if (!validDirectory) throw new CommandError('invalid_request_directory', 'The request working directory must exist and be absolute.', { field: 'cwd' });
      // Closing this HTTP connection never cancels the admitted work. Its
      // original runtime, deadline and explicit cancel operation own settlement.
      send(await inRequestDirectory(message.cwd, () => host.run(message.arguments)));
    } catch (error) { send({ value: commandFailure(error) }); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;

  async function stop() {
    if (stopping) return stopping;
    phase = 'stopping';
    server.close();
    stopping = (async () => {
      await host.close();
      fs.unlinkSync(location.endpointFile);
      owner.close();
      phase = 'stopped';
    })();
    return stopping;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    publishEndpoint(location, { protocol, runtimeId, pid: process.pid, token, port: server.address().port, facts: location.facts });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void stop().then(() => server.closeAllConnections()).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
    });
    process.once('exit', () => owner.close());
    notify({ status: 'ready', runtimeId, pid: process.pid });
  } catch (error) {
    server.close(); owner.close(); throw error;
  }
}

function notify(message) {
  if (process.send) process.send(message, () => { if (process.connected) process.disconnect(); });
}

if (require.main === module) start().catch(error => {
  notify({ status: 'failed', error: error.code || 'runtime_start_failed', message: error.message });
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = { start };
