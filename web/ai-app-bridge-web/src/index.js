(function initAiAppBridgeWeb(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.AiAppBridgeWeb = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  const defaultControlSelector = 'a,button,input,textarea,select,[role],[onclick],[aria-label]';
  const dialogLikeSelector = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const maxCaptureText = 12000;

  function createAiAppBridge(options = {}) {
    const state = {
      options,
      socket: null,
      reconnectTimer: null,
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
      stop: disconnect,
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
      if (state.reconnectTimer !== null) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      for (const restore of state.restores.splice(0)) {
        try {
          restore();
        } catch (_) {
          // Best-effort cleanup only.
        }
      }
      const socket = state.socket;
      state.socket = null;
      if (socket) {
        try {
          socket.close();
        } catch (_) {
          // Ignore close failures.
        }
      }
    }

    function connect() {
      if (!state.started) return;
      const endpoint = options.endpoint;
      if (!endpoint) throw new Error('AiAppBridge endpoint is required');
      const WebSocketCtor = options.WebSocket || globalValue('WebSocket');
      if (!WebSocketCtor) throw new Error('WebSocket is not available');
      const socket = new WebSocketCtor(withToken(endpoint, options.token));
      state.socket = socket;
      socket.onopen = () => {
        if (state.socket !== socket || !state.started) return;
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
        if (state.socket !== socket) return;
        state.connected = false;
        state.socket = null;
        if (state.started && options.reconnect !== false && state.reconnectTimer === null) {
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            if (state.started) connect();
          }, Number(options.reconnectDelayMs || 1000));
        }
      };
      socket.onerror = () => {
        if (state.socket !== socket) return;
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
        // The SDK has not inspected or rewritten arbitrary network payloads.
        // A caller that supplies an already-sanitized record may opt in.
        redacted: record.redacted === true,
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
      if (captureOptions.ui) installUiCapture(state, recordEvent, captureOptions.ui);
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
      const sensitive = isSensitiveInput(element);
      const elementValue = text(element.value);
      controls.push({
        index,
        tag: text(element.tagName).toLowerCase(),
        id: text(element.id),
        name: attr(element, 'name'),
        type: attr(element, 'type'),
        role: attr(element, 'role'),
        ariaLabel: attr(element, 'aria-label'),
        placeholder: attr(element, 'placeholder'),
        text: trimText(
          sensitive
            ? (attr(element, 'aria-label') || attr(element, 'placeholder'))
            : (element.innerText || elementValue || element.title || attr(element, 'aria-label')),
          300,
        ),
        sensitive,
        ...(sensitive ? { valueLength: elementValue.length } : {}),
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
    return { ok: true, target: uiTarget(element) };
  }

  function inputElement(args = {}) {
    const element = findElement(args);
    if (!element) return { ok: false, error: 'element_not_found' };
    const value = args.value === undefined ? '' : String(args.value);
    element.focus && element.focus();
    element.value = value;
    dispatchInputEvents(element);
    const sensitive = isSensitiveInput(element);
    return {
      ok: true,
      sensitive,
      valueLength: value.length,
      ...(sensitive ? {} : { value }),
    };
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

  function installUiCapture(state, recordEvent, captureOption) {
    const options = captureOption === true ? {} : captureOption;
    if (!options || options.enabled === false) return;
    const doc = options.document || globalValue('document');
    if (!doc || typeof doc.addEventListener !== 'function') return;
    const win = options.window || globalValue('window');
    const pending = [];
    const debounceMs = nonNegativeNumber(options.debounceMs, 80);
    const maxBatchSize = positiveInteger(options.maxBatchSize, 50);
    const maxPendingEvents = positiveInteger(options.maxPendingEvents, 200);
    const fingerprintSalt = randomFingerprintSalt();
    let fingerprintSequence = 0;
    let timer = null;
    let droppedEvents = 0;
    let lastRoute = routeFromLocation(win && win.location);
    let domFingerprint = fingerprintDom(doc, win, options, fingerprintSalt);
    domFingerprint.ref = `ui-fp-${++fingerprintSequence}`;
    const dialogStates = new Map();
    for (const dialog of queryElements(doc, dialogLikeSelector)) {
      dialogStates.set(dialog, isDialogActive(dialog));
    }

    const scheduleFlush = () => {
      if (timer === null) timer = setTimeout(flush, debounceMs);
    };
    const flush = (drain = false) => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending.length) return;
      do {
        const events = pending.splice(0, maxBatchSize);
        const dropped = droppedEvents;
        droppedEvents = 0;
        const signals = uiBatchSignals(events);
        recordEvent('ui', 'batch', {
          batchSize: events.length,
          droppedEvents: dropped,
          ...signals,
          events,
        });
      } while (drain && pending.length);
      if (pending.length) scheduleFlush();
    };
    const enqueue = (event) => {
      if (!state.started) return;
      if (pending.length >= maxPendingEvents) {
        pending.shift();
        droppedEvents += 1;
      }
      pending.push({
        timestampMs: Date.now(),
        route: routeFromLocation(win && win.location),
        ...event,
      });
      scheduleFlush();
    };
    const onClick = (event) => {
      enqueue({
        type: 'interaction.click',
        target: uiTarget(event && event.target),
      });
    };
    const enqueueValueEvent = (type, event) => {
      const target = event && event.target;
      const value = text(target && target.value);
      const sensitive = isSensitiveInput(target);
      const item = {
        type,
        target: uiTarget(target),
        changed: true,
        length: value.length,
        sensitive,
      };
      if (!sensitive) item.value = trimText(value, 300);
      enqueue(item);
    };
    const onInput = (event) => enqueueValueEvent('interaction.input', event);
    const onChange = (event) => enqueueValueEvent('interaction.change', event);
    const onFocus = (event) => {
      enqueue({
        type: 'interaction.focus',
        target: uiTarget(event && event.target),
      });
    };
    const onRoute = (navigationType) => {
      const nextRoute = routeFromLocation(win && win.location);
      if (nextRoute === lastRoute) return;
      const previousRoute = lastRoute;
      lastRoute = nextRoute;
      enqueue({
        type: 'route.change',
        navigationType,
        fromRoute: previousRoute,
        toRoute: nextRoute,
      });
    };
    const onPopState = () => onRoute('popstate');
    const onHashChange = () => onRoute('hashchange');
    const onMutations = (records) => {
      if (!state.started) return;
      const previousFingerprint = domFingerprint;
      const nextFingerprint = fingerprintDom(doc, win, options, fingerprintSalt);
      const fingerprintChanged = previousFingerprint.hash !== nextFingerprint.hash;
      nextFingerprint.ref = fingerprintChanged
        ? `ui-fp-${++fingerprintSequence}`
        : previousFingerprint.ref;
      domFingerprint = nextFingerprint;
      const mutations = summarizeMutations(records);
      const dialogTransitions = detectDialogTransitions(records, dialogStates);
      enqueue({
        type: 'dom.mutation',
        mutations,
        fingerprint: {
          // Runtime-local opaque references preserve correlation without
          // publishing a content-derived hash that can be dictionary-enumerated.
          beforeHash: previousFingerprint.ref,
          afterHash: nextFingerprint.ref,
          changed: fingerprintChanged,
        },
        diff: {
          elementCount: nextFingerprint.elementCount - previousFingerprint.elementCount,
          controlCount: nextFingerprint.controlCount - previousFingerprint.controlCount,
          dialogCount: nextFingerprint.dialogCount - previousFingerprint.dialogCount,
          activeDialogCount: nextFingerprint.activeDialogCount - previousFingerprint.activeDialogCount,
          bodyTextLength: nextFingerprint.bodyTextLength - previousFingerprint.bodyTextLength,
        },
      });
      for (const transition of dialogTransitions) {
        enqueue({
          type: transition.type,
          dialog: uiTarget(transition.dialog),
          fingerprint: nextFingerprint.ref,
        });
      }
    };
    const historyObject = win && win.history;
    const originalPushState = historyObject && historyObject.pushState;
    const originalReplaceState = historyObject && historyObject.replaceState;
    let capturedPushState;
    let capturedReplaceState;
    if (historyObject && typeof originalPushState === 'function') {
      capturedPushState = function uiCapturedPushState(...args) {
        const result = originalPushState.apply(this, args);
        onRoute('pushState');
        return result;
      };
      historyObject.pushState = capturedPushState;
    }
    if (historyObject && typeof originalReplaceState === 'function') {
      capturedReplaceState = function uiCapturedReplaceState(...args) {
        const result = originalReplaceState.apply(this, args);
        onRoute('replaceState');
        return result;
      };
      historyObject.replaceState = capturedReplaceState;
    }
    const MutationObserverCtor = options.MutationObserver
      || (win && win.MutationObserver)
      || globalValue('MutationObserver');
    let mutationObserver = null;
    if (typeof MutationObserverCtor === 'function' && (doc.documentElement || doc.body)) {
      mutationObserver = new MutationObserverCtor(onMutations);
      mutationObserver.observe(doc.documentElement || doc.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }

    doc.addEventListener('click', onClick, true);
    doc.addEventListener('input', onInput, true);
    doc.addEventListener('change', onChange, true);
    doc.addEventListener('focus', onFocus, true);
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('popstate', onPopState);
      win.addEventListener('hashchange', onHashChange);
    }
    state.restores.push(() => {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('input', onInput, true);
      doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('focus', onFocus, true);
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('popstate', onPopState);
        win.removeEventListener('hashchange', onHashChange);
      }
      if (historyObject && historyObject.pushState === capturedPushState) {
        historyObject.pushState = originalPushState;
      }
      if (historyObject && historyObject.replaceState === capturedReplaceState) {
        historyObject.replaceState = originalReplaceState;
      }
      if (mutationObserver) mutationObserver.disconnect();
      flush(true);
    });
  }

  function fingerprintDom(doc, win, options, salt) {
    const maxElements = positiveInteger(options.maxFingerprintElements, 200);
    const maxText = positiveInteger(options.maxFingerprintText, 2000);
    const elements = queryElements(doc, '*').slice(0, maxElements);
    const controls = queryElements(doc, defaultControlSelector);
    const dialogs = queryElements(doc, dialogLikeSelector);
    const activeDialogCount = dialogs.filter(isDialogActive).length;
    const bodyTextValue = text(doc && doc.body && doc.body.innerText);
    const structure = elements.map((element) => [
      text(element && element.tagName).toLowerCase(),
      text(element && element.id),
      attr(element, 'role'),
      attr(element, 'aria-label'),
      attr(element, 'class'),
      trimText(attr(element, 'style'), 300),
      attr(element, 'aria-hidden'),
      element && element.hidden ? 'hidden' : '',
      element && element.open ? 'open' : '',
    ].join(':')).join('|');
    const material = [
      text(doc && doc.title),
      routeFromLocation(win && win.location),
      bodyTextValue.slice(0, maxText),
      structure,
      elements.length,
      controls.length,
      dialogs.length,
      activeDialogCount,
    ].join('\n');
    return {
      hash: hashText(material, salt),
      elementCount: elements.length,
      controlCount: controls.length,
      dialogCount: dialogs.length,
      activeDialogCount,
      bodyTextLength: bodyTextValue.length,
    };
  }

  function queryElements(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    try {
      return Array.prototype.slice.call(doc.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function summarizeMutations(records) {
    const attributeNames = new Set();
    const summary = {
      records: 0,
      addedNodes: 0,
      removedNodes: 0,
      attributeChanges: 0,
      textChanges: 0,
    };
    for (const record of Array.prototype.slice.call(records || [])) {
      summary.records += 1;
      if (record.type === 'attributes') {
        summary.attributeChanges += 1;
        if (record.attributeName) attributeNames.add(trimText(record.attributeName, 80));
      }
      if (record.type === 'characterData') summary.textChanges += 1;
      const added = Array.prototype.slice.call(record.addedNodes || []);
      const removed = Array.prototype.slice.call(record.removedNodes || []);
      summary.addedNodes += added.length;
      summary.removedNodes += removed.length;
    }
    const allAttributeNames = Array.from(attributeNames).sort();
    summary.attributeNames = allAttributeNames.slice(0, 20);
    summary.attributeNamesTruncated = Math.max(0, allAttributeNames.length - summary.attributeNames.length);
    return summary;
  }

  function uiBatchSignals(events) {
    let semanticChanged = false;
    let renderChanged = false;
    let interactionObserved = false;
    for (const event of events) {
      const type = text(event && event.type).toLowerCase();
      if (type.startsWith('interaction.')) interactionObserved = true;
      if (type === 'route.change') semanticChanged = true;
      if (type.startsWith('dialog.')) {
        semanticChanged = true;
        renderChanged = true;
      }
      if (type === 'dom.mutation') {
        const mutations = event.mutations || {};
        const attributes = Array.isArray(mutations.attributeNames)
          ? mutations.attributeNames.map((name) => text(name).toLowerCase())
          : [];
        const structural = Number(mutations.addedNodes || 0) > 0
          || Number(mutations.removedNodes || 0) > 0
          || Number(mutations.textChanges || 0) > 0;
        const hasSemanticAttribute = attributes.some((name) => !['style', 'class'].includes(name));
        if (structural || hasSemanticAttribute) semanticChanged = true;
        if (event.fingerprint?.changed || Number(mutations.attributeChanges || 0) > 0 || structural) {
          renderChanged = true;
        }
      }
    }
    return { semanticChanged, renderChanged, interactionObserved };
  }

  function dialogLikeNodes(nodes) {
    const found = [];
    const seen = new Set();
    const visit = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (isDialogLike(node)) found.push(node);
      if (typeof node.querySelectorAll === 'function') {
        for (const child of queryElements(node, dialogLikeSelector)) visit(child);
      }
    };
    for (const node of nodes || []) visit(node);
    return found;
  }

  function detectDialogTransitions(records, dialogStates) {
    const transitions = [];
    for (const record of Array.prototype.slice.call(records || [])) {
      if (record.type === 'childList') {
        for (const dialog of dialogLikeNodes(Array.prototype.slice.call(record.removedNodes || []))) {
          const wasActive = dialogStates.has(dialog)
            ? dialogStates.get(dialog)
            : isDialogActive(dialog);
          if (wasActive) transitions.push({ type: 'dialog.close', dialog });
          dialogStates.delete(dialog);
        }
        for (const dialog of dialogLikeNodes(Array.prototype.slice.call(record.addedNodes || []))) {
          const active = isDialogActive(dialog);
          if (active) transitions.push({ type: 'dialog.open', dialog });
          dialogStates.set(dialog, active);
        }
      }
      if (record.type === 'attributes') {
        const dialog = record.target;
        const dialogLike = isDialogLike(dialog);
        if (!dialogLike && !dialogStates.has(dialog)) continue;
        const wasActive = dialogStates.has(dialog) ? dialogStates.get(dialog) : false;
        const active = dialogLike && isDialogActive(dialog);
        if (active !== wasActive) {
          transitions.push({ type: active ? 'dialog.open' : 'dialog.close', dialog });
        }
        if (dialogLike) dialogStates.set(dialog, active);
        else dialogStates.delete(dialog);
      }
    }
    return transitions;
  }

  function isDialogLike(element) {
    const tag = text(element && element.tagName).toLowerCase();
    const role = attr(element, 'role').toLowerCase();
    const ariaModal = attr(element, 'aria-modal').toLowerCase();
    const className = attr(element, 'class').toLowerCase();
    return tag === 'dialog'
      || role === 'dialog'
      || role === 'alertdialog'
      || ariaModal === 'true'
      || /(^|\s)(modal|dialog)(\s|$)/.test(className);
  }

  function isDialogActive(element) {
    if (!element || element.hidden || attr(element, 'aria-hidden').toLowerCase() === 'true') return false;
    const style = attr(element, 'style').toLowerCase();
    if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) return false;
    if (text(element.tagName).toLowerCase() === 'dialog' && typeof element.open === 'boolean') {
      return element.open;
    }
    return true;
  }

  function hashText(value, salt = '') {
    const raw = `${salt}\u0000${text(value)}`;
    let first = 2166136261;
    let second = 2246822507;
    for (let index = 0; index < raw.length; index += 1) {
      const code = raw.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 16777619);
      second ^= code;
      second = Math.imul(second, 3266489909);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
  }

  function randomFingerprintSalt() {
    const cryptoObject = globalValue('crypto');
    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      const values = new Uint32Array(4);
      cryptoObject.getRandomValues(values);
      return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function positiveInteger(value, fallback) {
    const number = value === undefined ? fallback : Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  }

  function nonNegativeNumber(value, fallback) {
    const number = value === undefined ? fallback : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function uiTarget(element) {
    return {
      tag: text(element && element.tagName).toLowerCase(),
      id: text(element && element.id),
      name: attr(element, 'name'),
      type: attr(element, 'type'),
      role: attr(element, 'role'),
      ariaLabel: attr(element, 'aria-label'),
      text: trimText(element && (element.innerText || element.title || attr(element, 'aria-label')), 160),
      disabled: Boolean(element && element.disabled),
      bounds: bounds(element),
    };
  }

  function isSensitiveInput(element) {
    const values = [
      attr(element, 'type'),
      attr(element, 'autocomplete'),
      attr(element, 'name'),
      text(element && element.id),
    ].join(' ').toLowerCase();
    return /password|passwd|pwd|passcode|current-password|new-password/.test(values);
  }

  function routeFromLocation(location) {
    if (!location) return '';
    return `${location.pathname || ''}${location.search || ''}${location.hash || ''}`;
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
