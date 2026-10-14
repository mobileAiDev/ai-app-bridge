'use strict';

// A selection failure is a request for information, not an uncertain dispatch.
// Candidates carry actual selectors/references, never a guessed first match.
function selectionFailure(error, candidates) {
  return { ok: false, error, dispatched: false, ambiguous: false,
    selectionRequired: candidates.length > 1, matched: candidates.length,
    candidates, candidatesTruncated: false,
    message: candidates.length ? 'Several controls match. Select a candidate by its selector or targetRef.'
      : 'No control matches this selector in the current observation. Observe again or change the selector.' };
}

function withActionGuidance(command, args, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return value;
  const candidates = value.candidates || value.details?.candidates;
  const calls = [];
  const call = (name, parameters = {}) => {
    const { commandSchema, validateCommandArguments } = require('../command-registry');
    const schema = commandSchema(name);
    const identity = Object.fromEntries(['serial', 'packageName', 'adb', 'port', 'deviceId', 'bundleId', 'runtimeUrl', 'iosHost', 'iosPort',
      'wdaUrl', 'wdaRunnerBundleId', 'wdaSessionId', 'sessionId', 'runtimeEpoch', 'targetId', 'webViewId', 'adapterId']
      .filter(key => args?.[key] !== undefined && schema.properties?.[key]).map(key => [key, args[key]]));
    const arguments_ = { ...identity, ...parameters };
    try { validateCommandArguments(name, arguments_); }
    catch { return null; } // A hint must itself be executable for the known target.
    return { command: name, arguments: arguments_, extract: null };
  };
  if (candidates?.length) {
    const schema = command === 'intent' ? null : require('../command-registry').commandSchema(command);
    for (const candidate of candidates.slice(0, 5)) {
      if (candidate.targetRef && command === 'tap-uia') {
        calls.push(call('tap-uia', { targetRef: candidate.targetRef, packageName: candidate.packageName }));
      } else if (candidate.selector && schema?.properties?.selector) {
        const original = Object.fromEntries(Object.entries(args).filter(([key]) => schema.properties[key]
          && !['requestId', 'targetRef', 'expectedTarget'].includes(key)));
        calls.push(call(command, { ...original, selector: candidate.selector }));
      } else if (candidate.selector && ['flutter-action', 'ios-flutter-action'].includes(command)) {
        const payload = { ...args.payload, selector: candidate.selector };
        if (payload.action === 'tapText') { payload.action = 'tapTarget'; delete payload.text; }
        calls.push(call(command, { payload }));
      } else if (candidate.action && command !== 'intent') calls.push(call(candidate.action.command, candidate.action.arguments));
      else if (candidate.selector?.nodeId && ['tap-text', 'tap-flutter-text'].includes(command))
        calls.push(call('tap-flutter', { selector: candidate.selector }));
    }
    if (value.details?.candidateQuery) calls.push(call('web-dom', value.details.candidateQuery));
  }
  const code = value.error;
  const managedProvider = { 'aab.flutter-execution/v1': 'flutter', 'aab.h5-execution/v1': 'h5' }[value.request?.execution?.schemaVersion];
  let message;
  if (code && value.source === 'uia-node-runtime' && value.ambiguous === true
    && value.recovery?.error === 'uia_runtime_unreachable') {
    message = 'UIA disconnected during this action; its outcome is unknown. Check for a retained original receipt, restart UIA and inspect the screen before deciding whether to repeat it. If startup remains stuck, force-reset archives the history. These suggestions do not replay the action.';
    calls.push(call('device-ownership', { operation: 'receipt', runtimeEpoch: value.runtimeEpoch, actionId: value.actionId }),
      call('uia-runtime', { operation: 'start' }), call('uia-tree', { compact: true, maxNodes: 200 }),
      call('uia-runtime', { operation: 'force-reset' }));
  } else if (code && managedProvider && args?.serial && value.ambiguous === true && value.settled === false) {
    message = `${managedProvider === 'flutter' ? 'Flutter' : 'WebView'} did not confirm this action. Its outcome stays unknown. Inspect the original archive and current UI; launch the app if it exited. If stuck, force-stop stops related Host tasks. These suggestions do not replay the action.`;
    calls.push(call('device-ownership', { operation: 'status' }),
      call('device-ownership', { operation: 'archives', actionId: value.actionId }),
      call(managedProvider === 'flutter' ? 'flutter-nodes' : 'h5-dom'), call('launch-app'),
      call('device-ownership', { operation: 'force-stop' }));
  } else if (code && value.details?.shellExecution && value.ambiguous === true) {
    message = 'Shell completion is unknown. Inspect the current screen and the original action record before choosing whether to retry. No command was replayed.';
    calls.push(call('device-ownership', { operation: 'status' }));
    calls.push(call('device-ownership', { operation: 'archives', actionId: value.details.shellExecution.identity.actionId }));
    calls.push(call('uia-tree', { compact: true, maxNodes: 200 }));
  } else if (command === 'wait-text' && code && value.lastCheck?.absenceProven === false
    && !value.lastCheck.missing?.length && !value.lastCheck.unexpected?.length && value.lastCheck.activityMatches) {
    message = 'No forbidden label was found in the returned portion, but the provider did not establish complete coverage. Inspect the tree or choose absenceScope:observed to test only that portion.';
    const observe = { native: 'tree', uia: 'uia-tree', flutter: 'flutter-nodes' }[value.lastCheck.provider];
    if (observe) calls.push(call(observe));
    calls.push(call('wait-text', { ...args, absenceScope: 'observed' }));
  } else if (command === 'wait-text' && code === 'observation_unavailable') {
    message = 'Observation reads failed within the deadline. Inspect failures, use UIA to check system dialogs, or diagnose the app connection; no action was replayed.';
    calls.push(call('uia-tree', { compact: true, maxNodes: 200 }));
    calls.push(call('doctor', { platform: 'android', serial: args.serial, packageName: args.packageName }));
  } else if (command === 'wait-text' && code === 'deadline_exceeded') {
    message = 'Expected text did not appear before the deadline. observedText summarizes the last successful read. Inspect current system/app windows before choosing recovery or a longer wait; no action was replayed.';
    calls.push(call('uia-tree', { compact: true, maxNodes: 200 }));
    calls.push(call('doctor', { platform: 'android', serial: args.serial, packageName: args.packageName }));
  } else if (['runtime_owner_unidentified', 'runtime_owner_invalid', 'runtime_owner_mismatch'].includes(code)) {
    message = 'Inspect the Host paths and OS process identity with doctor. If both owner records are lost, runtime --operation force-stop --owner-pid <PID> selects the intended Bridge Host; it does not depend on a working endpoint.';
    calls.push(call('doctor', { platform: 'host' }));
  } else if (['runtime_unresponsive', 'runtime_stopping', 'runtime_endpoint_invalid', 'runtime_force_stop_incomplete'].includes(code)
    || command === 'runtime' && code === 'runtime_connection_timeout') {
    message = 'Inspect runtime status. If orderly stop cannot finish, runtime force-stop terminates the identified Host and keeps evidence; already dispatched device work remains unknown.';
    calls.push(call('runtime', { operation: 'status' }), call('runtime', { operation: 'force-stop' }));
  } else if (command === 'intent' && value.operationId && code && !candidates?.length && !value.guidance) {
    message = 'The failed step was not replayed. Inspect lastAction and observationFailure, issue a command action to diagnose or recover, observe again, or cancel this Intent.';
    calls.push(call('intent', { operation: 'observe', operationId: value.operationId }), call('intent', { operation: 'cancel', operationId: value.operationId }));
  } else if (code === 'web_element_not_found' && command.startsWith('web-') && !value.guidance) {
    const selector = args.selector ?? args.arguments?.selector;
    message = 'No control currently matches. Inspect the current page and selector. If the control is still loading, you may choose the suggested wait. The original action was not replayed.';
    calls.push(call('web-dom', selector && selector.elementId === undefined ? { query: selector } : {}));
    if (selector?.elementId === undefined && selector) calls.push(call('web-wait', { selector }));
    else if (selector?.elementId !== undefined) message = 'The observed elementId is absent. Read the current page and choose a current control. The original action was not replayed.';
  } else if (candidates?.length) message = 'Choose the intended candidate. The suggested calls have not been executed.';
  else if (code === 'reobserve_required' && (command.includes('h5') || command.startsWith('web-'))) {
    const observe = command.startsWith('ios-flutter-h5-') ? 'ios-flutter-h5-dom'
      : command.startsWith('flutter-h5-') ? 'flutter-h5-dom' : command.startsWith('ios-h5-') ? 'ios-h5-dom'
        : command.startsWith('web-') ? 'web-dom' : 'h5-dom';
    message = 'The document, element or checked geometry changed. Read the current page and choose its elementId; the previous action was not replayed.';
    calls.push(call(observe));
  } else if (['android_h5_snapshot_truncated', 'ios_h5_snapshot_truncated', 'flutter_h5_snapshot_truncated', 'web_dom_snapshot_truncated'].includes(code)) {
    message = 'This observation is partial. Choose an elementId already present in the returned controls. Text matches outside this observation have not been ruled out.';
  } else if (['native_target_replaced', 'native_runtime_changed', 'native_window_changed', 'native_target_changed',
    'native_selector_not_found', 'native_scope_not_found', 'native_scope_anchor_not_found', 'native_scope_ancestor_not_found'].includes(code)) {
    message = 'Read the current View tree and choose its viewId, or combine text, className and within. The original action was not replayed.';
    if (code === 'native_target_changed') message += ' Older SDKs reject attribute changes; update the app SDK to receive a warning for the same View.';
    calls.push(call('tree', { compact: true }));
  } else if (['tap-native', 'input-text', 'native-gesture'].includes(command)
    && ['invalid_argument', 'unsupported_argument'].includes(code) && /^selector(?:\.|$)/.test(value.field || '')) {
    message = 'The app SDK did not accept this selector. Older SDKs support one exact text, resourceName or contentDescription condition; update the app SDK for compound queries and direct container scopes.';
    calls.push(call('tree', { compact: true }));
  } else if (['flutter_observation_timeout', 'flutter_observation_busy', 'flutter_runtime_changed',
    'flutter_action_handler_absent', 'flutter_runtime_shutdown'].includes(code)) {
    const ios = command.startsWith('ios-');
    message = 'Flutter controls are not currently available. Read them again after app readiness, or inspect the app connection and system dialogs. The original action was not replayed; an unknown action outcome still needs verification.';
    calls.push(call(ios ? 'ios-flutter-nodes' : 'flutter-nodes'));
    calls.push(ios ? call('doctor', { platform: 'ios' }) : call('uia-tree', { compact: true, maxNodes: 200 }));
  } else if (['uia_stale_reference', 'uia_stale_runtime', 'uia_reobserve_required', 'uia_bound_observation_required', 'uia_tree_changed',
    'uia_reference_selector_mismatch',
    'uia_focused_window_unavailable', 'uia_focused_root_unavailable', 'uia_target_not_found', 'uia_selector_not_found',
    'uia_scope_not_found', 'uia_scope_anchor_not_found', 'uia_scope_ancestor_not_found'].includes(code)) {
    message = 'The stored UIA target is unavailable. Read current nodes and choose a new targetRef; screenshot and coordinate tap are also available.';
    calls.push(call('uia-tree', { compact: true }));
  } else if (code === 'uia_runtime_not_ready' || code === 'uia_runtime_already_running') {
    message = 'UIA readiness is not confirmed. Check status; start can wait for the same process without replaying actions. If it remains stuck, force-reset archives the UIA history and releases its process.';
    calls.push(call('uia-runtime', { operation: 'status' }), call('uia-runtime', { operation: 'start', timeoutMs: 30000 }), call('uia-runtime', { operation: 'force-reset' }));
  } else if (code === 'uia_runtime_version_mismatch') {
    message = 'The installed UIA bundle differs from the running process. Check status, stop the old runtime after its actions settle, then start this bundle. A normal stop retains the action history.';
    calls.push(call('uia-runtime', { operation: 'status' }), call('uia-runtime', { operation: 'stop' }), call('uia-runtime', { operation: 'start' }));
  } else if (['uia_runtime_unreachable', 'uia_runtime_start_failed', 'uia_action_capacity_exhausted'].includes(code)) {
    message = 'Inspect or restart the UIA runtime. If it remains stuck, force-reset archives its history with unknown outcomes and starts fresh on the next observation.';
    calls.push(call('uia-runtime', { operation: 'start' }), call('uia-runtime', { operation: 'force-reset' }));
  } else if (['target_busy', 'device_ownership_unresolved', 'device_ownership_corrupt', 'device_reset_required', 'uia_owned_by_test_executor'].includes(code)) {
    message = 'Inspect the current owner. To take over stuck work, force-stop cancels old tasks and resets this device; already dispatched effects are not undone.';
    if (args?.serial) calls.push(call('device-ownership', { operation: 'status' }), call('device-ownership', { operation: 'force-stop' }));
    else message = 'Another operation is active or has an unknown outcome. Inspect its operation status and use the platform execution controls to cancel or reconcile it.';
  } else if (code === 'runtime_code_mismatch') {
    const side = value.details?.outdatedSide;
    message = 'The client and Runtime load different builds. Inspect runtime status; stop/start explicitly loads this client build and stops existing Runtime tasks. Fingerprints do not establish which build is newer.';
    calls.push(call('runtime', { operation: 'status' }));
    if (side !== 'client') calls.push(call('runtime', { operation: 'stop' }), call('runtime', { operation: 'start' }));
    else if (side === 'client') message = 'Update and reconnect this MCP client; the shared runtime is newer. Its active tasks can stay running.';
  } else if (command !== 'doctor' && ['bridge_not_ready', 'bridge_connection_refused', 'bridge_forward_mismatch',
    'bridge_endpoint_discovery_failed', 'adb_timeout', 'runtime_connection_lost', 'runtime_connection_timeout',
    'client_installation_invalid', 'runtime_unavailable', 'ios_runtime_unavailable', 'wda_unavailable'].includes(code)) {
    message = 'Read transport and provider status together with doctor, then choose a recovery step. Diagnosis does not restart apps or replay this command.';
    const platform = ['runtime_connection_lost', 'runtime_connection_timeout', 'client_installation_invalid'].includes(code)
      ? 'host' : command.startsWith('ios-') ? 'ios' : command.startsWith('web-') ? 'web' : 'android';
    const parameters = { platform, ...Object.fromEntries(require('../doctor').fields[platform]
      .filter(key => args?.[key] !== undefined).map(key => [key, args[key]])) };
    // doctor has a platform-specific schema, so pass only that platform's fields.
    try { require('../command-registry').validateCommandArguments('doctor', parameters); calls.push({ command: 'doctor', arguments: parameters }); }
    catch { /* A partial target can still be inspected through the directory. */ }
  }
  if (!message) return value;
  const selection = value.details?.candidates && !value.candidates ? Object.fromEntries(
    ['matched', 'selectionRequired', 'candidatesTruncated'].filter(key => value.details[key] !== undefined).map(key => [key, value.details[key]])) : {};
  return { ...value, ...selection, ...(candidates ? { candidates } : {}), guidance: { message, nextActions: calls.filter(Boolean) } };
}

module.exports = { selectionFailure, withActionGuidance };
