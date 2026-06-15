(function initAiAppBridgeWeb(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.AiAppBridgeWeb = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  const defaultControlSelector = 'a,button,input,textarea,select,[role],[onclick],[aria-label]';
  const maxCaptureText = 12000;

  function createAiAppBridge(options = {}) {
    const state = {
      options,
      socket: null,
      queue: [],
      started: false,
      connected: false,
      sessionId: options.sessionId || storedSessionId(options.storageKey || 'ai_app_bridge_web_session_id'),
      actions: new Map(),
      stateProviders: new Map(),
      restores: [],
    };

    const api = {
      start,
      disconnect,
      recordLog,
      recordNetwork,
      recordState,
      recordEvent,
      registerAction,
      unregisterAction,
      registerStateProvider,
      snapshotDom: (snapshotOptions) => snapshotDom(snapshotOptions),
      sessionId: () => state.sessionId,
      isConnected: () => state.connected,
    };

    function start() {
      if (state.started) return api;
      state.started = true;
      installCaptures();
      connect();
      return api;
    }

    function disconnect() {
      state.started = false;
      state.connected = false;
      for (const restore of state.restores.splice(0)) {
        try {
          restore();
        } catch (_) {
          // Best-effort cleanup only.
        }
      }
      if (state.socket) {
        try {
          state.socket.close();
        } catch (_) {
          // Ignore close failures.
        }
      }
      state.socket = null;
    }

    function connect() {
      const endpoint = options.endpoint;
      if (!endpoint) throw new Error('AiAppBridge endpoint is required');
      const WebSocketCtor = options.WebSocket || globalValue('WebSocket');
      if (!WebSocketCtor) throw new Error('WebSocket is not available');
      const socket = new WebSocketCtor(withToken(endpoint, options.token));
      state.socket = socket;
      socket.onopen = () => {
        state.connected = true;
        send({
          type: 'hello',
          sessionId: state.sessionId,
          appName: options.appName || documentTitle(),
          url: locationHref(),
          origin: locationOrigin(),
          route: locationPath(),
          targetId: 'main',
          capabilities: {
            logs: true,
            network: true,
            state: true,
            events: true,
            dom: true,
            command: true,
          },
        });
        flushQueue();
      };
      socket.onmessage = (event) => handleServerMessage(event.data);
      socket.onclose = () => {
        state.connected = false;
        if (state.started && options.reconnect !== false) {
          setTimeout(connect, Number(options.reconnectDelayMs || 1000));
        }
      };
      socket.onerror = () => {
        state.connected = false;
      };
    }

    function send(payload) {
      const text = JSON.stringify(payload);
      if (state.socket && state.socket.readyState === 1) {
        state.socket.send(text);
        return;
      }
      state.queue.push(text);
      while (state.queue.length > 100) state.queue.shift();
    }

    function flushQueue() {
      while (state.queue.length && state.socket && state.socket.readyState === 1) {
        state.socket.send(state.queue.shift());
      }
    }

    function capture(stream, item) {
      send({
        type: 'capture',
        stream,
        item: {
          source: 'web-sdk',
          timestampMs: Date.now(),
          url: locationHref(),
          route: locationPath(),
          ...item,
        },
      });
    }

    function recordLog(level, tag, message, data) {
      capture('logs', {
        level: level || 'info',
        tag: tag || 'web',
        message: trimText(message),
        data,
        source: 'web-sdk',
      });
    }

    function recordNetwork(record) {
      capture('network', {
        method: record.method || 'GET',
        url: record.url || '',
        statusCode: record.statusCode === undefined ? -1 : record.statusCode,
        durationMs: record.durationMs === undefined ? -1 : record.durationMs,
        requestHeaders: record.requestHeaders,
        responseHeaders: record.responseHeaders,
        requestBody: trimText(record.requestBody),
        responseBody: trimText(record.responseBody),
        error: record.error,
        redacted: true,
        source: record.source || 'web-sdk',
      });
    }

    function recordState(namespace, key, value) {
      capture('state', {
        namespace: namespace || 'app',
        key: key || 'value',
        value,
      });
    }

    function recordEvent(category, name, data) {
      capture('events', {
        category: category || 'app',
        name: name || 'event',
        data,
      });
    }

    function registerAction(name, handler) {
      if (!name || typeof handler !== 'function') {
        throw new Error('registerAction requires a name and handler');
      }
      state.actions.set(String(name), handler);
      return api;
    }

    function unregisterAction(name) {
      state.actions.delete(String(name));
      return api;
    }

    function registerStateProvider(name, provider) {
      if (!name || typeof provider !== 'function') {
        throw new Error('registerStateProvider requires a name and provider');
      }
      state.stateProviders.set(String(name), provider);
      return api;
    }

    async function handleServerMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (message.type !== 'command') return;
      const command = message.command || {};
      try {
        const result = await runCommand(command);
        send({
          type: 'commandResult',
          commandId: message.commandId,
          ok: result && result.ok === false ? false : true,
          result,
        });
      } catch (error) {
        send({
          type: 'commandResult',
          commandId: message.commandId,
          ok: false,
          error: error.message || String(error),
        });
      }
    }

    async function runCommand(command) {
      const args = command.args || {};
      switch (command.name) {
        case 'domSnapshot': {
          const dom = snapshotDom(args);
          send({ type: 'dom', targetId: command.targetId || 'main', dom });
          return { ok: true, dom };
        }
        case 'click':
          return clickElement(args);
        case 'input':
          return inputElement(args);
        case 'waitFor':
          return waitFor(args);
        case 'scroll':
          return scrollTarget(args);
        case 'state': {
          const values = {};
          for (const [name, provider] of state.stateProviders.entries()) {
            values[name] = await provider();
          }
          return { ok: true, values };
        }
        case 'action': {
          const actionName = args.name || args.action;
          const handler = state.actions.get(String(actionName || ''));
          if (!handler) return { ok: false, error: 'action_not_registered', action: actionName || '' };
          return { ok: true, value: await handler(args.arguments || args) };
        }
        default: {
          const handler = state.actions.get(String(command.name || ''));
          if (!handler) return { ok: false, error: 'unknown_command', command: command.name || '' };
          return { ok: true, value: await handler(args) };
        }
      }
    }

    function installCaptures() {
      const captureOptions = options.capture || {};
      if (captureOptions.console) installConsoleCapture(state, recordLog);
      if (captureOptions.errors) installErrorCapture(state, recordLog);
      if (captureOptions.fetch) installFetchCapture(state, recordNetwork, options);
      if (captureOptions.xhr) installXhrCapture(state, recordNetwork);
    }

    return api;
  }

  function snapshotDom(options = {}) {
    const doc = options.document || globalValue('document');
    if (!doc || !doc.querySelectorAll) {
      return { ok: false, error: 'document_unavailable' };
    }
    const selector = options.selector || defaultControlSelector;
    const maxControls = Number(options.maxControls || 200);
    const controls = [];
    const elements = Array.prototype.slice.call(doc.querySelectorAll(selector), 0, maxControls);
    elements.forEach((element, index) => {
      controls.push({
        index,
        tag: text(element.tagName).toLowerCase(),
        id: text(element.id),
        name: attr(element, 'name'),
        type: attr(element, 'type'),
        role: attr(element, 'role'),
        ariaLabel: attr(element, 'aria-label'),
        placeholder: attr(element, 'placeholder'),
        text: trimText(element.innerText || element.value || element.title || attr(element, 'aria-label'), 300),
        href: trimText(element.href, 500),
        disabled: Boolean(element.disabled),
        bounds: bounds(element),
      });
    });
    return {
      ok: true,
      title: text(doc.title),
      url: locationHref(),
      readyState: text(doc.readyState),
      bodyText: trimText(doc.body && doc.body.innerText, 20000),
      controls,
      controlCount: controls.length,
      updatedAtMs: Date.now(),
    };
  }

  function clickElement(args = {}) {
    const element = findElement(args);
    if (!element) return { ok: false, error: 'element_not_found' };
    element.click();
    return { ok: true };
  }

  function inputElement(args = {}) {
    const element = findElement(args);
    if (!element) return { ok: false, error: 'element_not_found' };
    const value = args.value === undefined ? '' : String(args.value);
    element.focus && element.focus();
    element.value = value;
    dispatchInputEvents(element);
    return { ok: true, value };
  }

  function waitFor(args = {}) {
    const timeoutMs = Number(args.timeoutMs || 5000);
    const startedAtMs = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (args.selector && findElement({ selector: args.selector })) {
          resolve({ ok: true, matched: 'selector' });
          return;
        }
        if (args.targetText && bodyText().includes(String(args.targetText))) {
          resolve({ ok: true, matched: 'text' });
          return;
        }
        if (Date.now() - startedAtMs >= timeoutMs) {
          resolve({ ok: false, error: 'wait_timeout' });
          return;
        }
        setTimeout(tick, Number(args.intervalMs || 250));
      };
      tick();
    });
  }

  function scrollTarget(args = {}) {
    const element = args.selector ? findElement({ selector: args.selector }) : null;
    const deltaX = Number(args.deltaX || 0);
    const deltaY = Number(args.deltaY === undefined ? args.delta || 400 : args.deltaY);
    if (element && element.scrollBy) {
      element.scrollBy(deltaX, deltaY);
      return { ok: true, target: 'element' };
    }
    const win = globalValue('window');
    if (win && win.scrollBy) {
      win.scrollBy(deltaX, deltaY);
      return { ok: true, target: 'window' };
    }
    return { ok: false, error: 'scroll_unavailable' };
  }

  function findElement(args = {}) {
    const doc = args.document || globalValue('document');
    if (!doc) return null;
    if (args.selector) return doc.querySelector(args.selector);
    const targetText = args.targetText === undefined ? '' : String(args.targetText);
    if (!targetText) return null;
    const elements = Array.prototype.slice.call(doc.querySelectorAll(defaultControlSelector), 0, 500);
    return elements.find((element) => elementMatchesText(element, targetText, Boolean(args.exact))) || null;
  }

  function elementMatchesText(element, targetText, exact) {
    const values = [
      element.innerText,
      element.value,
      element.title,
      element.id,
      attr(element, 'name'),
      attr(element, 'role'),
      attr(element, 'aria-label'),
      attr(element, 'placeholder'),
    ].map((value) => text(value)).filter(Boolean);
    return values.some((value) => exact ? value === targetText : value.includes(targetText));
  }

  function installConsoleCapture(state, recordLog) {
    const consoleObject = globalValue('console');
    if (!consoleObject) return;
    ['log', 'info', 'warn', 'error', 'debug'].forEach((method) => {
      const original = consoleObject[method];
      if (typeof original !== 'function') return;
      consoleObject[method] = function capturedConsole(...args) {
        original.apply(consoleObject, args);
        if (!state.started) return;
        recordLog(method === 'log' ? 'info' : method, 'console', args.map(stringifyValue).join(' '), { method });
      };
      state.restores.push(() => {
        consoleObject[method] = original;
      });
    });
  }

  function installErrorCapture(state, recordLog) {
    const win = globalValue('window');
    if (!win || !win.addEventListener) return;
    const onError = (event) => {
      recordLog('error', 'window.onerror', event.message || 'error', {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    };
    const onRejection = (event) => {
      recordLog('error', 'unhandledrejection', stringifyValue(event.reason));
    };
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    state.restores.push(() => {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
    });
  }

  function installFetchCapture(state, recordNetwork, options) {
    const win = globalValue('window');
    if (!win || typeof win.fetch !== 'function') return;
    const original = win.fetch;
    win.fetch = async function capturedFetch(input, init = {}) {
      const startedAtMs = Date.now();
      const method = (init && init.method) || (input && input.method) || 'GET';
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        const response = await original.apply(this, arguments);
        let responseBody;
        if (options.captureResponseBodies && response.clone) {
          try {
            responseBody = await response.clone().text();
          } catch (_) {
            responseBody = undefined;
          }
        }
        recordNetwork({
          source: 'fetch-auto',
          method,
          url,
          statusCode: response.status,
          durationMs: Date.now() - startedAtMs,
          responseBody,
        });
        return response;
      } catch (error) {
        recordNetwork({
          source: 'fetch-auto',
          method,
          url,
          statusCode: -1,
          durationMs: Date.now() - startedAtMs,
          error: error.message || String(error),
        });
        throw error;
      }
    };
    state.restores.push(() => {
      win.fetch = original;
    });
  }

  function installXhrCapture(state, recordNetwork) {
    const win = globalValue('window');
    if (!win || !win.XMLHttpRequest) return;
    const Xhr = win.XMLHttpRequest;
    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    Xhr.prototype.open = function capturedOpen(method, url) {
      this.__aiAppBridge = { method, url };
      return originalOpen.apply(this, arguments);
    };
    Xhr.prototype.send = function capturedSend(body) {
      const meta = this.__aiAppBridge || {};
      const startedAtMs = Date.now();
      this.addEventListener('loadend', () => {
        recordNetwork({
          source: 'xhr-auto',
          method: meta.method || 'GET',
          url: meta.url || '',
          statusCode: this.status,
          durationMs: Date.now() - startedAtMs,
          requestBody: trimText(body),
          responseBody: trimText(this.responseText),
        });
      });
      return originalSend.apply(this, arguments);
    };
    state.restores.push(() => {
      Xhr.prototype.open = originalOpen;
      Xhr.prototype.send = originalSend;
    });
  }

  function withToken(endpoint, token) {
    if (!token) return endpoint;
    const base = locationHref() || 'http://127.0.0.1';
    const url = new URL(endpoint, base);
    url.searchParams.set('token', token);
    return url.toString();
  }

  function storedSessionId(key) {
    const storage = globalValue('sessionStorage');
    const existing = storage && storage.getItem(key);
    if (existing) return existing;
    const next = `web-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    if (storage) storage.setItem(key, next);
    return next;
  }

  function dispatchInputEvents(element) {
    const win = globalValue('window');
    if (!win || typeof win.Event !== 'function') return;
    element.dispatchEvent(new win.Event('input', { bubbles: true }));
    element.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  function bounds(element) {
    if (!element || !element.getBoundingClientRect) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  function attr(element, name) {
    return element && element.getAttribute ? text(element.getAttribute(name)) : '';
  }

  function bodyText() {
    const doc = globalValue('document');
    return text(doc && doc.body && doc.body.innerText);
  }

  function documentTitle() {
    const doc = globalValue('document');
    return text(doc && doc.title) || 'web-app';
  }

  function locationHref() {
    const location = globalValue('location');
    return text(location && location.href);
  }

  function locationOrigin() {
    const location = globalValue('location');
    return text(location && location.origin);
  }

  function locationPath() {
    const location = globalValue('location');
    if (!location) return '';
    return `${location.pathname || ''}${location.search || ''}${location.hash || ''}`;
  }

  function trimText(value, max = maxCaptureText) {
    const raw = text(value);
    return raw.length > max ? raw.slice(0, max) : raw;
  }

  function text(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function stringifyValue(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }

  function globalValue(name) {
    return typeof globalThis !== 'undefined' ? globalThis[name] : undefined;
  }

  return {
    createAiAppBridge,
    snapshotDom,
  };
}));
