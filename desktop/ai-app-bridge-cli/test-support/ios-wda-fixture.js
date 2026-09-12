'use strict';

const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { executeCommand } = require('./host-client');
const { stopRuntime } = require('./runtime-control');
const { createIOSRuntimeFixture } = require('./ios-runtime-fixture');

// Real local HTTP and devicectl child, with durable fixture completions. The
// Foundation checks separately exercise the production native segmented store.
async function createWDAFixture(t, { session = { bundleId: 'sample.app', processId: 501, sessionId: 'session-1' }, mode = 'complete' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wda-target-'));
  const runtimeEnv = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'runtime-facts') };
  t.after(async () => { await stopRuntime({ env: runtimeEnv }); fs.rmSync(directory, { recursive: true, force: true }); });
  const state = { session, foreground: { bundleId: 'sample.app', processId: 501 }, calls: [], actions: [],
    old: false, matches: 1, error: null, beforeWrite: null, dropResponse: false, mode };
  const effects = path.join(directory, 'effects.jsonl'), completionFile = path.join(directory, 'completion.json');
  let submitted, originalResponse;
  const entered = new Promise(resolve => { submitted = resolve; });
  function complete(body = state.actions.at(-1), { cancelled = false, dispatched = true, wrongTarget = false } = {}) {
    const target = { ...body.target, runnerBundleId: device.binding.bundleId, operation: body.operation };
    if (wrongTarget) target.bundleId = 'wrong.app';
    const { timeoutMs, ...identity } = body.execution;
    const result = { ok: !cancelled, ...(cancelled ? { error: 'ios_wda_action_cancelled' } : {}), actionId: body.actionId,
      runtimeEpoch: identity.runtimeEpoch, settled: true, dispatched, ambiguous: false, execution: { ...identity, target, settled: true },
      value: body.operation === 'session-create' ? state.session : null };
    const fd = fs.openSync(completionFile, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(result)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return result;
  }
  function lookup(identity) {
    if (!fs.existsSync(completionFile)) return { ok: true, found: false, settled: false, hasMore: false };
    const bytes = fs.readFileSync(completionFile), result = JSON.parse(bytes);
    if (result.actionId !== identity.actionId || result.runtimeEpoch !== identity.runtimeEpoch) return { ok: true, found: false, settled: false, hasMore: false };
    return { ok: true, found: true, actionId: result.actionId, runtimeEpoch: result.runtimeEpoch, executionResult: result,
      receipt: { committed: state.receiptMissing !== true, sequence: 1, sha256: createHash('sha256').update(bytes).digest('hex') } };
  }
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://localhost');
    state.calls.push({ method: req.method, route: req.url, body, headers: req.headers });
    const reply = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify({ ...(state.old ? {} : { wdaBinding: device.binding }), value })); };
    const reject = error => reply({ error, message: error, dispatched: false, ambiguous: false }, 409);
    const expected = { 'x-aab-wda-schema': device.binding.schemaVersion, 'x-aab-wda-bundle-id': device.binding.bundleId,
      'x-aab-wda-runtime-epoch': device.binding.runtimeEpoch, 'x-aab-wda-process-id': String(device.binding.processId), 'x-aab-wda-port': String(device.binding.port) };
    if (Object.entries(expected).some(([key, value]) => req.headers[key] !== value)) return reject('ios_wda_binding_mismatch');
    if (url.pathname === '/aab/status') return reply({ ok: true, ready: true, executionSchema: 'aab.wda-execution/v1', active: null,
      ...(state.orientationSchema ? { orientationSchema: state.orientationSchema } : {}),
      ...(state.nativeTargetSchema ? { nativeTargetSchema: state.nativeTargetSchema } : {}) });
    if (url.pathname === '/aab/execution/result') return reply(lookup(Object.fromEntries(url.searchParams)));
    if (url.pathname === '/aab/execution/cancel') {
      const original = state.actions.find(a => a.actionId === body.actionId && a.execution.runtimeEpoch === body.runtimeEpoch);
      if (original && state.mode === 'queued') {
        const result = complete(original, { cancelled: true, dispatched: false });
        originalResponse?.end(JSON.stringify({ wdaBinding: device.binding, value: result }));
        return reply(lookup(body));
      }
      const record = lookup(body);
      return reply(record.found ? record : { ok: false, error: 'ios_wda_action_cancel_pending', ...body,
        schemaVersion: 'aab.wda-execution/v1', settled: false, dispatched: null, ambiguous: true });
    }
    if (url.pathname === '/aab/session' && req.method === 'GET') return reply({ session: state.session, foreground: state.foreground });
    if (state.beforeWrite && url.pathname === '/aab/action') { state.beforeWrite(); state.beforeWrite = null; }
    const selected = body?.operation === 'session-close' ? state.session : state.foreground;
    if (!selected || req.headers['x-aab-wda-target-bundle-id'] !== selected.bundleId
      || req.headers['x-aab-wda-target-process-id'] !== String(selected.processId)) return reject('ios_wda_target_changed');
    if (url.pathname === '/aab/action') {
      if (body.operation !== 'session-create' && req.headers['x-aab-wda-session-id'] !== state.session?.sessionId) return reject('ios_wda_session_changed');
      if (state.error) return reply({ error: state.error, message: 'upstream WDA failure' });
      if (body.operation === 'session-create') {
        if (state.session) return reject('ios_wda_session_busy');
        state.session = { ...state.foreground, sessionId: 'created-session' };
      }
      if (body.operation === 'session-close') state.session = null;
      state.onAction?.(body);
      state.actions.push(body); originalResponse = res; submitted(body);
      if (state.mode !== 'queued') fs.appendFileSync(effects, JSON.stringify({ route: req.url, body }) + '\n');
      if (state.dropResponse) {
        if (state.completeBeforeDrop) complete(body);
        return res.destroy();
      }
      if (state.mode !== 'complete') return;
      if (state.responseDelayMs) await new Promise(resolve => setTimeout(resolve, state.responseDelayMs));
      return reply(complete(body));
    }
    if (req.headers['x-aab-wda-session-id'] !== state.session?.sessionId || !req.url.startsWith('/session/' + state.session?.sessionId + '/')) return reject('ios_wda_session_changed');
    if (state.error) return reply({ error: state.error, message: 'upstream WDA failure' });
    if (url.pathname.endsWith('/source')) return reply(state.tree ?? { type: 'Application', children: [] });
    if (url.pathname.endsWith('/elements')) return reply(Array.from({ length: state.matches }, (_, index) => ({ 'element-6066-11e4-a52e-4f735466cecf': 'editor-' + index })));
    return reject('ios_wda_route_unsupported');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const device = createIOSRuntimeFixture(directory, { bundleId: 'sample.runner.xctrunner', port: server.address().port,
    udid: path.basename(directory), schemaVersion: 'aab.ios-wda/v1', descriptorFilename: 'ai_app_bridge_wda.json' });
  const args = { deviceId: device.args.deviceId, devicectl: device.devicectl, wdaRunnerBundleId: device.binding.bundleId,
    wdaUrl: 'http://127.0.0.1:' + server.address().port };
  return { state, device, args, runtimeEnv, effects, completionFile, complete, submitted: entered,
    restart() { device.binding.runtimeEpoch = 'new-runner'; device.binding.processId = 99; device.update({ descriptor: { ...device.binding, ok: true } }); },
    readEffects() { return fs.existsSync(effects) ? fs.readFileSync(effects, 'utf8').trim().split('\n').map(JSON.parse) : []; },
    run(command, extra = {}) { return executeCommand(command, { ...args, ...extra }); },
    cli(command, extra = {}) {
      const flags = { ...args, ...extra }, argv = [path.resolve(__dirname, '../bin/ai-app-bridge.js'), command];
      for (const [key, value] of Object.entries(flags)) argv.push('--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), String(value));
      const child = spawn(process.execPath, argv, { env: { ...process.env, ...runtimeEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
      return { child, exited };
    },
  };
}
module.exports = { createWDAFixture };
