'use strict';

// Controlled HTTP peer and virtual ADB files. This verifies Host transport and
// process recovery; Android node binding is verified by JVM and device tests.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { uiaXml } = require('./uia-target-fixture');

const schemaVersion = 'aab.uia.execution.v1';
const root = '/data/local/tmp/ai-app-bridge-uia/v1';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const phoneFile = (directory, remote) => path.join(directory, 'phone', remote.slice(root.length));

function acknowledgeRecord(directory, identity, activeEpoch = null) {
  if (identity.runtimeEpoch === activeEpoch) return { httpStatus: 409, ok: false, error: 'uia_active_session_requires_engine' };
  const sessionPath = `${root}/sessions/${identity.runtimeEpoch}`;
  const file = phoneFile(directory, `${sessionPath}/actions/${identity.actionSha256}.json`);
  if (!fs.existsSync(file)) return { ok: true, schemaVersion: 'aab.uia.ack.v1', identity, disposition: 'not_retained' };
  const record = JSON.parse(fs.readFileSync(file)), peer = JSON.parse(fs.readFileSync(phoneFile(directory, `${sessionPath}/runtime.json`)));
  const protocol = require('../bin/shared-kernel/uia-protocol');
  const original = { kind: 'uia-node', schemaVersion, bootId: record.bootId, runtimeEpoch: record.runtimeEpoch, actionId: record.actionId,
    requestJson: record.requestJson, requestSha256: record.requestSha256,
    target: { adb: 'controlled-adb', serial: 'controlled-phone', root, sessionPath, dexSha256: peer.dexSha256 } };
  if (!protocol.recordResponse(record, original) || record.bootId !== identity.bootId || peer.dexSha256 !== identity.originalDexSha256
    || record.requestSha256 !== identity.requestSha256 || record.receiptSha256 !== identity.receiptSha256)
    return { httpStatus: 409, ok: false, error: 'uia_completion_identity_mismatch' };
  record.acknowledged = true; save(file, record);
  return { ok: true, schemaVersion: 'aab.uia.ack.v1', identity, disposition: 'acknowledged' };
}

function recoverRecord(directory, identity) {
  const sessionPath = `${root}/sessions/${identity.runtimeEpoch}`;
  const file = phoneFile(directory, `${sessionPath}/actions/${identity.actionSha256}.json`);
  if (!fs.existsSync(file)) return { ok: false, error: 'uia_original_action_record_not_retained' };
  const raw = fs.readFileSync(file, 'utf8'), record = JSON.parse(raw);
  const peer = JSON.parse(fs.readFileSync(phoneFile(directory, `${sessionPath}/runtime.json`)));
  if (record.bootId !== identity.bootId || record.requestSha256 !== identity.requestSha256 || peer.dexSha256 !== identity.originalDexSha256)
    return { ok: false, error: 'uia_completion_identity_mismatch' };
  if (record.phase === 'terminal') return record;
  if (!['prepared', 'queued'].includes(record.phase)) return { ok: false, error: 'uia_previous_action_unresolved' };
  const receipt = { schemaVersion, bootId: record.bootId, runtimeEpoch: record.runtimeEpoch, actionId: record.actionId,
    requestSha256: record.requestSha256, settled: true, ok: false, dispatched: false, ambiguous: false,
    completion: 'recovered_before_admission', error: 'uia_owner_exited_before_admission',
    recovery: { authority: 'exclusive_runtime_root_lock', bootId: peer.bootId, observedAtElapsedMs: 200,
      priorPhase: record.phase, priorRecordSha256: sha256(raw), preparedAtElapsedMs: record.preparedAtElapsedMs,
      originalDexSha256: peer.dexSha256, recoveryDexSha256: peer.dexSha256 } };
  record.phase = 'terminal'; record.receiptJson = JSON.stringify(receipt); record.receiptSha256 = sha256(record.receiptJson);
  save(file, record); return record;
}

