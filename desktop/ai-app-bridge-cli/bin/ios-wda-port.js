'use strict';

const { CommandError } = require('./command-errors');
const { currentExecution, checkExecution } = require('./shared-kernel/execution-scope');

const fields = ['schemaVersion', 'bundleId', 'runtimeEpoch', 'processId', 'port'];
const schemaVersion = 'aab.ios-wda/v1';
const commands = new Set(['ios-wda-status', 'ios-wda-session', 'ios-uia-tree', 'ios-tap', 'ios-input', 'ios-swipe', 'ios-set-orientation', 'ios-tap-native', 'ios-input-native-text']);

function fail(code, message, details) {
  const dispatched = currentExecution()?.dispatched === true;
  return new CommandError(code, message, { dispatched, ambiguous: dispatched, ...(details ? { details } : {}) });
}

function binding(value) {
  if (value?.schemaVersion !== schemaVersion || typeof value?.bundleId !== 'string' || !/^[A-Za-z0-9_.-]{1,255}$/.test(value.bundleId)
    || typeof value?.runtimeEpoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.runtimeEpoch) || !Number.isSafeInteger(value?.processId)
    || value.processId < 1 || !Number.isInteger(value?.port) || value.port < 1 || value.port > 65535) {
    throw fail('invalid_ios_wda_binding', `Expected ${schemaVersion} Runner identity.`);
  }
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}

function target(value, session = false) {
  if (typeof value?.bundleId !== 'string' || !value.bundleId || !Number.isSafeInteger(value?.processId) || value.processId < 1
    || (session && (typeof value.sessionId !== 'string' || !value.sessionId))) throw fail('invalid_ios_wda_target', 'WDA must identify the exact foreground App process and session.');
  return Object.freeze({ bundleId: value.bundleId, processId: value.processId, ...(session ? { sessionId: value.sessionId } : {}) });
}

async function openWdaPort(provider, args, device) {
  if (!args.deviceId || !args.wdaRunnerBundleId) throw fail('ios_wda_target_required', 'WDA requires deviceId and the actual wdaRunnerBundleId from ios-setup.');
  device ??= await provider.requireDevice(args);
  if (![device.identifier, device.udid].includes(args.deviceId) || device.developerModeStatus !== 'enabled'
    || device.ddiServicesAvailable !== true || device.tunnelState !== 'connected') throw fail('ios_tunnel_unavailable', 'The selected WDA device must have a connected developer tunnel.');
  const descriptor = await provider.readContainerDescriptor(args, device, args.wdaRunnerBundleId, 'ai_app_bridge_wda.json');
  const runtime = binding(descriptor);
  if (descriptor.ok !== true || runtime.bundleId !== args.wdaRunnerBundleId) throw fail('ios_wda_binding_mismatch', 'The selected Runner container has no matching ready WDA descriptor.');
  let url;
  try {
    const host = device.tunnelIPAddress;
    if (!args.wdaUrl && !host) throw new Error('No developer tunnel IP');
    url = new URL(args.wdaUrl ?? `http://${host.includes(':') ? `[${host}]` : host}:${runtime.port}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid WDA URL');
  } catch (error) { throw fail('invalid_ios_wda_url', error.message); }
  const baseUrl = url.href.replace(/\/$/, '');
  const headers = { 'X-AAB-WDA-Schema': runtime.schemaVersion, 'X-AAB-WDA-Bundle-Id': runtime.bundleId,
    'X-AAB-WDA-Runtime-Epoch': runtime.runtimeEpoch, 'X-AAB-WDA-Process-Id': String(runtime.processId), 'X-AAB-WDA-Port': String(runtime.port) };
  let completedMutation = false;
  async function request(method, route, body, selected, mutation = method !== 'GET') {
    const boundHeaders = { ...headers, ...(selected ? { 'X-AAB-WDA-Target-Bundle-Id': selected.bundleId,
      'X-AAB-WDA-Target-Process-Id': String(selected.processId), ...(selected.sessionId ? { 'X-AAB-WDA-Session-Id': selected.sessionId } : {}) } : {}) };
    let response;
    // A managed event's response arrives from its original XCTest completion.
    // Its wait must use the admitted action budget, not the shorter read budget.
    const timeoutMs = route === '/aab/action' ? body.execution.timeoutMs : args.timeoutMs ?? 5000;
    try { response = await provider.httpRequest(method, `${baseUrl}${route}`, body, { headers: boundHeaders, timeoutMs, mutation }); }
    catch (error) {
      if (!error.response) throw error;
      response = error.response;
    }
    const actual = binding(response?.wdaBinding);
    if (fields.some(key => actual[key] !== runtime[key])) throw fail('ios_wda_binding_mismatch', 'WDA response does not belong to the Runner instance read from the selected device.');
    if (!Object.hasOwn(response, 'value')) throw fail('invalid_ios_wda_response', 'WDA response is missing its value.');
    if (route === '/aab/status' || route === '/aab/action' || route.startsWith('/aab/execution/')) {
      if (typeof response.value?.ok === 'boolean') {
        checkExecution();
        return response.value;
      }
    }
    const error = response.value?.error;
    if (error !== undefined) {
      if (typeof error !== 'string' || !error) throw fail('invalid_ios_wda_response', 'WDA error must be a nonempty string.');
      const rejected = /^ios_wda_|^invalid_ios_wda_/.test(error) && response.value.dispatched === false && response.value.ambiguous === false;
      throw new CommandError(rejected ? error : 'ios_wda_command_failed', response.value.message || error,
        { dispatched: rejected ? completedMutation : currentExecution()?.dispatched === true,
          ambiguous: rejected ? false : currentExecution()?.dispatched === true, details: { wdaError: error, response } });
    }
    checkExecution();
    if (mutation) completedMutation = true;
    return response.value;
  }
  async function session(required = true) {
    const status = await request('GET', '/aab/session', null);
    if (!status || !Object.hasOwn(status, 'session')) throw fail('invalid_ios_wda_session', 'WDA did not return session state.');
    if (!required) return status;
    if (status.session === null) throw fail('ios_wda_session_required', 'Create a session with ios-wda-session before reading or acting.');
    const selected = target(status.session, true);
    if (selected.bundleId !== args.bundleId || selected.sessionId !== args.wdaSessionId) throw fail('ios_wda_session_changed', 'The requested App/session does not match the bound WDA session.');
    return selected;
  }
  // An old unmodified WDA cannot ignore the binding headers and receive a write.
  const status = await request('GET', '/aab/status', null);
  if (status?.ok !== true || status.ready !== true || status.executionSchema !== 'aab.wda-execution/v1')
    throw fail('ios_wda_not_ready', 'The selected WDA Runner must expose a ready managed execution store.');
  return { device, baseUrl, runtimeBinding: runtime, request, session, status };
}

module.exports = { commands, openWdaPort, binding, target };
