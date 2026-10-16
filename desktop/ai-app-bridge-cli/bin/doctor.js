'use strict';

const { runExecution, currentExecution } = require('./shared-kernel/execution-scope');
const { execFileBounded } = require('./shared-kernel/execution-io');

const fields = {
  android: ['serial', 'packageName', 'adb', 'port'],
  ios: ['deviceId', 'bundleId', 'runtimeUrl', 'iosHost', 'iosPort', 'wdaUrl', 'wdaRunnerBundleId', 'devicectl', 'xcodebuild'],
  web: ['sessionId', 'runtimeEpoch', 'targetId'], host: [],
};
function schema() {
  const properties = { platform: { enum: Object.keys(fields), default: 'android' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 60000, default: 10000 }, full: { type: 'boolean' } };
  for (const name of Object.values(fields).flat()) properties[name] = { type: 'string', minLength: 1, maxLength: 4096 };
  for (const name of ['port', 'iosPort']) properties[name] = { type: 'integer', minimum: 1, maximum: 65535 };
  properties.packageName = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)*$' };
  return { type: 'object', additionalProperties: false, properties, oneOf: Object.entries(fields).map(([platform, allowed]) => ({
    ...(platform === 'android' ? {} : { required: ['platform'] }),
    properties: { platform: { const: platform }, ...Object.fromEntries(Object.values(fields).flat()
      .filter(name => !allowed.includes(name)).map(name => [name, false])) },
  })) };
}
function select(source, names) {
  return Object.fromEntries(names.filter(name => source?.[name] !== undefined).map(name => [name, source[name]]));
}
function sdkFacts(value, full) {
  if (full || value?.ok === false) return value;
  const result = select(value, ['ok', 'app', 'device', 'runtimeBinding', 'endpoint', 'debugBridge', 'capabilities']);
  if (value?.flutter) result.flutter = Object.fromEntries(Object.entries(value.flutter).filter(([key]) => !['layout', 'snapshot'].includes(key)));
  return result;
}
function hint(command, args, message) {
  require('./command-registry').validateCommandArguments(command, args);
  return { command, arguments: args, ...(message ? { message } : {}) };
}

