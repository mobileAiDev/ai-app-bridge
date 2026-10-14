'use strict';

const net = require('node:net');
const { CommandError } = require('../command-errors');
const { currentExecution, checkExecution, executionFailure } = require('./execution-scope');

// Each HTTP request selects an exact serial and an epoch-specific App socket on
// one ADB server connection. No forward table and no mutable host port intervene.
async function openAdbSocket(route, { timeoutMs = 5000 } = {}) {
  checkExecution();
  const scope = currentExecution();
  const socket = net.connect(route.server.path ? { path: route.server.path } : { host: route.server.host, port: route.server.port });
  let buffer = Buffer.alloc(0), waiter, failure;
  const wake = () => { const next = waiter; waiter = null; next?.(); };
  const onData = chunk => { buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 65543) socket.destroy(new CommandError('adb_protocol_invalid', 'ADB handshake exceeded its bounded reply size.')); wake(); };
  const onError = error => { failure = error; wake(); };
  const onClose = () => { failure ||= Object.assign(new Error('ADB connection closed during route selection.'), { code: 'ECONNRESET' }); wake(); };
  const abort = () => socket.destroy(executionFailure(scope));
  const timer = setTimeout(() => socket.destroy(new CommandError('provider_timeout', `ADB route selection timed out after ${timeoutMs} ms.`)), timeoutMs);
  socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
  scope?.signal.addEventListener('abort', abort, { once: true });
  if (scope?.signal.aborted) abort();
  async function read(size) {
    while (buffer.length < size) {
      if (failure) throw failure;
      await new Promise(resolve => { waiter = resolve; });
    }
    const value = buffer.subarray(0, size); buffer = buffer.subarray(size); return value;
  }
  async function select(service) {
    const value = Buffer.from(service);
    if (value.length > 0xffff || service.includes('\0')) throw new CommandError('adb_service_invalid', 'ADB service must fit its length-prefixed protocol.');
    socket.write(Buffer.concat([Buffer.from(value.length.toString(16).padStart(4, '0')), value]));
    const status = (await read(4)).toString();
    if (status === 'FAIL') {
      const length = (await read(4)).toString();
      if (!/^[0-9a-f]{4}$/i.test(length)) throw new CommandError('adb_protocol_invalid', 'Invalid ADB failure length.');
      const error = new CommandError('adb_service_failed', (await read(parseInt(length, 16))).toString());
      error.details = { service, serverSocket: route.server.socket, serial: route.serial, socketName: route.endpoint.socketName };
      error.adbService = service; throw error;
    }
    if (status !== 'OKAY') throw new CommandError('adb_protocol_invalid', 'Invalid ADB service response.');
  }
  try {
    await select(`host:transport:${route.serial}`);
    await select(`localabstract:${route.endpoint.socketName}`);
    checkExecution();
    socket.pause(); socket.removeListener('data', onData);
    if (buffer.length) socket.unshift(buffer);
    // The next HTTP consumer attaches in a microtask. An error arriving at that
    // handoff must not become an unhandled EventEmitter error.
    socket.on('error', () => {});
    return socket;
  } catch (error) {
    socket.destroy();
    Object.assign(error, { aiAppBridgeRequestNotStarted: true, dispatched: false, ambiguous: false });
    throw error;
  } finally {
    clearTimeout(timer);
    socket.removeListener('data', onData); socket.removeListener('error', onError); socket.removeListener('close', onClose);
    scope?.signal.removeEventListener('abort', abort);
  }
}

module.exports = { openAdbSocket };
