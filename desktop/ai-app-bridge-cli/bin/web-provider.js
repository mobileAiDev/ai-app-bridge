const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const defaultHost = '127.0.0.1';
const defaultPort = 18180;
const defaultPath = '/ai-app-bridge-web';
const maxCaptureEntries = 500;
const defaultCommandTimeoutMs = 5000;

class WebBridgeProvider {
  constructor() {
    this.server = null;
    this.wss = null;
    this.host = defaultHost;
    this.port = defaultPort;
    this.path = defaultPath;
    this.token = '';
    this.sessions = new Map();
    this.pendingCommands = new Map();
    this.captureSequence = 0;
  }

  async run(command, args = {}) {
    switch (command) {
      case 'web-provider-status':
        return this.providerStatus();
      case 'web-session-start':
        return this.start(args);
      case 'web-connect-info':
        return this.connectInfo();
      case 'web-sessions':
        return this.listSessions();
      case 'web-status':
        return this.sessionStatus(args);
      case 'web-dom':
        return this.dom(args);
      case 'web-logs':
        return this.captureResponse(args, 'logs');
      case 'web-network':
        return this.captureResponse(args, 'network');
      case 'web-state':
        return this.stateResponse(args);
      case 'web-events':
        return this.captureResponse(args, 'events');
      case 'web-command':
        return this.command(args);
      case 'web-click':
        return this.command({ ...args, name: 'click' });
      case 'web-input':
        return this.command({ ...args, name: 'input' });
      case 'web-wait':
        return this.command({ ...args, name: 'waitFor' });
      case 'web-scroll':
        return this.command({ ...args, name: 'scroll' });
      default:
        return { ok: false, error: 'unknown_web_command', command };
    }
  }

