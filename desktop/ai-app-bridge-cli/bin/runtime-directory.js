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

let fingerprint;
function codeFingerprint() {
  if (fingerprint) return fingerprint;
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
  hash.update(fs.readFileSync(path.join(nativeDirectory, 'build/Release/segmented_fact_store.node')));
  hash.update(JSON.stringify({ node: process.versions.node, modules: process.versions.modules }));
  fingerprint = hash.digest('hex');
  return fingerprint;
}

function runtimeLocation() {
  const target = hostFactStoreTarget();
  const facts = canonicalPath(target.directory);
  const key = createHash('sha256').update(facts).digest('hex');
  const home = path.resolve(process.env.AI_APP_BRIDGE_RUNTIME_HOME || path.join(os.homedir(), '.ai-app-bridge', 'runtimes', 'v1'));
  const directory = path.join(home, key);
  return { directory, facts, profile: target.profile, endpointFile: path.join(directory, 'endpoint.json'),
    lockFile: path.join(directory, 'owner.sqlite'), logFile: path.join(directory, 'runtime.log') };
}

function runtimeIdentity(location = runtimeLocation()) {
  const names = ['ADB', 'AI_APP_BRIDGE_ADB_TIMEOUT_MS', 'AI_APP_BRIDGE_DEVICECTL', 'AI_APP_BRIDGE_FACT_CACHE',
    'AI_APP_BRIDGE_IOS_TEAM_ID', 'AI_APP_BRIDGE_PYTHON', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DEVELOPMENT_TEAM', 'DEVELOPER_DIR', 'XCODEBUILD'];
  const config = { facts: location.facts, profile: location.profile, ownership: canonicalPath(ownershipDirectory()),
    environment: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])) };
  return { protocol, code: codeFingerprint(), config: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
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
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
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
  if (value.protocol !== protocol || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || typeof value.runtimeId !== 'string' || !Number.isSafeInteger(value.pid)
    || value.facts !== location.facts) throw new CommandError('runtime_endpoint_invalid', 'The runtime endpoint identity is invalid.');
  return value;
}

function publishEndpoint(location, endpoint) {
  const temporary = `${location.endpointFile}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, location.endpointFile);
}

module.exports = { runtimeLocation, runtimeIdentity, prepareDirectory, acquireRuntimeLock, readEndpoint, publishEndpoint };
