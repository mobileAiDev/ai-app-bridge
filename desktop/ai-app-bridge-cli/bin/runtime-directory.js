'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { CommandError } = require('./command-errors');
const { hostFactStoreTarget } = require('./shared-kernel/host-fact-store');
const { defaultDirectory: ownershipDirectory } = require('./shared-kernel/device-ownership-store');
const { protocol } = require('./runtime-protocol');
const { canonicalPath } = require('./shared-kernel/canonical-path');
const { executablePath } = require('./shared-kernel/executable-path');

function calculateCodeFingerprint() {
  const hash = createHash('sha256');
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) { hash.update(path.relative(__dirname, file)); hash.update(fs.readFileSync(file)); }
    }
  }
  visit(__dirname);
  visit(path.join(__dirname, '../runtime'));
  hash.update(fs.readFileSync(path.join(__dirname, '../package.json')));
  // Execution also depends on bundled device code and the actually installed
  // native store. A changed jar, WDA integration or addon is a different build.
  for (const name of ['ws', 'appium-webdriveragent', '@mobileaidev/segmented-fact-store-native']) {
    hash.update(name);
    hash.update(fs.readFileSync(require.resolve(`${name}/package.json`)));
  }
  const nativeDirectory = path.dirname(require.resolve('@mobileaidev/segmented-fact-store-native'));
  hash.update(fs.readFileSync(path.join(nativeDirectory, 'index.js')));
  hash.update(fs.readFileSync(path.join(nativeDirectory, 'binding-path.js')));
  hash.update(fs.readFileSync(path.join(nativeDirectory, 'prebuilds/manifest.json')));
  const nativeBinding = require('@mobileaidev/segmented-fact-store-native/binding-path').resolveBinding();
  hash.update(fs.readFileSync(nativeBinding.path));
  hash.update(JSON.stringify({ node: process.versions.node, modules: process.versions.modules }));
  return hash.digest('hex');
}

// Pin the running client's code when this entrypoint loads, before the first
// request. Replacing installed files cannot make this process claim new code.
let fingerprint, fingerprintError;
try { fingerprint = calculateCodeFingerprint(); }
catch (error) { fingerprintError = error; }
const packageVersion = require('../package.json').version;

function runtimeLocation() {
  const target = hostFactStoreTarget();
  const facts = canonicalPath(target.directory);
  const key = createHash('sha256').update(facts).digest('hex');
  const home = path.resolve(process.env.AI_APP_BRIDGE_RUNTIME_HOME || path.join(os.homedir(), '.ai-app-bridge', 'runtimes', 'v1'));
  const directory = path.join(home, key);
  return { directory, facts, profile: target.profile, endpointFile: path.join(directory, 'endpoint.json'),
    ownerFile: path.join(directory, 'owner.json'), lockFile: path.join(directory, 'owner.sqlite'), logFile: path.join(directory, 'runtime.log') };
}

function runtimeIdentity(location = runtimeLocation()) {
  const names = ['AI_APP_BRIDGE_ADB_TIMEOUT_MS', 'AI_APP_BRIDGE_DEVICECTL', 'AI_APP_BRIDGE_FACT_CACHE',
    'AI_APP_BRIDGE_IOS_TEAM_ID', 'AI_APP_BRIDGE_PYTHON', 'AI_APP_BRIDGE_EXECUTOR_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DEVELOPMENT_TEAM', 'DEVELOPER_DIR', 'XCODEBUILD'];
  const config = { facts: location.facts, profile: location.profile, ownership: canonicalPath(ownershipDirectory()),
    adb: executablePath(process.env.ADB || 'adb') ?? { unavailable: process.env.ADB || 'adb' },
    adbServerSocket: require('./shared-kernel/android-adb-route').adbServerSocket(),
    environment: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])) };
  return { protocol, code: fingerprint, config: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    providers: { adb: config.adb, adbServerSocket: config.adbServerSocket, ownership: config.ownership },
    requestedProviders: { ...(process.env.ADB ? { adb: config.adb } : {}),
      ...(['ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT'].some(name => process.env[name])
        ? { adbServerSocket: config.adbServerSocket } : {}) },
    ...(fingerprintError ? { installationDiagnostic: { code: 'client_installation_invalid', message: fingerprintError.message } } : {}),
    version: packageVersion, node: { version: process.versions.node, modules: process.versions.modules, napi: process.versions.napi } };
}