  async start(args = {}) {
    if (this.server) {
      return { ok: true, alreadyRunning: true, ...this.connectInfo() };
    }

    this.host = stringArg(args.host, defaultHost);
    this.port = numberArg(args.webPort, numberArg(args.port, defaultPort));
    this.path = stringArg(args.path, defaultPath);
    this.token = stringArg(args.token, randomToken());

    this.server = http.createServer((request, response) => this.handleHttp(request, response));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server = null;
        this.wss = null;
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        const address = this.server.address();
        this.port = typeof address === 'object' && address ? address.port : this.port;
        resolve();
      });
    });

    return { ok: true, started: true, ...this.connectInfo() };
  }

  providerStatus() {
    return {
      ok: true,
      running: Boolean(this.server),
      host: this.host,
      port: this.server ? this.port : null,
      path: this.path,
      sessionCount: this.sessions.size,
      updatedAtMs: Date.now(),
    };
  }

  connectInfo() {
    if (!this.server) {
      return {
        ok: false,
        running: false,
        error: 'web_provider_not_running',
        suggestion: 'Run web-session-start first.',
      };
    }
    const endpoint = `ws://${this.host}:${this.port}${this.path}`;
    return {
      ok: true,
      running: true,
      endpoint,
      httpEndpoint: `http://${this.host}:${this.port}`,
      token: this.token,
      sessionCount: this.sessions.size,
      updatedAtMs: Date.now(),
    };
  }

  listSessions() {
    return {
      ok: true,
      running: Boolean(this.server),
      sessions: [...this.sessions.values()].map((session) => this.sessionSummary(session)),
      count: this.sessions.size,
      updatedAtMs: Date.now(),
    };
  }

  sessionStatus(args = {}) {
    const session = this.requireSession(args);
    if (!session.ok) return session;
    return {
      ok: true,
      session: this.sessionSummary(session.value),
      capture: captureCounts(session.value),
      updatedAtMs: Date.now(),
    };
  }

  async dom(args = {}) {
    const sessionResult = this.requireSession(args);
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.value;
    const targetId = stringArg(args.targetId, 'main');
    const refresh = args.refresh !== false;
    if (refresh && session.socket?.readyState === 1) {
      try {
        const result = await this.sendCommand(session, {
          name: 'domSnapshot',
          targetId,
          args: {
            selector: args.selector,
            maxControls: args.maxControls,
          },
        }, numberArg(args.timeoutMs, defaultCommandTimeoutMs));
        const dom = result.dom || result.value || result;
        if (dom && typeof dom === 'object') {
          session.domByTarget.set(targetId, { ...dom, targetId, updatedAtMs: Date.now() });
        }
      } catch (error) {
        if (!session.domByTarget.has(targetId)) {
          return { ok: false, error: 'web_dom_unavailable', message: error.message };
        }
      }
    }
    const dom = session.domByTarget.get(targetId);
    if (!dom) {
      return { ok: false, error: 'web_dom_absent', sessionId: session.sessionId, targetId };
    }
    return {
      ok: true,
      sessionId: session.sessionId,
      targetId,
      dom,
      updatedAtMs: Date.now(),
    };
  }

  captureResponse(args = {}, stream) {
    const sessionResult = this.requireSession(args);
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.value;
    const filter = captureFilter(args);
    const source = session.captures[stream] || [];
    const filtered = source.filter((item) => captureMatches(item, filter));
    const items = filtered.length > filter.limit ? filtered.slice(-filter.limit) : filtered;
    return {
      ok: true,
      type: stream,
      sessionId: session.sessionId,
      items: items.map((item) => ({ ...item })),
      count: items.length,
      sinceId: filter.sinceId ?? null,
      sinceMs: filter.sinceMs ?? null,
      limit: filter.limit,
      updatedAtMs: Date.now(),
    };
  }

  stateResponse(args = {}) {
    const sessionResult = this.requireSession(args);
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.value;
    const filter = captureFilter(args);
    const values = {};
    const items = [];
    for (const [key, item] of session.stateEntries.entries()) {
      if (!captureMatches(item, filter)) continue;
      values[key] = item.value;
      items.push({ ...item });
    }
    const limited = items.length > filter.limit ? items.slice(-filter.limit) : items;
    return {
      ok: true,
      type: 'state',
      sessionId: session.sessionId,
      values,
      items: limited,
      count: limited.length,
      sinceId: filter.sinceId ?? null,
      sinceMs: filter.sinceMs ?? null,
      limit: filter.limit,
      updatedAtMs: Date.now(),
    };
  }

  async command(args = {}) {
    const sessionResult = this.requireSession(args);
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.value;
    const name = stringArg(args.name || args.action || args.webCommand, '');
    if (!name) {
      return { ok: false, error: 'web_command_name_required' };
    }
    try {
      const result = await this.sendCommand(session, {
        name,
        targetId: stringArg(args.targetId, 'main'),
        args: args.arguments && typeof args.arguments === 'object' ? args.arguments : commandArgs(args),
      }, numberArg(args.timeoutMs, defaultCommandTimeoutMs));
      return {
        ok: result.ok !== false,
        sessionId: session.sessionId,
        targetId: stringArg(args.targetId, 'main'),
        command: name,
        result,
        updatedAtMs: Date.now(),
      };
    } catch (error) {
      return {
        ok: false,
        error: 'web_command_failed',
        message: error.message,
        sessionId: session.sessionId,
        command: name,
      };
    }
  }

  sendCommand(session, command, timeoutMs) {
    if (!session.socket || session.socket.readyState !== 1) {
      return Promise.reject(new Error('web_session_not_connected'));
    }
    const commandId = `web-command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      type: 'command',
      commandId,
      command,
      sentAtMs: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error('web_command_timeout'));
      }, timeoutMs);
      this.pendingCommands.set(commandId, {
        sessionId: session.sessionId,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      session.socket.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        const pending = this.pendingCommands.get(commandId);
        this.pendingCommands.delete(commandId);
        if (pending) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  handleHttp(request, response) {
    setCors(response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/health')) {
      writeJson(response, this.providerStatus());
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/sessions')) {
      writeJson(response, this.listSessions());
      return;
    }
    writeJson(response, { ok: false, error: 'not_found' }, 404);
  }

  handleConnection(socket, request) {
    const parsed = new URL(request.url || '/', `http://${this.host}:${this.port}`);
    if (parsed.pathname !== this.path) {
      socket.close(1008, 'invalid_path');
      return;
    }
    if (this.token && parsed.searchParams.get('token') !== this.token) {
      socket.close(1008, 'invalid_token');
      return;
    }

    socket.on('message', (raw) => this.handleSocketMessage(socket, raw));
    socket.on('close', () => this.markSocketClosed(socket));
    socket.on('error', () => this.markSocketClosed(socket));
  }

  handleSocketMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_) {
      socket.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      return;
    }
    switch (message.type) {
      case 'hello':
        this.registerSession(socket, message);
        break;
      case 'capture':
        this.recordCapture(socket, message);
        break;
      case 'dom':
        this.recordDom(socket, message);
        break;
      case 'commandResult':
        this.resolveCommand(socket, message);
        break;
      case 'heartbeat':
        this.touchSession(socket);
        break;
      default:
        socket.send(JSON.stringify({ type: 'error', error: 'unknown_message_type', messageType: message.type || '' }));
        break;
    }
  }

  registerSession(socket, message) {
    const sessionId = stringArg(message.sessionId, `web-session-${randomToken(6)}`);
    const targetId = stringArg(message.targetId, 'main');
    const existing = this.sessions.get(sessionId);
    const session = existing || createSession(sessionId);
    session.socket = socket;
    session.connected = true;
    session.appName = stringArg(message.appName, session.appName || '');
    session.url = stringArg(message.url, session.url || '');
    session.origin = stringArg(message.origin, session.origin || '');
    session.route = stringArg(message.route, session.route || '');
    session.capabilities = message.capabilities && typeof message.capabilities === 'object' ? message.capabilities : session.capabilities;
    session.targets.set(targetId, {
      targetId,
      url: session.url,
      origin: session.origin,
      updatedAtMs: Date.now(),
    });
    session.updatedAtMs = Date.now();
    socket.aiAppBridgeSessionId = sessionId;
    this.sessions.set(sessionId, session);
    socket.send(JSON.stringify({
      type: 'helloAck',
      ok: true,
      sessionId,
      targetId,
      serverTimeMs: Date.now(),
    }));
  }

  recordCapture(socket, message) {
    const session = this.sessionForSocket(socket);
    if (!session) return;
    const stream = normalizeStream(message.stream || message.typeName);
    if (!stream) return;
    const rawItem = message.item || message.record || {};
    const item = this.baseRecord(stream, session, rawItem);
    if (stream === 'state') {
      const namespace = stringArg(item.namespace, 'app');
      const key = stringArg(item.key, 'value');
      item.namespace = namespace;
      item.key = key;
      session.stateEntries.set(`${namespace}.${key}`, item);
    } else {
      boundedPush(session.captures[stream], item, maxCaptureEntries);
    }
    session.updatedAtMs = Date.now();
  }

  recordDom(socket, message) {
    const session = this.sessionForSocket(socket);
    if (!session) return;
    const targetId = stringArg(message.targetId, 'main');
    const dom = message.dom && typeof message.dom === 'object' ? message.dom : message;
    session.domByTarget.set(targetId, {
      ...dom,
      targetId,
      sessionId: session.sessionId,
      updatedAtMs: Date.now(),
    });
    session.updatedAtMs = Date.now();
  }

  resolveCommand(socket, message) {
    const pending = this.pendingCommands.get(message.commandId);
    if (!pending) return;
    const session = this.sessionForSocket(socket);
    if (!session || session.sessionId !== pending.sessionId) {
      pending.reject(new Error('web_command_session_mismatch'));
      this.pendingCommands.delete(message.commandId);
      return;
    }
    this.pendingCommands.delete(message.commandId);
    if (message.ok === false) {
      pending.resolve({
        ok: false,
        error: message.error || 'web_command_error',
        value: message.value,
      });
      return;
    }
    pending.resolve(message.result !== undefined ? message.result : { ok: true, value: message.value });
  }

  baseRecord(stream, session, rawItem) {
    const type = stream === 'logs' ? 'log' : stream === 'events' ? 'event' : stream;
    return {
      id: ++this.captureSequence,
      type,
      source: stringArg(rawItem.source, 'web-sdk'),
      timestampMs: numberArg(rawItem.timestampMs, Date.now()),
      sessionId: session.sessionId,
      targetId: stringArg(rawItem.targetId, 'main'),
      ...rawItem,
    };
  }

  requireSession(args = {}) {
    if (!this.server) {
      return { ok: false, error: 'web_provider_not_running', suggestion: 'Run web-session-start first.' };
    }
    const sessionId = stringArg(args.sessionId, '');
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return { ok: false, error: 'web_session_not_found', sessionId };
      return { ok: true, value: session };
    }
    const live = [...this.sessions.values()].filter((session) => session.connected);
    if (live.length === 1) return { ok: true, value: live[0] };
    return {
      ok: false,
      error: live.length === 0 ? 'web_session_required' : 'web_session_ambiguous',
      sessions: live.map((session) => this.sessionSummary(session)),
    };
  }

  sessionForSocket(socket) {
    const sessionId = socket.aiAppBridgeSessionId;
    return sessionId ? this.sessions.get(sessionId) : null;
  }

  touchSession(socket) {
    const session = this.sessionForSocket(socket);
    if (session) session.updatedAtMs = Date.now();
  }

  markSocketClosed(socket) {
    const session = this.sessionForSocket(socket);
    if (!session || session.socket !== socket) return;
    session.connected = false;
    session.socket = null;
    session.updatedAtMs = Date.now();
  }

  sessionSummary(session) {
    return {
      sessionId: session.sessionId,
      appName: session.appName,
      connected: session.connected,
      url: session.url,
      origin: session.origin,
      route: session.route,
      capabilities: session.capabilities,
      targets: [...session.targets.values()],
      capture: captureCounts(session),
      connectedAtMs: session.connectedAtMs,
      updatedAtMs: session.updatedAtMs,
    };
  }
}