async function doctor(args = {}, dependencies = {}) {
  return runExecution({ timeoutMs: args.timeoutMs ?? 10000, mutation: false, signal: dependencies.signal }, async () => {
    const platform = args.platform ?? 'android', checks = [], nextActions = [];
    const add = (name, status, facts) => { const item = { name, status, ...facts }; checks.push(item); return item; };
    const check = async (name, action) => {
      const item = add(name, 'running', {}), started = Date.now();
      try {
        item.facts = await action(); item.status = item.facts?.ok === false ? 'issue' : 'observed';
      } catch (error) {
        item.status = 'issue'; item.error = typeof error.code === 'string' ? error.code : 'diagnostic_probe_failed';
        item.message = String(error.message || error).slice(0, 4000);
      }
      item.durationMs = Date.now() - started;
      item.observedAtMs = Date.now();
      return item;
    };
    const environment = await check('host', () => (dependencies.inspectRuntime || require('./runtime-client').inspect)({ signal: currentExecution().signal }));
    const observed = environment.facts;
    if (observed?.mismatch) {
      const guidance = require('./shared-kernel/action-guidance').withActionGuidance('doctor', args, { ok: false, ...observed.mismatch }).guidance;
      if (guidance) { environment.guidance = guidance.message; nextActions.push(...guidance.nextActions); }
      environment.status = 'issue';
    }
    if (observed?.client.error) environment.status = 'issue';
    if (['unresponsive', 'starting'].includes(observed?.runtime?.state)) {
      environment.status = 'issue';
      nextActions.push(hint('runtime', { operation: 'status' }, 'Inspect the existing Runtime. Its OS lock is still owned; diagnosis did not restart it.'));
      nextActions.push(hint('runtime', { operation: 'force-stop' }, 'Explicitly stop the identified Host using its independent owner record if the endpoint is unavailable. Device effects remain unknown.'));
    }
    if (observed?.runtime?.ownerRecord?.error) {
      environment.status = 'issue';
      environment.ownerRecordError = observed.runtime.ownerRecord.error;
      nextActions.push(hint('runtime', { operation: 'status' }, 'The independent recovery identity is invalid. Inspect the working endpoint or OS process list before selecting an ownerPid for force-stop.'));
    }
    if (platform === 'android') await android();
    else if (platform === 'ios') await ios();
    else if (platform === 'web') web();
    for (const item of checks.filter(item => item.status === 'issue' && !item.guidance)) {
      const error = item.facts?.error || item.error;
      if (!error) continue;
      const guidance = require('./shared-kernel/action-guidance').withActionGuidance('doctor', args,
        { ok: false, ...(item.facts || {}), error, message: item.message || item.facts?.message }).guidance;
      if (guidance) { item.guidance = guidance.message; nextActions.push(...guidance.nextActions); }
    }
    const unique = new Map(nextActions.map(action => [JSON.stringify([action.command, action.arguments]), action]));
    return { ok: true, platform, observedAtMs: Date.now(), checks, issueCount: checks.filter(item => item.status === 'issue').length,
      nextActions: [...unique.values()],
      message: 'Diagnostic observations only. Each execution path is reported separately; no app launch, input, cancellation or runtime reset was performed.' };

    async function android() {
      const adb = args.adb ?? process.env.ADB ?? 'adb';
      const run = async (argv, targeted = true) => (await (dependencies.execFile || execFileBounded)(adb,
        targeted && args.serial ? ['-s', args.serial, ...argv] : argv,
        { timeoutMs: args.timeoutMs ?? 10000, mutation: false, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })).stdout;
      const inventory = await check('android.devices', async () => {
        const raw = await run(['devices', '-l'], false);
        return { devices: raw.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('List of devices') && !line.startsWith('*'))
          .map(line => { const [serial, state, ...details] = line.trim().split(/\s+/); return { serial, state, details: details.join(' ') }; }) };
      });
      if (!args.serial) {
        for (const device of inventory.facts?.devices || []) nextActions.push(hint('doctor', { platform: 'android', serial: device.serial,
          ...select(args, ['packageName', 'adb', 'port']) }, `Inspect ${device.state} device.`));
        add('android.target', 'not_run', { message: 'Pass serial to inspect one device; no device was selected implicitly.' }); return;
      }
      const lease = dependencies.lease || require('./shared-kernel/device-mutation-lease').getProcessDeviceMutationLease();
      const owner = await check('android.ownership', () => lease.status(args.serial));
      if (owner.facts?.active || owner.facts?.unresolved) {
        owner.guidance = owner.facts.active ? 'A live operation owns the device. Read-only diagnosis remains available.'
          : 'Old work has an unknown outcome. New explicit work may continue; archives preserve the original identities.';
        nextActions.push(hint('device-ownership', { operation: 'status', serial: args.serial }));
        if (owner.facts.unresolved) nextActions.push(hint('device-ownership', { operation: 'archives', serial: args.serial }));
      }
      const target = inventory.facts?.devices.find(device => device.serial === args.serial);
      if (target && target.state !== 'device') {
        add('android.transport', 'issue', { facts: target || { serial: args.serial },
          message: target?.state === 'unauthorized' ? 'Unlock the device and accept its USB debugging authorization, then run doctor again.'
            : 'The requested ADB transport is not connected. Check its USB/network connection; no downstream probes were attempted.' }); return;
      }
      const identity = { ...select(args, fields.android), adb, ...select(args, ['timeoutMs']) };
      await Promise.all([
        check('android.device', async () => {
          const raw = await run(['shell', 'getprop']);
          const properties = Object.fromEntries([...raw.matchAll(/^\[([^\]]+)\]: \[(.*)\]$/gm)].map(match => [match[1], match[2]]));
          const drawingDisabled = ['0', 'false'].includes(properties['debug.hwui.drawing_enabled']);
          if (drawingDisabled) nextActions.push(hint('adb-exec', { serial: args.serial, adb, readOnly: true,
            argv: ['shell', 'getprop', 'debug.hwui.drawing_enabled'] },
          'Hardware drawing is disabled, as on ATD images. Native/H5 screenshots may be blank or stale. Use a full Android image for visual acceptance; command execution is still available.'));
          return { serial: args.serial, properties: select(properties, ['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release', 'ro.build.version.sdk', 'sys.boot_completed']),
            rendering: { drawingEnabled: drawingDisabled ? false : ['1', 'true'].includes(properties['debug.hwui.drawing_enabled']) ? true : null,
              renderer: properties['debug.hwui.renderer'] || null,
              ...(drawingDisabled ? { warning: 'hardware_drawing_disabled', message: 'Native/H5 screenshots may be blank or stale; this environment is unsuitable for visual acceptance.' } : {}) },
            ...(args.full ? { raw } : {}) };
        }),
        check('android.forwards', async () => ({ entries: (await run(['forward', '--list'], false)).split(/\r?\n/).filter(Boolean)
          .map(line => { const [serial, local, remote] = line.split(/\s+/); return { serial, local, remote }; }).filter(entry => entry.serial === args.serial) })),
        check('android.foreground', async () => {
          const provider = require('./device-provider'), raw = await run(['shell', 'dumpsys', 'window', '-a']);
          const focus = provider.parseForegroundWindow(raw);
          const foreground = require('./shared-kernel/android-foreground-identity').parseForegroundWindowIdentity(raw, focus);
          const { evidence, ...facts } = foreground;
          return { ...facts, verification: 'window-dump-only',
            lockIndicators: raw.split(/\r?\n/).filter(line => /\b(?:mKeyguardShowing|mShowingLockscreen|isStatusBarKeyguard)\s*=/.test(line)).map(line => line.trim()),
            ...(args.full ? { evidence } : {}),
            ...(args.packageName && foreground.packageName && args.packageName !== foreground.packageName
              ? { note: 'A different package is in front. This is observation data, not a refusal to use the requested package.' } : {}) };
        }),
        check('android.uia', async () => {
          const result = await (dependencies.uiaStatus || (options => require('./shared-kernel/uia-runtime-port').createUiaRuntimePort(options).control('status')))(identity);
          if (result.ok && result.running === false) nextActions.push(hint('uia-runtime', { operation: 'start', serial: args.serial, ...select(args, ['adb']) }, 'Start UIA if this task needs system-level nodes.'));
          return result;
        }),
        args.packageName ? check('android.app', async () => {
          const raw = await run(['shell', 'pm', 'path', args.packageName]);
          const paths = raw.split(/\r?\n/).filter(line => line.startsWith('package:')).map(line => line.slice(8));
          let pids;
          try { pids = (await run(['shell', 'pidof', args.packageName])).trim().split(/\s+/).filter(Boolean); }
          catch (error) { if (error.code !== 1 || String(error.stdout || '').trim() || String(error.stderr || '').trim()) throw error; pids = []; }
          return { packageName: args.packageName, installed: paths.length > 0, apkPaths: paths, pids, running: pids.length > 0 };
        }) : Promise.resolve(),
        args.packageName ? check('android.sdk', async () => {
          const result = await (dependencies.androidStatus || (options => require('./device-provider').executeProviderCommand('status', options)))(
            { ...identity, ...select(args, ['full']) });
          if (result.ok === false) nextActions.push(hint('status', identity, 'Inspect this App SDK connection; independent ADB/UIA paths remain available.'));
          return sdkFacts(result, args.full);
        }) : Promise.resolve(add('android.sdk', 'not_run', { message: 'packageName was omitted. Device/UIA diagnosis does not require an App SDK.' })),
      ]);
    }
    async function ios() {
      const result = await check('ios', () => (dependencies.iosDoctor || (options => new (require('./ios-provider').IOSBridgeProvider)().doctor(options)))(args));
      if (!result.facts || result.facts.ok === false) return;
      const facts = result.facts;
      // The legacy all-providers readiness bit is not a gate for another path.
      result.facts = { devices: facts.devices, selectedDevice: facts.selectedDevice, paths: facts.paths, checks: facts.checks,
        runtime: sdkFacts(facts.runtime, args.full), wda: facts.wda };
      result.status = facts.checks.some(item => item.ok === false && item.error !== 'bundle_id_or_runtime_endpoint_required' && item.error !== 'ios_wda_target_required') ? 'issue' : 'observed';
      if (args.bundleId && args.deviceId) nextActions.push(hint('ios-status', select(args, ['deviceId', 'bundleId', 'runtimeUrl', 'iosHost', 'iosPort', 'devicectl'])));
      if (args.wdaRunnerBundleId && args.deviceId) nextActions.push(hint('ios-wda-status', select(args, ['deviceId', 'wdaRunnerBundleId', 'wdaUrl', 'devicectl'])));
    }
    function web() {
      const diagnostics = observed?.runtime?.diagnostics;
      if (!diagnostics) {
        add('web', 'not_run', { message: observed?.runtime?.state === 'stopped'
          ? 'The shared Runtime is stopped, so it has no live Web provider. Start a Web session when needed.'
          : 'This Runtime did not expose Web diagnostics. Align the client/Runtime installation to obtain this view.' });
        if (observed?.runtime?.state === 'stopped') nextActions.push(hint('web-session-start', {}));
        return;
      }
      add('web.provider', 'observed', { facts: diagnostics.web });
      const sessions = diagnostics.sessions.sessions.filter(session => args.sessionId ? session.sessionId === args.sessionId
        : !args.targetId || session.targetId === args.targetId);
      add('web.sessions', (args.sessionId || args.targetId) && sessions.length === 0 ? 'issue' : 'observed', { facts: { sessions } });
      if (sessions.some(session => args.runtimeEpoch && session.runtimeEpoch !== args.runtimeEpoch || args.targetId && session.targetId !== args.targetId))
        add('web.identity', 'issue', { message: 'The observed session has a different runtimeEpoch or targetId. Choose the current session explicitly before a new action.',
          expected: select(args, fields.web) });
      for (const session of sessions) nextActions.push(hint('web-status', { sessionId: session.sessionId }));
    }
  });
}

module.exports = { doctor, schema, fields };
