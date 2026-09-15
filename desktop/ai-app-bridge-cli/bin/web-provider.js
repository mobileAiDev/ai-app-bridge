'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { CommandError } = require('./command-errors');
const { WebSessionStore, maxPageRecords, digest } = require('./web/session-store');
const { getProcessDeviceMutationLease, runDeviceEffect } = require('./shared-kernel/device-mutation-lease');
const managed = require('./shared-kernel/managed-sdk-execution');
const { schema: domTargetSchema, validateSnapshot } = require('./shared-kernel/web-dom-target');
const { checkExecution, currentExecution, runExecution, withoutExecution, markExecutionDispatched } = require('./shared-kernel/execution-scope');

const protocol = 'aab.web/v2', executionSchema = 'aab.web-execution/v1';
const limits = Object.freeze({ sessions: 32, sockets: 64, pending: 64, messageBytes: 256 * 1024,
  socketBytes: 1024 * 1024, handshakeMs: 5000, inactiveSessionMs: 5 * 60000 });
const readCommands = new Set(['domSnapshot']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const targetOf = value => ({ sessionId: value.sessionId, runtimeEpoch: value.runtimeEpoch, targetId: value.targetId ?? 'main' });
const sessionKey = sessionId => `web:${JSON.stringify([sessionId])}`;
const failure = (error, fields = {}) => ({ ok: false, error, ...fields });

class WebBridgeProvider {
  constructor({ store = new WebSessionStore(), lease, now = Date.now } = {}) {
    this.store = store; this.lease = lease; this.now = now;
    this.server = null; this.wss = null; this.sessions = new Map(); this.pendingCommands = new Map();
    this.starting = null; this.closing = null; this.epoch = randomUUID();
  }
  owner() { return this.lease ?? getProcessDeviceMutationLease(); }

  async run(command, args = {}) {
    try {
      checkExecution();
      switch (command) {
        case 'web-provider-status': return this.providerStatus();
        case 'web-session-start': return await this.start(args);
        case 'web-session-stop': await this.close(); return { ok: true, running: false };
        case 'web-connect-info': return this.connectInfo();
        case 'web-sessions': return this.listSessions();
        case 'web-status': {
          const session = this.requireSession(args, false);
          return { ok: true, session: this.sessionSummary(session), ownership: this.owner().status(sessionKey(args.sessionId)) };
        }
        case 'web-execution': return await this.executionControl(args);
        case 'web-ui-observation': return await this.request(this.connected(args), 'read', {
          name: 'uiObservation', args: require('./ui-observation').request(args),
        }, args.timeoutMs ?? 5000);
        case 'web-dom': return args.history === true ? await this.captureResponse(args, 'dom') : await this.dom(args);
        case 'web-logs': return await this.captureResponse(args, 'logs');
        case 'web-network': return await this.captureResponse(args, 'network');
        case 'web-state': return await this.captureResponse(args, 'state');
        case 'web-events': return await this.captureResponse(args, 'events');
        case 'web-command': return await this.command(args);
        case 'web-click': return await this.command({ ...args, name: 'click', arguments: select(args, ['selector', 'expectedTarget']) });
        case 'web-input': return await this.command({ ...args, name: 'input', arguments: select(args, ['selector', 'expectedTarget', 'value']) });
        case 'web-key': return await this.command({ ...args, name: 'key', arguments: select(args, ['selector', 'expectedTarget', 'key']) });
        case 'web-wait': return await this.command({ ...args, name: 'waitFor', arguments: select(args, ['selector', 'targetText', 'timeoutMs']) });
        case 'web-scroll': return await this.command({ ...args, name: 'scroll', arguments: select(args, ['selector', 'expectedTarget', 'mode', 'deltaX', 'deltaY']) });
        default: return failure('unknown_web_command', { command });
      }
    } catch (error) {
      return failure(error.code || 'web_provider_failed', { message: error.message,
        dispatched: error.dispatched ?? false, ambiguous: error.ambiguous ?? false, ...(error.settled === undefined ? {} : { settled: error.settled }) });
    }
  }

  async start(args = {}) {
    if (this.closing) throw new CommandError('web_provider_stopping', 'Wait for the current provider stop to finish.');
    const config = { host: args.host ?? '127.0.0.1', port: args.webPort ?? 18180,
      path: args.path ?? '/ai-app-bridge-web', token: args.token };
    if (!text(config.host) || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
        || !/^\/[A-Za-z0-9/_-]+$/.test(config.path) || (config.token !== undefined && !text(config.token)))
      throw new CommandError('invalid_web_configuration', 'Supply a host, port 0–65535, absolute WebSocket path and nonempty token.');
    if (this.starting) { await this.starting; return this.start(args); }
    if (this.server) {
      if (!isDeepStrictEqual(config, this.config)) throw new CommandError('web_provider_configuration_conflict', 'The running provider has different configuration. Stop it before changing configuration.');
      return { ...this.connectInfo(), alreadyRunning: true };
    }
    this.config = config; this.token = config.token ?? randomBytes(24).toString('base64url'); this.epoch = randomUUID();
    // Listeners outlive the start command's deadline/context.
    this.starting = withoutExecution(() => new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => this.handleHttp(request, response));
      const wss = new WebSocketServer({ noServer: true, maxPayload: limits.messageBytes, perMessageDeflate: false });
      this.server = server; this.wss = wss;
      server.headersTimeout = 5000; server.requestTimeout = 5000; server.maxConnections = limits.sockets;
      server.on('upgrade', (request, socket, head) => {
        let url; try { url = new URL(request.url, 'http://bridge.invalid'); } catch { socket.destroy(); return; }
        if (url.pathname !== config.path || url.searchParams.get('token') !== this.token || wss.clients.size >= limits.sockets) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
        }
        wss.handleUpgrade(request, socket, head, ws => this.handleConnection(ws));
      });
      const onError = error => { server.close(); wss.close(); this.server = null; this.wss = null; reject(error); };
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.off('error', onError);
        this.port = server.address().port;
        this.maintenance = setInterval(() => this.sweep(), 1000); this.maintenance.unref();
        resolve();
      });
    }));
    try { await this.starting; return { ...this.connectInfo(), started: true }; }
    finally { this.starting = null; }
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.starting) await this.starting.catch(() => {});
      clearInterval(this.maintenance);
      const server = this.server, wss = this.wss;
      if (!server) return;
      this.server = null; this.wss = null;
      for (const pending of [...this.pendingCommands.values()]) pending.fail('web_provider_stopped');
      for (const socket of wss.clients) { clearTimeout(socket.handshakeTimer); socket.terminate(); }
      await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })]);
      for (const session of this.sessions.values()) { session.socket = null; session.disconnectedAtMs = this.now(); }
    })();
    try { await this.closing; } finally { this.closing = null; }
  }

  providerStatus() {
    return { ok: true, running: Boolean(this.server), providerEpoch: this.epoch, port: this.server ? this.port : null,
      sessionCount: this.sessions.size, pendingCount: this.pendingCommands.size, limits,
      captureSource: 'host-fact-store', persistence: 'synchronous-ingress', updatedAtMs: this.now() };
  }
  connectInfo() {
    if (!this.server) return failure('web_provider_not_running');
    const host = this.config.host.includes(':') ? `[${this.config.host}]` : this.config.host;
    return { ...this.providerStatus(), endpoint: `ws://${host}:${this.port}${this.config.path}`, token: this.token, protocol };
  }
  listSessions() {
    this.sweep(); const sessions = [...this.sessions.values()].map(session => this.sessionSummary(session));
    return { ok: true, running: Boolean(this.server), sessions, count: sessions.length };
  }
  sessionSummary(session) {
    return { ...targetOf(session), connected: session.socket?.readyState === 1, appName: session.appName,
      url: session.url, origin: session.origin, route: session.route, connectedAtMs: session.connectedAtMs,
      lastSeenAtMs: session.lastSeenAtMs, disconnectedAtMs: session.disconnectedAtMs,
      capture: { accepted: session.accepted, rejected: session.rejected, lastReceipt: session.lastReceipt },
      executionSchema, domTargetSchema, captureSource: 'host-fact-store' };
  }
  sweep() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (!session.socket && now - session.disconnectedAtMs >= limits.inactiveSessionMs) this.sessions.delete(id);
      else if (session.socket && now - session.lastSeenAtMs > 60000) session.socket.terminate();
      else if (session.socket && now - (session.lastPingAtMs ?? 0) > 20000) { session.lastPingAtMs = now; session.socket.ping(); }
    }
  }
  requireSession(args, requireEpoch = true) {
    if (!text(args.sessionId)) throw new CommandError('web_session_required', 'An explicit sessionId is required.');
    const session = this.sessions.get(args.sessionId);
    if (!session) throw new CommandError('web_session_not_found', 'No retained session metadata matches this sessionId.');
    if (requireEpoch && (args.runtimeEpoch !== session.runtimeEpoch || (args.targetId ?? 'main') !== session.targetId))
      throw new CommandError('web_target_changed', 'Observe the session and use its exact document runtimeEpoch and targetId.');
    return session;
  }
  connected(args) {
    const session = this.requireSession(args);
    if (!session.socket || session.socket.readyState !== 1) throw new CommandError('web_target_disconnected', 'Live reads and actions require the original connected document. Use explicit history for retained facts.');
    return session;
  }

  async captureResponse(args, stream) {
    const target = targetOf(args);
    const history = args.history === true || args.view === 'connected-history';
    let result;
    if (stream === 'dom' || history) {
      if (!history) this.connected(args);
      result = this.store.read(target, stream, args);
      if (stream !== 'dom' && result.ok) result = { ...result, refs: result.items.map(item => item.ref), stream,
        coverage: { status: 'partial', gap: result.gap, committed: true, scope: 'retained-host-history', reasons: ['live_capture_barrier_required'] } };
    } else {
      const session = this.connected(args);
      let through;
      if (args.throughCursor !== undefined) through = this.store.captureBarrier(target, stream, args.throughCursor);
      else {
        const response = await this.request(session, 'read', { name: 'captureBarrier', args: { stream } }, args.timeoutMs ?? 5000);
        if (response.ok !== true) return response;
        through = response.barrier;
      }
      result = this.store.readWindow(target, stream, args, through);
    }
    return { ...result, connected: this.sessions.get(args.sessionId)?.runtimeEpoch === args.runtimeEpoch
      && this.sessions.get(args.sessionId)?.socket?.readyState === 1 };
  }
  async dom(args) {
    const session = this.connected(args);
    const result = await this.request(session, 'read', { name: 'domSnapshot', args: select(args, ['selector', 'maxControls']) }, args.timeoutMs ?? 5000);
    if (result.ok !== true || !object(result.dom) || result.dom.ok !== true)
      return failure(result.error || result.dom?.error || 'invalid_web_dom', { ...targetOf(session) });
    try { validateSnapshot(result.dom, targetOf(session)); }
    catch (error) { return failure('invalid_web_dom_target', { ...targetOf(session), message: error.message }); }
    const receipt = this.store.record(targetOf(session), 'dom', result.dom, { captureId: randomUUID() });
    return { ok: true, ...targetOf(session), connected: true, webTargetSchema: result.dom.targetSchema,
      pageRef: result.dom.pageRef, dom: result.dom, receipt };
  }

  async command(args) {
    const session = this.connected(args), target = targetOf(session);
    if (readCommands.has(args.name)) return this.dom({ ...args, ...args.arguments });
    const owner = this.owner();
    const result = await owner.run(sessionKey(session.sessionId), () => runDeviceEffect({ kind: 'web-sdk',
      actionId: args.runtimeActionId ?? randomUUID(), runtimeEpoch: target.runtimeEpoch, target }, async () => {
      const original = owner.status(sessionKey(session.sessionId)).ownership.pending;
      const value = await managed.executeManagedAction({ kind: 'web', schema: executionSchema,
        runtime: { runtimeEpoch: target.runtimeEpoch, executionSchema }, payload: { command: { name: args.name, args: args.arguments ?? {} }, target },
        actionId: original.actionId, timeoutMs: args.timeoutMs ?? 5000,
        send: request => this.request(session, 'command', request, args.timeoutMs ?? 5000),
        cancel: identity => withoutExecution(() => runExecution({ timeoutMs: 2000 }, async () => {
          const stored = this.store.completion(target, identity.actionId);
          if (stored.ok) return stored;
          try { await this.request(this.connected(target), 'cancel', identity, 1500); } catch { /* Only an original committed result can settle. */ }
          return this.store.completion(target, identity.actionId);
        })),
      });
      return { ...value, ...target, command: args.name };
    }, value => value.executionReceipt));
    return webOwnershipResult(result);
  }

  async executionControl(args) {
    const owner = this.owner(), key = sessionKey(args.sessionId), target = targetOf(args);
    if (args.operation === 'status') return { ok: true, ...target, ownership: owner.status(key),
      connected: this.sessions.get(args.sessionId)?.runtimeEpoch === args.runtimeEpoch && this.sessions.get(args.sessionId)?.socket?.readyState === 1 };
    if (args.operation === 'reconcile') return webOwnershipResult(await owner.reconcile(key, async pending => {
      if (pending.kind !== 'web-sdk' || !isDeepStrictEqual(pending.target, target)) return { settled: false, error: 'web_original_target_required' };
      const found = this.store.completion(target, pending.actionId);
      if (!found.ok || found.receipt.stored !== true) return { settled: false, error: found.error };
      return completionProof(found.executionResult, pending, target) ?? { settled: false, error: 'invalid_web_completion' };
    }));
    if (args.operation === 'cancel') {
      const found = this.store.completion(target, args.actionId);
      if (found.ok) return found;
      await this.request(this.connected(args), 'cancel', { actionId: args.actionId, runtimeEpoch: args.runtimeEpoch }, args.timeoutMs ?? 2000);
    }
    return this.store.completion(target, args.actionId);
  }

  request(session, type, payload, timeoutMs) {
    checkExecution();
    const socket = session.socket, binding = socket?.binding;
    if (!socket || socket.readyState !== 1) throw new CommandError('web_target_disconnected', 'The original document is disconnected.', { dispatched: false, ambiguous: false });
    if (this.pendingCommands.size >= limits.pending) throw new CommandError('web_pending_limit', 'The provider has reached its pending request limit.', { dispatched: false, ambiguous: false });
    const requestId = randomUUID(), wire = JSON.stringify({ type, requestId, binding, payload });
    if (Buffer.byteLength(wire) > limits.messageBytes || socket.bufferedAmount > limits.socketBytes)
      throw new CommandError('web_transport_capacity', 'The Web request or socket buffer exceeds its byte limit.', { dispatched: false, ambiguous: false });
    const scope = currentExecution();
    return new Promise((resolve, reject) => {
      let sent = false;
      const end = (error, result) => { clearTimeout(timer); scope?.signal.removeEventListener('abort', abort);
        this.pendingCommands.delete(requestId); error ? reject(error) : resolve(result); };
      const fail = code => end(new CommandError(code, 'The original Web request did not return a confirmed result.', { dispatched: sent ? null : false, ambiguous: sent, settled: false }));
      const abort = () => fail(scope.signal.reason?.code || 'runtime_stopped');
      const duration = Math.max(1, Math.min(timeoutMs, scope ? scope.deadlineMs - Date.now() : timeoutMs));
      const timer = setTimeout(() => fail('web_command_timeout'), duration);
      this.pendingCommands.set(requestId, { socket, binding, type, payload, fail, resolve: result => end(null, result) });
      scope?.signal.addEventListener('abort', abort, { once: true });
      if (scope?.signal.aborted) { abort(); return; }
      sent = true;
      // Acquiring evidence must not mark the enclosing UI action as dispatched.
      if (!(type === 'read' && payload.name === 'uiObservation')) markExecutionDispatched();
      try { socket.send(wire, error => { if (error && this.pendingCommands.has(requestId)) fail('web_command_transport_lost'); }); }
      catch { fail('web_command_transport_lost'); }
    });
  }

  handleHttp(request, response) {
    const route = request.url;
    if (request.method !== 'GET' || !['/health', '/sessions'].includes(route)) { response.writeHead(404); response.end(); return; }
    if (route === '/sessions' && request.headers['x-ai-app-bridge-token'] !== this.token) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(route === '/health' ? this.providerStatus() : this.listSessions()));
  }
  handleConnection(socket) {
    socket.handshakeTimer = setTimeout(() => socket.terminate(), limits.handshakeMs);
    socket.on('message', raw => {
      try { this.handleSocketMessage(socket, JSON.parse(raw.toString())); }
      catch (error) { this.send(socket, { type: 'error', error: error.code || 'invalid_web_message' }); socket.close(1008, 'invalid_web_message'); }
    });
    socket.on('close', () => this.markSocketClosed(socket));
    socket.on('error', () => this.markSocketClosed(socket));
    socket.on('pong', () => { const session = this.sessionForSocket(socket); if (session) session.lastSeenAtMs = this.now(); });
  }
  send(socket, value) {
    const wire = JSON.stringify(value);
    if (socket.readyState !== 1) return;
    if (Buffer.byteLength(wire) > limits.messageBytes || socket.bufferedAmount > limits.socketBytes) { socket.terminate(); return; }
    socket.send(wire);
  }
  handleSocketMessage(socket, message) {
    if (!object(message)) throw new CommandError('invalid_web_message', 'A Web protocol object is required.');
    if (message.type === 'hello') { this.registerSession(socket, message); return; }
    const session = this.sessionForSocket(socket);
    if (!session || !isDeepStrictEqual(message.binding, socket.binding)) throw new CommandError('web_binding_mismatch', 'The message is not from the current bound socket.');
    session.lastSeenAtMs = this.now();
    if (message.type === 'capture') {
      if (!['logs', 'network', 'state', 'events'].includes(message.stream) || !object(message.item) || !text(message.captureId)
          || !Number.isSafeInteger(message.sequence) || message.sequence < 1
          || !['explicit', 'synchronous', 'unattributed'].includes(message.item.association)
          || (message.actionId !== undefined && message.actionId !== null && !text(message.actionId))) throw new CommandError('invalid_web_capture', 'Capture identity and item are required.');
      if (message.stream === 'state' && (!text(message.item.namespace) || !text(message.item.key) || !Object.hasOwn(message.item, 'value')))
        throw new CommandError('invalid_web_state', 'State requires namespace, key and value.');
      const counters = session.captures[message.stream];
      if (message.sequence <= counters.lastSequence) throw new CommandError('invalid_web_capture_sequence', 'Capture sequences must increase within the original connection.');
      counters.lastSequence = message.sequence;
      try {
        const receipt = this.store.record(targetOf(session), message.stream, { ...message.item, sourceSequence: message.sequence },
          { captureId: message.captureId, actionId: message.actionId });
        session.accepted++; counters.accepted++; session.lastReceipt = receipt;
        this.send(socket, { type: 'captureAck', binding: socket.binding, captureId: message.captureId, receipt });
      } catch (error) { session.rejected++; counters.rejected++; this.send(socket, { type: 'captureAck', binding: socket.binding, captureId: message.captureId,
        error: error.code || 'web_persistence_unavailable', receipt: { stored: false } }); }
      return;
    }
    if (message.type === 'completion') { this.acceptCompletion(session, message); return; }
    if (message.type !== 'response' || !text(message.requestId) || !object(message.result) || typeof message.result.ok !== 'boolean')
      throw new CommandError('invalid_web_response', 'A typed response is required.');
    const pending = this.pendingCommands.get(message.requestId);
    if (!pending || pending.socket !== socket || !isDeepStrictEqual(pending.binding, socket.binding)) return;
    if (pending.type === 'command' && message.result.dispatched !== false)
      throw new CommandError('invalid_web_response', 'Dispatched actions must supply their original completion.');
    if (pending.type === 'read' && pending.payload.name === 'captureBarrier' && message.result.ok) {
      const result = message.result, stream = pending.payload.args.stream;
      if (result.schemaVersion !== 'aab.web-capture/v1' || result.stream !== stream
        || !isDeepStrictEqual(result.target, targetOf(session))
        || !['sequence', 'losses', 'pending'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0))
        throw new CommandError('invalid_web_capture_barrier', 'The capture barrier must bind this document and stream.');
      // Freeze at receipt, before a later WebSocket frame can add more facts.
      try {
        const barrier = this.store.saveCaptureBarrier(targetOf(session), stream, {
          connectionId: socket.binding.connectionId,
          sdk: { sequence: result.sequence, losses: result.losses, pending: result.pending },
          host: { ...session.captures[stream] } });
        pending.resolve({ ok: true, barrier });
      } catch (error) { pending.resolve(failure(error.code || 'web_capture_barrier_failed', { message: error.message })); }
      return;
    }
    pending.resolve(message.result);
  }
  acceptCompletion(session, message) {
    const target = targetOf(session), result = message.result;
    const identity = { actionId: result?.actionId, runtimeEpoch: session.runtimeEpoch };
    if (!text(identity.actionId) || !completionProof(result, identity, target)) throw new CommandError('invalid_web_completion', 'Completion must bind the original action and document.');
    const previous = this.store.completion(target, identity.actionId);
    if (previous.ok) {
      if (previous.receipt.originalSha256 !== digest(result)) throw new CommandError('web_completion_conflict', 'The original action already has a different completion.');
    } else {
      const pending = this.owner().status(sessionKey(session.sessionId)).ownership?.pending;
      if (pending?.kind !== 'web-sdk' || pending.actionId !== identity.actionId || pending.runtimeEpoch !== identity.runtimeEpoch
          || !isDeepStrictEqual(pending.target, target)) throw new CommandError('web_original_action_required', 'No original pending action matches this completion.');
    }
    try { if (!previous.ok) this.store.saveCompletion(target, result); }
    catch (error) { this.send(session.socket, { type: 'completionAck', binding: session.socket.binding, actionId: identity.actionId,
      stored: false, error: error.code || 'web_persistence_unavailable' }); return; }
    this.send(session.socket, { type: 'completionAck', binding: session.socket.binding, actionId: identity.actionId, stored: true });
    for (const pending of [...this.pendingCommands.values()]) {
      if (pending.socket === session.socket && pending.type === 'command' && pending.payload.actionId === identity.actionId) pending.resolve(result);
    }
  }
  registerSession(socket, hello) {
    this.sweep();
    if (socket.binding || hello.schemaVersion !== protocol || !text(hello.sessionId) || !text(hello.runtimeEpoch)
        || hello.targetId !== 'main' || hello.executionSchema !== executionSchema || hello.domTargetSchema !== domTargetSchema || !text(hello.appName)
        || typeof hello.url !== 'string' || hello.url.length > 4096 || typeof hello.origin !== 'string' || hello.origin.length > 1024
        || typeof hello.route !== 'string' || hello.route.length > 4096)
      throw new CommandError('invalid_web_hello', 'Use a matching Web v2 SDK with an explicit document identity.');
    const existing = this.sessions.get(hello.sessionId);
    if (existing?.socket) throw new CommandError('web_session_busy', 'Another socket already owns this session.');
    if (!existing && this.sessions.size >= limits.sessions) throw new CommandError('web_session_limit', 'The bounded session registry is full.');
    if (existing && existing.origin !== hello.origin) throw new CommandError('web_session_origin_changed', 'The same session cannot change origin.');
    const session = { ...targetOf(hello), appName: hello.appName, url: hello.url, origin: hello.origin, route: hello.route,
      socket, connectedAtMs: this.now(), lastSeenAtMs: this.now(), disconnectedAtMs: null, accepted: 0, rejected: 0, lastReceipt: null,
      captures: Object.fromEntries(['logs', 'network', 'state', 'events'].map(stream => [stream, { lastSequence: 0, accepted: 0, rejected: 0 }])) };
    socket.binding = { schemaVersion: protocol, providerEpoch: this.epoch, connectionId: randomUUID(), ...targetOf(session) };
    this.sessions.set(hello.sessionId, session); clearTimeout(socket.handshakeTimer);
    this.send(socket, { type: 'helloAck', ok: true, binding: socket.binding, limits });
  }
  sessionForSocket(socket) {
    const session = this.sessions.get(socket.binding?.sessionId);
    return session?.socket === socket ? session : null;
  }
  markSocketClosed(socket) {
    clearTimeout(socket.handshakeTimer);
    const session = this.sessionForSocket(socket);
    if (session) { session.socket = null; session.disconnectedAtMs = this.now(); }
    for (const pending of [...this.pendingCommands.values()]) if (pending.socket === socket) pending.fail('web_connection_lost');
  }
}

function completionProof(result, identity, target) {
  if (!managed.terminalReceipt(executionSchema, result, identity) || !isDeepStrictEqual(result.execution.target, target)) return null;
  return managed.settlementProof('web-sdk', executionSchema, result, identity);
}
function webOwnershipResult(result) {
  if (!['target_busy', 'device_ownership_unresolved'].includes(result.error)) return result;
  return { ...result, error: result.error === 'target_busy' ? 'web_target_busy' : 'web_execution_unresolved',
    message: 'The Web session has another active or unresolved action. Read web-execution and recover the original completion before another action.' };
}
function select(value, fields) { return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])); }

module.exports = { WebBridgeProvider, protocol, executionSchema, limits };