function handleUiaRuntimeFixture(args, { directory, descriptorReady } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json')));
  if (args[0] !== '-s' || args[1] !== config.serial) return false;
  fs.appendFileSync(path.join(directory, 'adb.jsonl'), JSON.stringify(args) + '\n');
  if (args[2] === 'push' && args[4]?.startsWith(root + '/runtime-')) {
    const file = phoneFile(directory, args[4]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(args[3], file); return true;
  }
  if (args[2] === 'forward' && args[3] === '--list') {
    process.stdout.write(fs.readFileSync(path.join(directory, 'forwards.txt'))); return true;
  }
  if (args[2] === 'forward' && args[3] === 'tcp:0') {
    const mapping = `${config.serial} tcp:${config.port} ${args[4]}\n`;
    // This controlled peer reuses one HTTP listener across epochs. Retire its
    // old virtual forward rather than representing two mappings on one TCP port.
    const file = path.join(directory, 'forwards.txt');
    const others = fs.readFileSync(file, 'utf8').split('\n').filter(line => line && line.split(' ')[1] !== `tcp:${config.port}`);
    fs.writeFileSync(file, [...others, mapping.trim()].join('\n') + '\n');
    process.stdout.write(String(config.port)); return true;
  }
  if (args[2] === 'forward' && args[3] === '--remove') {
    const file = path.join(directory, 'forwards.txt');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(line => line && line.split(' ')[1] !== args[4]).join('\n'));
    return true;
  }
  if (args[2] === 'shell' && args[3] === 'sh' && args[4] === '-c') {
    const script = args[5].slice(1, -1).replaceAll("'\\''", "'")
      .replace(require('../bin/shared-kernel/android-sha256').sha256Shell + 'aab_select_sha256 || exit 127\n', '')
      .replaceAll('aab_sha256sum ', 'sha256sum ');
    let match;
    if (script === 'getprop ro.build.version.sdk') { process.stdout.write('36'); return true; }
    if (script.startsWith(`umask 077\nmkdir -p '${root}'`)) return true;
    if ((match = script.match(/^if \[ -f '([^']+)' \]; then sha256sum '\1'; else printf '%s' null; fi$/)) && match[1].startsWith(root + '/')) {
      const file = phoneFile(directory, match[1]);
      process.stdout.write(fs.existsSync(file) ? sha256(fs.readFileSync(file)) + '  ' + match[1] : 'null'); return true;
    }
    if ((match = script.match(/^sha256sum '([^']+)'$/)) && match[1].startsWith(root + '/')) {
      process.stdout.write(sha256(fs.readFileSync(phoneFile(directory, match[1]))) + '  ' + match[1]); return true;
    }
    if ((match = script.match(/^mv -n '([^']+)' '([^']+)'$/)) && match[1].startsWith(root + '/') && match[2].startsWith(root + '/')) {
      if (!fs.existsSync(phoneFile(directory, match[2]))) fs.renameSync(phoneFile(directory, match[1]), phoneFile(directory, match[2])); return true;
    }
    if ((match = script.match(/^rm -f '([^']+)'$/)) && match[1].startsWith(root + '/')) { fs.rmSync(phoneFile(directory, match[1]), { force: true }); return true; }
    if ((match = script.match(/ (acknowledge-record|recover-record) '(\{.*\})'$/))) {
      const current = JSON.parse(fs.readFileSync(phoneFile(directory, `${root}/runtime.json`)));
      const result = config.ownerAlive !== false && current.running ? { ok: false, error: 'uia_runtime_already_running' }
        : (match[1] === 'recover-record' ? recoverRecord : acknowledgeRecord)(directory, JSON.parse(match[2]));
      if (result.ok === false) { delete result.httpStatus; process.stderr.write(JSON.stringify(result)); process.exit(2); }
      process.stdout.write(JSON.stringify(result)); return true;
    }
    const read = script.match(/^if \[ -f '([^']+)' \]; then cat '\1'; else printf '%s' null; fi$/);
    if (read && read[1].startsWith(root + '/')) {
      if (descriptorReady && read[1] === root + '/runtime.json') {
        process.on('SIGTERM', () => {});
        fs.writeFileSync(descriptorReady + '.tmp', String(process.pid));
        fs.renameSync(descriptorReady + '.tmp', descriptorReady);
        setInterval(() => {}, 1000);
        return true;
      }
      const file = phoneFile(directory, read[1]);
      process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file) : 'null'); return true;
    }
  }
  return false;
}

