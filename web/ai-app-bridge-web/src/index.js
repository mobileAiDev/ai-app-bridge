(function initAiAppBridgeWeb(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.AiAppBridgeWeb = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  const defaultControlSelector = 'a,button,input,textarea,select,[contenteditable="true"],[role],[onclick],[aria-label]';
  const dialogLikeSelector = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const maxCaptureText = 12000;

  const webProtocol = 'aab.web/v2';
  const executionSchema = 'aab.web-execution/v1';
  const domTargetSchema = 'aab.web-dom-target/v1';
  const captureSchema = 'aab.web-capture/v1';
  const captureStreams = ['logs', 'network', 'state', 'events'];
  const documentTargets = new WeakMap();
  const elementKeys = ['elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel', 'placeholder', 'href', 'text'];
  const textInputTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
  const checkedRoles = ['checkbox', 'menuitemcheckbox', 'radio', 'menuitemradio', 'switch', 'option', 'treeitem'];
  const transportLimits = { messageBytes: 256 * 1024, queueBytes: 1024 * 1024, queueCount: 100, queueTtlMs: 60000 };

  function createAiAppBridge(options = {}) {
    const state = {
      options, socket: null, binding: null, reconnectTimer: null, queue: [], queueBytes: 0,
      started: false, connected: false, runtimeEpoch: newIdentity(),
      sessionId: options.sessionId ?? storedSessionId(options.storageKey ?? 'ai_app_bridge_web_session_id'),
      actions: new Map(), stateProviders: new Map(), restores: [], active: null, completion: null,
      dropped: 0, rejected: 0, lastReceipt: null, lastError: null, reconnectDelay: 1000,
      captureActionId: null, flushUi: null,
      captures: Object.fromEntries(captureStreams.map(stream => [stream, { sequence: 0, losses: 0, pending: 0 }])),
    };
    if (typeof state.sessionId !== 'string' || !state.sessionId || state.sessionId.length > 1024)
      throw new Error('invalid_web_session_id');
    const api = { start, stop: disconnect, disconnect, recordLog, recordNetwork, recordState, recordEvent,
      registerAction, unregisterAction, registerStateProvider, snapshotDom: observeDom,
      sessionId: () => state.sessionId, runtimeEpoch: () => state.runtimeEpoch,
      isConnected: () => state.connected,
      transportStatus: () => ({ connected: state.connected, queuedRecords: state.queue.length, queuedBytes: state.queueBytes,
        droppedRecords: state.dropped, rejectedRecords: state.rejected, lastReceipt: state.lastReceipt, lastError: state.lastError,
        activeActionId: state.active?.actionId ?? null, completionPending: Boolean(state.completion) }),
    };

    function start() {
      if (state.started) return api;
      if (typeof options.endpoint !== 'string' || !options.endpoint) throw new Error('AiAppBridge endpoint is required');
      state.started = true; state.restores.push(trackDocument()); installCaptures(); connect(); return api;
    }
    function disconnect() {
      state.active?.cancel('web_sdk_stopped');
      for (const restore of state.restores.splice(0).reverse()) {
        try { restore(); } catch (error) { state.lastError = error.message; }
      }
      state.started = false; state.connected = false; state.binding = null;
      clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
      const socket = state.socket; state.socket = null;
      if (socket) socket.close();
    }
    function connect() {
      if (!state.started) return;
      const WebSocketCtor = options.WebSocket ?? globalValue('WebSocket');
      if (!WebSocketCtor) throw new Error('WebSocket is not available');
      const socket = new WebSocketCtor(withToken(options.endpoint, options.token)); state.socket = socket;
      socket.onopen = () => {
        if (state.socket !== socket || !state.started) return;
        socket.send(JSON.stringify({ type: 'hello', schemaVersion: webProtocol, sessionId: state.sessionId,
          runtimeEpoch: state.runtimeEpoch, targetId: 'main', executionSchema, domTargetSchema, captureSchema,
          appName: options.appName ?? documentTitle(), url: locationHref(), origin: locationOrigin(), route: locationPath() }));
      };
      socket.onmessage = event => {
        if (state.socket !== socket || !state.started) return;
        void handleServerMessage(event.data).catch(error => { state.lastError = error.message; disconnect(); });
      };
      socket.onclose = event => {
        if (state.socket !== socket) return;
        state.connected = false; state.binding = null; state.socket = null;
        if (event?.code === 1008) { state.lastError = 'web_protocol_rejected'; disconnect(); return; }
        if (state.started && options.reconnect !== false && state.reconnectTimer === null) {
          state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(); }, state.reconnectDelay);
          state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
        }
      };
      socket.onerror = () => { if (state.socket === socket) state.lastError = 'web_transport_error'; };
    }
    function sendWire(payload) {
      if (!state.connected || !state.binding || state.socket?.readyState !== 1) return false;
      const wire = JSON.stringify({ ...payload, binding: state.binding });
      if (utf8Bytes(wire) > transportLimits.messageBytes) throw new Error('web_message_too_large');
      if ((state.socket.bufferedAmount ?? 0) > transportLimits.queueBytes) { state.lastError = 'web_socket_backpressure'; state.socket.close(); return false; }
      state.socket.send(wire); return true;
    }
    function flushQueue() {
      while (state.queue.length) {
        const entry = state.queue[0];
        if (Date.now() - entry.atMs >= transportLimits.queueTtlMs) {
          state.dropped++; state.captures[entry.payload.stream].losses++;
        }
        else if (!sendWire(entry.payload)) break;
        state.queue.shift(); state.queueBytes -= entry.bytes;
      }
    }
    function capture(stream, item, context) {
      const captureId = newIdentity();
      const explicit = Object.hasOwn(context, 'actionId');
      const actionId = explicit ? context.actionId : state.captureActionId;
      const association = actionId == null ? 'unattributed' : context.association ?? (explicit ? 'explicit' : 'synchronous');
      const counters = state.captures[stream];
      const payload = { type: 'capture', captureId, stream, sequence: ++counters.sequence, actionId,
        item: { source: 'web-sdk', timestampMs: Date.now(), url: locationHref(), route: locationPath(), ...item,
          ...(context.pageRef === undefined ? {} : { pageRef: context.pageRef }), association } };
      let bytes;
      try { bytes = utf8Bytes(JSON.stringify(payload)); }
      catch { state.rejected++; counters.losses++; return { accepted: false, stored: false, captureId, error: 'invalid_web_capture_json' }; }
      if (bytes > 128 * 1024 - 4096) { state.rejected++; counters.losses++; return { accepted: false, stored: false, captureId, error: 'web_record_too_large' }; }
      while (state.queue.length && (state.queue.length >= transportLimits.queueCount || state.queueBytes + bytes > transportLimits.queueBytes)) {
        const dropped = state.queue.shift();
        state.queueBytes -= dropped.bytes; state.dropped++; state.captures[dropped.payload.stream].losses++;
      }
      state.queue.push({ payload, bytes, atMs: Date.now() }); state.queueBytes += bytes; flushQueue();
      return { accepted: true, stored: false, captureId, runtimeEpoch: state.runtimeEpoch };
    }
    function recordLog(level, tag, message, data, context = {}) {
      return capture('logs', { level: level ?? 'info', tag: tag ?? 'web', message: trimText(message), data }, context);
    }
    function recordNetwork(record, context = {}) {
      return capture('network', { method: record.method ?? 'GET', url: record.url ?? '', statusCode: record.statusCode ?? -1,
        durationMs: record.durationMs ?? -1, requestHeaders: record.requestHeaders, responseHeaders: record.responseHeaders,
        requestBody: captureText(record.requestBody, record.requestBodyEncoding), responseBody: captureText(record.responseBody, record.responseBodyEncoding), error: record.error,
        requestBodyState: record.requestBodyState, responseBodyState: record.responseBodyState,
        requestBodyEncoding: record.requestBodyEncoding, responseBodyEncoding: record.responseBodyEncoding,
        redacted: record.redacted === true, source: record.source ?? 'web-sdk' }, context);
    }
    function recordState(namespace, key, value, context = {}) {
      return capture('state', { namespace, key, value }, context);
    }
    function recordEvent(category, name, data, context = {}) {
      return capture('events', { category: category ?? 'app', name: name ?? 'event', data }, context);
    }
    function registerAction(name, handler) {
      if (typeof name !== 'string' || !name || name.length > 1024 || typeof handler !== 'function') throw new Error('registerAction requires a name and handler');
      if (!state.actions.has(name) && state.actions.size >= 128) throw new Error('web_action_registration_limit');
      state.actions.set(name, handler); return api;
    }
    function unregisterAction(name) { state.actions.delete(name); return api; }
    function registerStateProvider(name, provider) {
      if (typeof name !== 'string' || !name || name.length > 1024 || typeof provider !== 'function') throw new Error('registerStateProvider requires a name and provider');
      if (!state.stateProviders.has(name) && state.stateProviders.size >= 128) throw new Error('web_state_provider_limit');
      state.stateProviders.set(name, provider); return api;
    }
    function target() { return { sessionId: state.sessionId, runtimeEpoch: state.runtimeEpoch, targetId: 'main' }; }
    function validBinding(binding) {
      return binding && binding.schemaVersion === webProtocol && binding.sessionId === state.sessionId
        && binding.runtimeEpoch === state.runtimeEpoch && binding.targetId === 'main'
        && typeof binding.providerEpoch === 'string' && typeof binding.connectionId === 'string';
    }
    function reply(request, result) { sendWire({ type: 'response', requestId: request.requestId, result }); }
    function sendCompletion() { if (state.completion) sendWire({ type: 'completion', result: state.completion }); }
    async function handleServerMessage(raw) {
      if (typeof raw !== 'string' || utf8Bytes(raw) > transportLimits.messageBytes) throw new Error('invalid_web_message');
      const message = JSON.parse(raw);
      if (message.type === 'helloAck') {
        if (state.binding || message.ok !== true || !validBinding(message.binding)) throw new Error('invalid_web_binding');
        state.binding = message.binding; state.connected = true; state.reconnectDelay = 1000;
        sendCompletion(); flushQueue(); return;
      }
      if (!state.binding || JSON.stringify(message.binding) !== JSON.stringify(state.binding)) throw new Error('web_binding_mismatch');
      if (message.type === 'captureAck') {
        state.lastReceipt = { captureId: message.captureId, ...message.receipt };
        if (!message.receipt?.stored) { state.rejected++; state.lastError = message.error; } return;
      }
      if (message.type === 'completionAck') {
        if (state.completion?.actionId === message.actionId && message.stored === true) state.completion = null;
        else if (message.stored !== true) state.lastError = message.error;
        return;
      }
      if (message.type === 'read') {
        if (message.payload?.name === 'captureBarrier') {
          const stream = message.payload.args?.stream;
          if (!captureStreams.includes(stream)) { reply(message, { ok: false, error: 'invalid_web_capture_stream' }); return; }
          if (stream === 'events' && state.flushUi) state.flushUi();
          flushQueue();
          reply(message, { ok: true, schemaVersion: captureSchema, stream,
            ...state.captures[stream], target: target() });
          return;
        }
        if (message.payload?.name !== 'domSnapshot') { reply(message, { ok: false, error: 'unknown_web_read' }); return; }
        const dom = observeDom(message.payload.args ?? {});
        reply(message, dom.ok ? { ok: true, dom } : dom); return;
      }
      if (message.type === 'cancel') {
        const identity = message.payload;
        if (identity?.runtimeEpoch !== state.runtimeEpoch) { reply(message, { ok: false, error: 'web_target_changed' }); return; }
        if (state.active?.actionId === identity.actionId) state.active.cancel('web_action_cancelled');
        sendCompletion(); reply(message, { ok: true, actionId: identity.actionId, runtimeEpoch: state.runtimeEpoch }); return;
      }
      if (message.type !== 'command') throw new Error('unknown_web_message');
      const request = message.payload, execution = request?.execution;
      const reject = error => reply(message, { ok: false, error, dispatched: false, ambiguous: false });
      if (execution?.schemaVersion !== executionSchema || execution.runtimeEpoch !== state.runtimeEpoch
          || typeof execution.actionId !== 'string' || request.actionId !== execution.actionId
          || !Number.isInteger(execution.timeoutMs) || execution.timeoutMs < 1 || execution.timeoutMs > 2147483647
          || JSON.stringify(request.target) !== JSON.stringify(target())) { reject('invalid_web_execution'); return; }
      if (state.active || state.completion) { sendCompletion(); reject('web_action_busy'); return; }
      const controller = new AbortController();
      const task = { actionId: request.actionId, issued: false, stopReason: null, timer: null, queued: null,
        deadline: performance.now() + execution.timeoutMs,
        cancel(reason) {
          if (state.active !== task || task.stopReason) return;
          task.stopReason = reason; controller.abort(reason);
          if (!task.issued) { clearTimeout(task.queued); finish({ ok: false, error: reason }); }
        },
        check() {
          if (performance.now() >= task.deadline) task.cancel('web_action_timeout');
          if (state.active !== task || task.stopReason || !state.started) throw new Error(task.stopReason ?? 'web_action_not_active');
        },
        permit() { task.check(); task.issued = true; },
        pageRef: () => documentPageRef(target()),
        signal: controller.signal,
      };
      function finish(outcome) {
        if (state.active !== task) return;
        clearTimeout(task.timer); clearTimeout(task.queued);
        let result = { ...outcome, ...(task.stopReason ? { ok: false, error: task.stopReason } : {}),
          actionId: task.actionId, runtimeEpoch: state.runtimeEpoch, settled: true, dispatched: task.issued, ambiguous: false,
          execution: { schemaVersion: executionSchema, actionId: task.actionId, runtimeEpoch: state.runtimeEpoch, target: target(), settled: true } };
        try { if (typeof outcome?.ok !== 'boolean' || (outcome.ok === false && typeof outcome.error !== 'string')
          || utf8Bytes(JSON.stringify(result)) > 64 * 1024) throw new Error(); }
        catch { result = { ok: false, error: 'invalid_web_action_result', actionId: task.actionId,
          runtimeEpoch: state.runtimeEpoch, settled: true, dispatched: task.issued, ambiguous: false,
          execution: { schemaVersion: executionSchema, actionId: task.actionId, runtimeEpoch: state.runtimeEpoch, target: target(), settled: true } }; }
        state.active = null; state.completion = result; sendCompletion();
      }
      state.active = task;
      task.timer = setTimeout(() => task.cancel('web_action_timeout'), execution.timeoutMs);
      task.queued = setTimeout(async () => {
        try {
          task.check();
          let result;
          // This scope covers the synchronous dispatch stack only. Native
          // async/await continuations do not inherit it in current browsers.
          state.captureActionId = task.actionId;
          try { result = runCommand(request.command, task); }
          finally { state.captureActionId = null; }
          finish(await result);
        }
        catch (error) { finish({ ok: false, error: error.message || 'web_action_failed',
          ...(error.details === undefined ? {} : { details: error.details }) }); }
      }, 0);
    }
    async function runCommand(command, task) {
      const args = command?.args ?? {};
      switch (command?.name) {
        case 'click': return clickElement(args, task);
        case 'input': return inputElement(args, task);
        case 'key': return keyEvent(args, task);
        case 'waitFor': return waitFor(args, task);
        case 'scroll': return scrollTarget(args, task);
        case 'state': {
          const values = {};
          for (const [name, provider] of state.stateProviders) { task.permit(); values[name] = await provider({ signal: task.signal }); task.check(); }
          return { ok: true, values };
        }
        case 'action': {
          if (typeof args.name !== 'string' || !state.actions.has(args.name)) return { ok: false, error: 'action_not_registered' };
          const context = { signal: task.signal, actionId: task.actionId, runtimeEpoch: state.runtimeEpoch,
            recordState: (namespace, key, value) => recordState(namespace, key, value, { actionId: task.actionId }),
            recordEvent: (category, name, data) => recordEvent(category, name, data, { actionId: task.actionId }) };
          task.permit(); const value = await state.actions.get(args.name)(args.arguments, context);
          return { ok: true, value };
        }
        default: return { ok: false, error: 'unknown_web_command' };
      }
    }
    function observeDom(options = {}) {
      const dom = snapshotDom(options);
      return dom.ok ? { ...dom, pageRef: documentPageRef(target()) } : dom;
    }
    function installCaptures() {
      const captureOptions = options.capture ?? {};
      if (captureOptions.console) installConsoleCapture(state, recordLog);
      if (captureOptions.errors) installErrorCapture(state, recordLog);
      if (captureOptions.fetch) installFetchCapture(state, recordNetwork, options);
      if (captureOptions.xhr) installXhrCapture(state, recordNetwork, options);
      if (captureOptions.ui) installUiCapture(state, recordEvent, captureOptions.ui);
    }
    return api;
  }

  function utf8Bytes(value) { return new TextEncoder().encode(value).byteLength; }
  function newIdentity() {
    const bytes = new Uint8Array(16); globalValue('crypto').getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }

  function documentTarget(doc) {
    if (!documentTargets.has(doc)) documentTargets.set(doc, { navigationId: newIdentity(), available: true, elements: new WeakMap(), nextElement: 0 });
    return documentTargets.get(doc);
  }
  function documentPageRef(binding) {
    const doc = globalValue('document');
    if (!doc) throw new Error('document_unavailable');
    const state = documentTarget(doc);
    if (!state.available) throw new Error('web_document_inactive');
    return { schemaVersion: domTargetSchema, ...binding, navigationId: state.navigationId, url: locationHref() };
  }
  function trackDocument() {
    const doc = globalValue('document'), win = globalValue('window');
    if (!doc || !win) return () => {};
    const state = documentTarget(doc), restores = [];
    const advance = () => { state.navigationId = newIdentity(); };
    for (const name of ['pushState', 'replaceState']) {
      const original = win.history?.[name];
      if (typeof original !== 'function') continue;
      const wrapper = function (...args) { const result = original.apply(this, args); advance(); return result; };
      win.history[name] = wrapper;
      restores.push(() => { if (win.history[name] === wrapper) win.history[name] = original; });
    }
    const events = { popstate: advance, hashchange: advance,
      pagehide: () => { state.available = false; advance(); }, pageshow: () => { state.available = true; advance(); } };
    if (typeof win.addEventListener === 'function') for (const [name, callback] of Object.entries(events)) {
      win.addEventListener(name, callback); restores.push(() => win.removeEventListener(name, callback));
    }
    return () => { for (const restore of restores) restore(); };
  }
  function elementIdentity(element, doc = element.ownerDocument || globalValue('document')) {
    const state = documentTarget(doc);
    if (!state.elements.has(element)) state.elements.set(element, `e${++state.nextElement}`);
    const sensitive = isSensitiveInput(element);
    return { elementId: state.elements.get(element), tag: text(element.tagName).toLowerCase(), id: text(element.id),
      name: attr(element, 'name'), type: attr(element, 'type'), role: attr(element, 'role'), ariaLabel: attr(element, 'aria-label'),
      placeholder: attr(element, 'placeholder'), href: trimText(element.href, 500),
      text: trimText(sensitive ? attr(element, 'aria-label') || attr(element, 'placeholder')
        : element.innerText || element.value || element.title || attr(element, 'aria-label'), 300) };
  }
  function elementVisible(element) {
    const win = element.ownerDocument?.defaultView || globalValue('window');
    if (!element.isConnected || !win || typeof win.getComputedStyle !== 'function') return false;
    const style = win.getComputedStyle(element), rect = bounds(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }
  function elementDisabled(element) {
    return Boolean(element.disabled || attr(element, 'aria-disabled') === 'true' || element.closest?.('[inert]'));
  }
  function elementEditable(element) {
    return !elementDisabled(element) && !element.readOnly && (element.isContentEditable === true
      || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' && textInputTypes.includes(element.type));
  }
  function elementChecked(element) {
    if (element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type)) {
      return element.type === 'checkbox' && element.indeterminate ? 'mixed' : element.checked;
    }
    const role = attr(element, 'role'), value = element.getAttribute('aria-checked');
    if (!checkedRoles.includes(role)) return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    // WAI-ARIA defines mixed on radio/menuitemradio/switch as false. The raw
    // attribute is retained separately, including invalid or missing tokens.
    if (value === 'mixed') {
      if (['radio', 'menuitemradio', 'switch'].includes(role)) return false;
      if (['checkbox', 'menuitemcheckbox'].includes(role)) return 'mixed';
    }
    return null;
  }
  function interactionState(element) {
    if (elementDisabled(element)) return { status: 'disabled' };
    if (!elementVisible(element)) return { status: 'hidden' };
    const doc = element.ownerDocument, win = doc.defaultView, rect = bounds(element);
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(win.innerWidth, rect.right), bottom = Math.min(win.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return { status: 'outside-viewport' };
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const hit = doc.elementFromPoint(point.x, point.y);
    if (hit === element || element.contains(hit)) return { status: 'ready', point };
    return { status: 'obscured', point, hit: hit ? { tag: text(hit.tagName).toLowerCase(), id: text(hit.id),
      role: attr(hit, 'role'), className: typeof hit.className === 'string' ? trimText(hit.className, 300) : '' } : null };
  }

  function snapshotDom(options = {}) {
    const doc = options.document || globalValue('document');
    if (!doc || !doc.querySelectorAll) {
      return { ok: false, error: 'document_unavailable' };
    }
    const selector = options.selector || defaultControlSelector;
    const maxControls = Number(options.maxControls || 200);
    const controls = [];
    const matched = doc.querySelectorAll(selector);
    const elements = Array.prototype.slice.call(matched, 0, maxControls);
    elements.forEach((element, index) => {
      const sensitive = isSensitiveInput(element);
      const elementValue = text(element.value);
      controls.push({
        ...elementIdentity(element, doc),
        index,
        sensitive,
        ...(sensitive ? { valueLength: elementValue.length } : {}),
        disabled: elementDisabled(element),
        visible: elementVisible(element),
        editable: elementEditable(element),
        checked: elementChecked(element),
        ariaChecked: element.getAttribute('aria-checked'),
        interaction: interactionState(element),
        bounds: bounds(element),
      });
    });
    return {
      ok: true,
      targetSchema: domTargetSchema,
      title: text(doc.title),
      url: locationHref(),
      readyState: text(doc.readyState),
      bodyText: trimText(doc.body && doc.body.innerText, 20000),
      bodyTextTruncated: text(doc.body && doc.body.innerText).length > 20000,
      controls,
      controlCount: controls.length,
      truncated: matched.length > maxControls,
      updatedAtMs: Date.now(),
    };
  }

  function clickElement(args, task) {
    const selected = actionTarget(args, task);
    ensureTarget(selected, task, { hit: true }); task.permit(); selected.element.click();
    return { ok: true, resolved: selected.ref };
  }

  function inputElement(args, task) {
    const selected = actionTarget(args, task), element = selected.element;
    if (typeof args.value !== 'string') return { ok: false, error: 'invalid_web_input_value' };
    const richText = element.isContentEditable === true;
    if (!elementEditable(element))
      return { ok: false, error: 'web_element_not_editable' };
    const value = args.value;
    const doc = element.ownerDocument, win = doc.defaultView;
    ensureTarget(selected, task, { hit: true }); task.permit(); element.focus();
    ensureTarget(selected, task, { focus: true });
    if (richText) {
      const range = doc.createRange(); range.selectNodeContents(element);
      const selection = win.getSelection(); task.permit(); selection.removeAllRanges(); selection.addRange(range);
      ensureTarget(selected, task, { focus: true }); task.permit();
      if (!doc.execCommand('insertText', false, value)) return { ok: false, error: 'web_input_rejected', resolved: selected.ref };
    } else {
      const prototype = element.tagName === 'INPUT' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      task.permit(); setter.call(element, value);
      ensureTarget(selected, task, { focus: true, edited: true }); task.permit();
      element.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      ensureTarget(selected, task, { focus: true, edited: true }); task.permit(); element.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
    ensureTarget(selected, task, { edited: true });
    const sensitive = isSensitiveInput(element);
    return {
      ok: true,
      resolved: selected.ref,
      sensitive,
      valueLength: (richText ? element.innerText : element.value).length,
      ...(sensitive ? {} : { value: richText ? element.innerText : element.value }),
    };
  }

  function keyEvent(args, task) {
    if (!['Enter', 'Escape'].includes(args.key)) return { ok: false, error: 'invalid_web_key' };
    const selected = actionTarget(args, task), element = selected.element;
    ensureTarget(selected, task, { hit: true }); task.permit(); element.focus();
    ensureTarget(selected, task, { focus: true });
    const event = new element.ownerDocument.defaultView.KeyboardEvent('keydown', {
      key: args.key, code: args.key, bubbles: true, cancelable: true, composed: true,
    });
    task.permit(); element.dispatchEvent(event);
    return { ok: true, resolved: selected.ref, key: args.key, eventType: 'keydown',
      trusted: event.isTrusted, defaultPrevented: event.defaultPrevented };
  }

  function waitFor(args, task) {
    const timeoutMs = args.timeoutMs ?? 5000;
    const startedAtMs = performance.now();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => { clearTimeout(timer); task.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
      const abort = () => finish(new Error(task.signal.reason));
      const tick = () => {
        try { task.check();
        if (args.selector && findElement(args.selector)) {
          finish(null, { ok: true, matched: 'selector' });
          return;
        }
        if (args.targetText && bodyText().includes(String(args.targetText))) {
          finish(null, { ok: true, matched: 'text' });
          return;
        }
        if (performance.now() - startedAtMs >= timeoutMs) {
          finish(null, { ok: false, error: 'wait_timeout' });
          return;
        }
        timer = setTimeout(tick, args.intervalMs ?? 250);
        } catch (error) { finish(error); }
      };
      task.signal.addEventListener('abort', abort, { once: true });
      tick();
    });
  }

  function scrollTarget(args, task) {
    const selected = args.selector ? actionTarget(args, task) : null;
    const deltaX = args.deltaX ?? 0;
    const deltaY = args.deltaY ?? 0;
    if (args.mode === 'into-view') {
      if (!selected) return { ok: false, error: 'web_selector_required' };
      ensureTarget(selected, task); task.permit(); selected.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return { ok: true, resolved: selected.ref };
    }
    if (args.mode !== 'by') return { ok: false, error: 'invalid_web_scroll_mode' };
    if (selected) {
      ensureTarget(selected, task); task.permit(); selected.element.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
      return { ok: true, resolved: selected.ref };
    }
    const win = globalValue('window');
    if (win && win.scrollBy) {
      task.permit(); win.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
      return { ok: true, target: 'window' };
    }
    return { ok: false, error: 'scroll_unavailable' };
  }

  function findElement(selector) {
    const doc = globalValue('document');
    if (!doc) return null;
    if (!selector || typeof selector !== 'object') throw new Error('invalid_web_selector');
    const identities = ['elementId', 'text', 'ariaLabel', 'css'].filter(key => typeof selector[key] === 'string' && selector[key].length > 0);
    if (identities.length !== 1) throw new Error('invalid_web_selector');
    const elements = doc.querySelectorAll(selector.css ?? defaultControlSelector);
    if (elements.length > 1000) throw new Error('web_selector_scan_limit');
    const matches = Array.from(elements).filter(element => {
      if (!elementVisible(element)) return false;
      const ref = elementIdentity(element);
      return ['elementId', 'text', 'ariaLabel', 'tag', 'role'].every(key => selector[key] === undefined || selector[key] === ref[key]);
    });
    if (matches.length > 1) throw new Error('web_element_ambiguous');
    return matches[0] ?? null;
  }

  function actionTarget(args, task) {
    const element = findElement(args.selector);
    if (!element) throw new Error('web_element_not_found');
    const ref = { pageRef: task.pageRef(), element: elementIdentity(element) };
    if (args.expectedTarget && (!samePage(ref.pageRef, args.expectedTarget.pageRef)
      || !elementKeys.every(key => ref.element[key] === args.expectedTarget.element[key]))) throw new Error('reobserve_required');
    return { element, ref };
  }
  function samePage(a, b) {
    return ['schemaVersion', 'sessionId', 'runtimeEpoch', 'targetId', 'navigationId', 'url'].every(key => a[key] === b?.[key]);
  }
  function ensureTarget(selected, task, { focus = false, hit = false, edited = false } = {}) {
    const { element, ref } = selected;
    const doc = globalValue('document');
    task.check();
    if (!samePage(task.pageRef(), ref.pageRef)) throw new Error('reobserve_required');
    if (!element.isConnected || element.ownerDocument !== doc || elementDisabled(element) || !elementVisible(element)
      || (focus && doc.activeElement !== element)) throw new Error('web_element_changed');
    const current = elementIdentity(element);
    if (!elementKeys.filter(key => !edited || key !== 'text').every(key => current[key] === ref.element[key])) throw new Error('reobserve_required');
    if (hit) {
      const interaction = interactionState(element);
      if (interaction.status !== 'ready') throw Object.assign(new Error(interaction.status === 'outside-viewport'
        ? 'web_element_outside_viewport' : 'web_element_obscured'), { details: { interaction } });
    }
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
    win.fetch = function capturedFetch(input, init = {}) {
      const startedAtMs = Date.now();
      const method = (init && init.method) || (input && input.method) || 'GET';
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const context = captureContext(state);
      state.captures.network.pending++;
      const requestBody = captureRequestBody(input, init, options.captureRequestBodies === true);
      const finish = async (response, error) => {
        try {
          const [request, body] = await Promise.all([requestBody,
            response && options.captureResponseBodies === true
              ? captureResponseBody(response) : Promise.resolve({ state: 'disabled' })]);
          recordNetwork({ source: 'fetch-auto', method, url,
            statusCode: response ? response.status : -1, durationMs: Date.now() - startedAtMs,
            requestBody: request.text, requestBodyState: request.state,
            responseBody: body.text, responseBodyState: body.state,
            requestBodyEncoding: request.encoding, responseBodyEncoding: body.encoding,
            ...(error ? { error: error.message || String(error) } : {}) }, context);
        } finally { state.captures.network.pending--; }
      };
      try {
        return original.apply(this, arguments).then(response => {
          // Body capture cannot delay the App's response or consume its body.
          void finish(response, null);
          return response;
        }, error => { void finish(null, error); throw error; });
      } catch (error) {
        void finish(null, error);
        throw error;
      }
    };
    state.restores.push(() => {
      win.fetch = original;
    });
  }

  function captureContext(state) {
    return { ...actionContext(state),
      pageRef: documentPageRef({ sessionId: state.sessionId, runtimeEpoch: state.runtimeEpoch, targetId: 'main' }) };
  }

  function actionContext(state) {
    return { actionId: state.captureActionId, association: state.captureActionId === null ? 'unattributed' : 'synchronous' };
  }

  function captureText(value, encoding) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new TypeError('Web capture bodies must be strings when supplied.');
    if (encoding === 'base64') {
      if (value.length > Math.ceil(maxCaptureText / 3) * 4) throw new TypeError('Encoded Web bodies exceed the capture limit.');
      return value;
    }
    return trimText(value);
  }

  async function captureRequestBody(input, init, enabled) {
    if (!enabled) return { state: 'disabled' };
    if (Object.hasOwn(init, 'body')) {
      const body = init.body;
      if (body === null || body === undefined) return { state: 'empty', text: '', encoding: 'utf8' };
      if (typeof body === 'string') return { state: body.length > maxCaptureText ? 'truncated' : 'complete', text: trimText(body), encoding: 'utf8' };
      if (body instanceof URLSearchParams) {
        const text = body.toString();
        return { state: text.length > maxCaptureText ? 'truncated' : 'complete', text: trimText(text), encoding: 'utf8' };
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        return { ...encodeCapturedBytes(bytes.subarray(0, maxCaptureText)), state: bytes.length > maxCaptureText ? 'truncated' : 'complete' };
      }
      return { state: 'unsupported-body-type' };
    }
    const Request = globalValue('Request');
    if (typeof Request === 'function' && input instanceof Request) return captureResponseBody(input);
    return { state: 'empty', text: '', encoding: 'utf8' };
  }

  function encodeCapturedBytes(bytes) {
    // Preserve arbitrary protocol bytes. Encoding is explicit so consumers never
    // mistake a printable Base64 value for the App's original text body.
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {}
    if (text !== undefined && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
      return { text, encoding: 'utf8' };
    return { text: btoa(String.fromCharCode(...bytes)), encoding: 'base64' };
  }

  async function captureResponseBody(response) {
    let reader, timer;
    try {
      const copy = response.clone();
      if (copy.body === null) return { state: 'empty', text: '', encoding: 'utf8' };
      reader = copy.body.getReader();
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('capture-body-timeout')), 1000); });
      const chunks = []; let length = 0;
      while (true) {
        const next = await Promise.race([reader.read(), timeout]);
        if (next.done) {
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          return { state: 'complete', ...encodeCapturedBytes(bytes) };
        }
        if (length + next.value.length > maxCaptureText) return { state: 'too-large' };
        chunks.push(next.value); length += next.value.length;
      }
    } catch (error) { return { state: error.message === 'capture-body-timeout' ? 'timeout' : 'unavailable' }; }
    finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); }
  }

  function installXhrCapture(state, recordNetwork, options) {
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
      const context = captureContext(state);
      state.captures.network.pending++;
      const requestBody = captureRequestBody(null, { body }, options.captureRequestBodies === true);
      const onEnd = () => {
        const response = options.captureResponseBodies !== true ? { state: 'disabled' }
          : this.responseType !== '' && this.responseType !== 'text' ? { state: 'unsupported-body-type' }
          : { text: trimText(this.responseText), state: this.responseText.length > maxCaptureText ? 'truncated' : 'complete', encoding: 'utf8' };
        const record = {
          source: 'xhr-auto',
          method: meta.method || 'GET',
          url: meta.url || '',
          statusCode: this.status,
          durationMs: Date.now() - startedAtMs,
          responseBody: response.text, responseBodyState: response.state,
          responseBodyEncoding: response.encoding,
        };
        void requestBody.then(request => {
          recordNetwork({ ...record, requestBody: request.text, requestBodyState: request.state, requestBodyEncoding: request.encoding }, context);
        }).finally(() => { state.captures.network.pending--; });
      };
      this.addEventListener('loadend', onEnd, { once: true });
      try { return originalSend.apply(this, arguments); }
      catch (error) { this.removeEventListener('loadend', onEnd); state.captures.network.pending--; throw error; }
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
        const origin = pending[0];
        const changedOrigin = pending.findIndex(event => event.actionId !== origin.actionId || event.association !== origin.association);
        const count = changedOrigin < 0 ? maxBatchSize : Math.min(maxBatchSize, changedOrigin);
        const events = pending.splice(0, count);
        state.captures.events.pending = pending.length;
        const dropped = droppedEvents;
        droppedEvents = 0;
        const signals = uiBatchSignals(events);
        recordEvent('ui', 'batch', {
          batchSize: events.length,
          droppedEvents: dropped,
          ...signals,
          events,
        }, { actionId: origin.actionId, association: origin.association });
      } while (drain && pending.length);
      if (pending.length) scheduleFlush();
    };
    const enqueue = (event) => {
      if (!state.started) return;
      if (pending.length >= maxPendingEvents) {
        pending.shift();
        droppedEvents += 1;
        state.captures.events.losses++;
      }
      pending.push({
        timestampMs: Date.now(),
        route: routeFromLocation(win && win.location),
        ...event,
        ...actionContext(state),
      });
      state.captures.events.pending = pending.length;
      scheduleFlush();
    };
    state.flushUi = () => flush(true);
    state.restores.push(() => { state.flushUi = null; });
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
    if (!storage) throw new Error('web_session_storage_unavailable: supply sessionId');
    const existing = storage.getItem(key);
    if (existing) return existing;
    const next = newIdentity();
    storage.setItem(key, next);
    return next;
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