function createSession(sessionId) {
  return {
    sessionId,
    appName: '',
    connected: false,
    socket: null,
    url: '',
    origin: '',
    route: '',
    capabilities: {},
    targets: new Map(),
    captures: {
      logs: [],
      network: [],
      events: [],
    },
    stateEntries: new Map(),
    domByTarget: new Map(),
    connectedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

function commandArgs(args) {
  const omitted = new Set(['sessionId', 'targetId', 'name', 'action', 'webCommand', 'timeoutMs']);
  const result = {};
  for (const [key, value] of Object.entries(args)) {
    if (!omitted.has(key)) result[key] = value;
  }
  return result;
}

function captureCounts(session) {
  return {
    logs: session.captures.logs.length,
    network: session.captures.network.length,
    state: session.stateEntries.size,
    events: session.captures.events.length,
    dom: session.domByTarget.size,
  };
}

function captureFilter(args = {}) {
  return {
    sinceId: args.sinceId === undefined ? null : Number(args.sinceId),
    sinceMs: args.sinceMs === undefined ? null : Number(args.sinceMs),
    limit: Number.isInteger(Number(args.limit)) ? Math.max(1, Math.min(Number(args.limit), maxCaptureEntries)) : 200,
  };
}

function captureMatches(item, filter) {
  if (filter.sinceId !== null && Number(item.id) <= filter.sinceId) return false;
  if (filter.sinceMs !== null && Number(item.timestampMs) < filter.sinceMs) return false;
  return true;
}

function normalizeStream(value) {
  const stream = String(value || '').trim();
  if (stream === 'log') return 'logs';
  if (stream === 'event') return 'events';
  if (stream === 'logs' || stream === 'network' || stream === 'state' || stream === 'events') return stream;
  return '';
}

function boundedPush(target, item, maxSize) {
  while (target.length >= maxSize) target.shift();
  target.push(item);
}

function setCors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type,x-ai-app-bridge-token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function writeJson(response, payload, statusCode = 200) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function stringArg(value, fallback) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.trim() ? text : fallback;
}

function numberArg(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

module.exports = {
  WebBridgeProvider,
};