function receiptBinding(request, node = {}) {
  const target = { sourceId: '7', windowId: 41, packageName: request.target.selector.packageName,
    className: 'android.widget.Button', text: 'Button', contentDescription: null, resourceName: null,
    bounds: '[0,0][100,100]', enabled: true, visible: true, clickable: true,
    checkable: false, checked: false, scrollable: false,
    ...(request.target.selector.kind === 'nodeRef' ? {} : { [request.target.selector.kind]: request.target.selector.value }), ...node };
  return { ...request.target, clickPolicy: request.clickPolicy, target, actionTarget: { ...target },
    window: { id: 41, displayId: 0, type: 1, focused: true, title: 'Controlled UIA' },
    identityStrength: 'same_connection_node_and_reobserved_attributes' };
}

async function createUiaRuntimeFixture({ directory, serial = randomUUID(), xml = '<hierarchy><node text="Button" package="example.uia" enabled="true" clickable="true" visible-to-user="true" bounds="[0,0][100,100]"/></hierarchy>',
  capacity = 256, autoComplete = true, onRequest, onDispatch, foregroundPackage = 'example.uia', descriptorReady } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../runtime/uia/manifest.json')));
  let epoch = randomUUID();
  const boot = randomUUID();
  const peer = { schemaVersion: 'aab.uia.runtime.v1', bootId: boot, runtimeEpoch: epoch, dexSha256: manifest.sha256,
    apiLevel: 36, pid: process.pid, socketName: `aab-uia-${epoch}`, token: randomBytes(32).toString('hex'),
    sessionPath: `${root}/sessions/${epoch}`, running: true };
  const records = new Map(), requests = [], dispatches = [];
  const publish = () => { for (const remote of [`${root}/runtime.json`, `${peer.sessionPath}/runtime.json`]) save(phoneFile(directory, remote), peer); };
  const persist = entry => save(phoneFile(directory, `${peer.sessionPath}/actions/${sha256(entry.actionId)}.json`), entry);
  const rotate = () => {
    if ([...records.values()].some(entry => entry.phase !== 'terminal')) throw new Error('uia_previous_action_unresolved');
    peer.running = false; publish();
    epoch = randomUUID();
    Object.assign(peer, { runtimeEpoch: epoch, socketName: `aab-uia-${epoch}`, token: randomBytes(32).toString('hex'),
      sessionPath: `${root}/sessions/${epoch}`, running: true });
    records.clear(); publish();
  };
  const envelope = entry => ({ schemaVersion, bootId: boot, runtimeEpoch: epoch, actionId: entry.actionId, requestSha256: entry.requestSha256,
    settled: entry.phase === 'terminal', phase: entry.phase, acknowledged: entry.acknowledged,
    ...(entry.phase === 'terminal' ? { receiptJson: entry.receiptJson, receiptSha256: entry.receiptSha256 }
      : { ok: false, dispatched: null, ambiguous: true, error: 'uia_action_pending' }) });
  function complete(actionId, { ok = true, dispatched = true, completion = 'original_callback', error, node, mutate } = {}) {
    const entry = records.get(actionId), request = JSON.parse(entry.requestJson);
    const receipt = { schemaVersion, bootId: boot, runtimeEpoch: epoch, actionId, requestSha256: entry.requestSha256,
      settled: true, ok, dispatched, ambiguous: false, completion, completedAtElapsedMs: 1000 };
    if (!ok) receipt.error = error || 'uia_action_not_handled';
    if (completion !== 'before_admission') receipt.binding = receiptBinding(request, node);
    if (completion === 'original_callback') receipt.callback = { interactionId: dispatches.indexOf(actionId) + 1, handled: ok };
    mutate?.(receipt);
    entry.phase = 'terminal'; entry.receiptJson = JSON.stringify(receipt); entry.receiptSha256 = sha256(entry.receiptJson);
    persist(entry); return envelope(entry);
  }
  function respond(body) {
    if (body.op === 'status') return { ok: true, schemaVersion, bootId: boot, runtimeEpoch: epoch, dexSha256: peer.dexSha256,
      count: records.size, capacity, pending: [...records.values()].filter(r => r.phase !== 'terminal').length,
      acknowledged: [...records.values()].filter(r => r.acknowledged).length, closing: false, activeActionId: null };
    if (body.op === 'observe') {
      const content = typeof xml === 'function' ? xml() : xml;
      return { ok: true, schemaVersion: 'aab.uia.snapshot.v1', bootId: boot, runtimeEpoch: epoch,
        xml: uiaXml(content, { boot, epoch }) };
    }
    if (body.op === 'stop') { peer.running = false; publish(); return { ok: true, runtimeEpoch: epoch, stopping: true }; }
    if (body.op === 'acknowledge-record') return acknowledgeRecord(directory, body.identity, epoch);
    const request = JSON.parse(body.requestJson);
    if (sha256(body.requestJson) !== body.requestSha256 || request.bootId !== boot || request.runtimeEpoch !== epoch)
      return { httpStatus: 409, ok: false, error: 'uia_request_identity_mismatch' };
    let entry = records.get(request.actionId);
    if (entry && entry.requestJson !== body.requestJson) return { httpStatus: 409, ok: false, error: 'uia_action_id_reused' };
    if (!entry) {
      if (!['prepare', 'cancel'].includes(body.op)) return { httpStatus: 404, ok: false, error: 'uia_action_not_found' };
      if (records.size >= capacity) return { httpStatus: 409, ok: false, error: 'uia_action_capacity_exhausted' };
      entry = { schemaVersion: 'aab.uia.record.v2', bootId: boot, runtimeEpoch: epoch, actionId: request.actionId,
        requestJson: body.requestJson, requestSha256: body.requestSha256, phase: 'prepared', acknowledged: false,
        preparedAtElapsedMs: 100, deadlineElapsedMs: 100 + request.timeoutMs, interactionId: 0, receiptJson: null, receiptSha256: null };
      records.set(entry.actionId, entry); persist(entry);
    }
    if (body.op === 'start' && entry.phase === 'prepared') {
      entry.phase = 'admitted'; dispatches.push(entry.actionId); entry.interactionId = dispatches.length; persist(entry); onDispatch?.(request);
      if (autoComplete) return complete(entry.actionId);
    }
    if (body.op === 'cancel' && entry.phase === 'prepared') return complete(entry.actionId,
      { ok: false, dispatched: false, completion: 'before_admission', error: 'cancelled' });
    if (body.op === 'acknowledge') {
      if (entry.phase !== 'terminal' || entry.receiptSha256 !== body.receiptSha256)
        return { httpStatus: 409, ok: false, error: 'uia_completion_identity_mismatch' };
      entry.acknowledged = true; persist(entry);
    }
    return envelope(entry);
  }
  let fixture, dead = false;
  const server = http.createServer(async (req, res) => {
    if (dead) { res.destroy(); return; }
    if (req.url !== '/v1' || req.method !== 'POST' || req.headers.authorization !== `Bearer ${peer.token}`) {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return;
    }
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      fs.appendFileSync(path.join(directory, 'rpc.jsonl'), raw + '\n');
      const value = await onRequest?.(body, fixture, req, res);
      if (res.destroyed || res.writableEnded) return;
      const result = value === undefined ? respond(body) : value;
      if (result.close === true) { res.destroy(); return; }
      const { httpStatus = 200, ...payload } = result;
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'fixture_error', message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  publish(); save(path.join(directory, 'fixture.json'), { serial, port });
  fs.writeFileSync(path.join(directory, 'forwards.txt'), `${serial} tcp:${port} localabstract:${peer.socketName}\n`);
  const adb = path.join(directory, 'adb');
  fs.writeFileSync(adb, `#!${process.execPath}
const args = process.argv.slice(2);
if (require(${JSON.stringify(__filename)}).handleUiaRuntimeFixture(args, ${JSON.stringify({ directory, descriptorReady })})) {
  ${descriptorReady ? '' : 'process.exit(0);'}
} else if (args.includes('dumpsys') && args.includes('window')) process.stdout.write(${JSON.stringify(`mCurrentFocus=Window{test u0 ${foregroundPackage}/${foregroundPackage}.MainActivity}\n`)});
else { process.stderr.write('Unsupported controlled UIA ADB call'); process.exitCode = 2; }
`, { mode: 0o755 });
  fixture = { directory, serial, adb, peer, port, requests, dispatches, records, respond, complete, publish, envelope, rotate,
    phoneFile: remote => phoneFile(directory, remote),
    killOwner() { dead = true; save(path.join(directory, 'fixture.json'), { serial, port, ownerAlive: false }); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  return fixture;
}

module.exports = { createUiaRuntimeFixture, handleUiaRuntimeFixture, receiptBinding, sha256 };