// The wire protocol is the compatibility boundary. Build/config fingerprints
// describe the processes; they cannot prove that a supported request will fail.
function requireCompatible(status, client) {
  const runtime = status.identity;
  if (runtime?.protocol !== protocol || client?.protocol !== protocol)
    throw new CommandError('runtime_protocol_error', 'Client and Runtime must support the same wire protocol.',
      { details: { runtime: runtime?.protocol, client: client?.protocol } });
  const warnings = [];
  for (const field of ['code', 'config']) if (runtime[field] !== client[field]) warnings.push({
    code: field === 'code' ? 'runtime_code_differs' : 'runtime_configuration_differs',
    message: 'The request uses the running Runtime implementation and settings.',
    field, client: client[field] ?? null, runtime: runtime[field] ?? null,
  });
  if (client.installationDiagnostic) warnings.push(client.installationDiagnostic);
  return warnings;
}

function prepareDirectory(location) {
  fs.mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(location.directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw new CommandError('runtime_directory_unsafe', 'The runtime directory must belong to the current user.');
  }
  fs.chmodSync(location.directory, 0o700);
}

// The OS lock, not a PID or timeout, proves whether a runtime still owns this
// namespace. Never unlink the SQLite file: doing so would split its inode lock.
function acquireRuntimeLock(location) {
  prepareDirectory(location);
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(location.lockFile);
    fs.chmodSync(location.lockFile, 0o600);
    // Reserve the one writer slot; this lock-only database never stores data.
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch (error) {
    db?.close();
    if (error.errcode === 5) return null;
    throw new CommandError('runtime_lock_unavailable', 'Cannot acquire the local runtime lock.', { details: { cause: error.message } });
  }
  let closed = false;
  return { close() { if (!closed) { closed = true; try { db.exec('ROLLBACK'); } finally { db.close(); } } } };
}

function readEndpoint(location) {
  let bytes;
  try { bytes = fs.readFileSync(location.endpointFile); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { if (bytes.length > 16384) throw new Error(); value = JSON.parse(bytes); }
  catch { throw new CommandError('runtime_endpoint_invalid', 'The runtime endpoint record is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== protocol || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || typeof value.runtimeId !== 'string' || !Number.isSafeInteger(value.pid)
    || value.facts !== location.facts) throw new CommandError('runtime_endpoint_invalid', 'The runtime endpoint identity is invalid.');
  return value;
}

function publishEndpoint(location, endpoint) {
  publishRecord(location.endpointFile, endpoint);
}

function readRuntimeOwner(location) {
  let bytes;
  try { bytes = fs.readFileSync(location.ownerFile); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { if (bytes.length > 16384) throw new Error(); value = JSON.parse(bytes); }
  catch { throw new CommandError('runtime_owner_invalid', 'The independent runtime owner record is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== protocol || typeof value.runtimeId !== 'string' || !value.runtimeId
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.processStart !== 'string' || !value.processStart
    || (value.ownership !== undefined && (typeof value.ownership !== 'string' || !path.isAbsolute(value.ownership)))
    || value.facts !== location.facts) throw new CommandError('runtime_owner_invalid', 'The independent runtime owner identity is invalid.');
  return value;
}

function publishRecord(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function publishRuntimeOwner(location, value) { publishRecord(location.ownerFile, value); }

// Called only while owning the namespace lock. Preserve malformed bytes too;
// recovery must not depend on parsing the broken record or unlink the lock inode.
function archiveRuntimeRecords(location, reason) {
  const records = [['endpoint', location.endpointFile], ['owner', location.ownerFile]].filter(([, file]) => fs.existsSync(file));
  const archives = {};
  if (!records.length) return archives;
  const directory = path.join(location.directory, 'recovery', `${reason}-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, file] of records) { archives[name] = path.join(directory, path.basename(file)); fs.renameSync(file, archives[name]); }
  return archives;
}

module.exports = { runtimeLocation, runtimeIdentity, requireCompatible, prepareDirectory, acquireRuntimeLock, readEndpoint, publishEndpoint,
  readRuntimeOwner, publishRuntimeOwner, archiveRuntimeRecords };
