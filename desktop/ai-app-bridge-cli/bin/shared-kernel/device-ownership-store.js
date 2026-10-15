'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const acknowledgements = require('./device-acknowledgements');
const { durableRename, durableCreate } = require('./durable-files');

const schemaVersion = 'aab.device-ownership/v2';
const maxJournalBytes = 4 * 1024 * 1024;
// Keep the original physical lock namespace across journal format upgrades.
const defaultDirectory = () => path.resolve(process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR
  || path.join(os.homedir(), '.ai-app-bridge', 'device-ownership', 'v1'));

// SQLite supplies an OS-managed single-writer lock, with no heartbeat expiry.
// Process death releases the lock; the separately committed journal survives.
// Lock files are never unlinked, which would split ownership by inode.
function createOwnershipStore(directory = defaultDirectory()) {
  directory = path.resolve(directory);
  function paths(serial) {
    const key = createHash('sha256').update(serial).digest('hex');
    return { lock: path.join(directory, `${key}.sqlite`), journal: path.join(directory, `${key}.json`) };
  }
  function read(serial) {
    let value;
    let fd;
    try {
      fd = fs.openSync(paths(serial).journal, 'r');
      if (fs.fstatSync(fd).size > maxJournalBytes) throw new Error('Device ownership journal exceeds 4 MiB.');
      const bytes = fs.readFileSync(fd);
      if (bytes.length > maxJournalBytes) throw new Error('Device ownership journal exceeds 4 MiB.');
      value = JSON.parse(bytes.toString('utf8'));
    }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new CommandError('device_ownership_corrupt', 'Cannot read the device ownership journal.', { details: { serial, cause: error.message } });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (!['aab.device-ownership/v1', schemaVersion].includes(value?.schemaVersion) || value.serial !== serial || !Array.isArray(value.reservations) || !['owned', 'unresolved', 'idle'].includes(value.phase)
        || !(value.pending === null || value.pending && typeof value.pending.id === 'string' && typeof value.pending.kind === 'string')) {
      throw new CommandError('device_ownership_corrupt', 'Invalid device ownership journal.', { details: { serial } });
    }
    if (value.schemaVersion === 'aab.device-ownership/v1') {
      if (Object.hasOwn(value, 'pendingAcknowledgements'))
        throw new CommandError('device_ownership_corrupt', 'A v1 journal cannot contain v2 acknowledgement obligations.');
      // Lossless data upgrade: never move the lock or discard an old unknown action.
      value = { ...value, schemaVersion, pendingAcknowledgements: [] };
    }
    const queue = value.pendingAcknowledgements;
    if (!Array.isArray(queue) || queue.length > acknowledgements.capacity || queue.some(item => !acknowledgements.valid(item, serial))
      || new Set(queue.map(item => item.pending.id)).size !== queue.length)
      throw new CommandError('device_ownership_corrupt', 'Invalid pending receipt acknowledgement journal.', { details: { serial } });
    return value;
  }
  function lock(serial) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require('node:sqlite');
    const file = paths(serial).lock;
    let db;
    try {
      db = new DatabaseSync(file);
      fs.chmodSync(file, 0o600);
      // The lock database has no payload to write. Reserve its sole writer slot
      // without an EXCLUSIVE upgrade that can lose to readers opening the file.
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    } catch (error) {
      db?.close();
      if (error.errcode === 5) return null;
      throw new CommandError('device_ownership_unavailable', 'Cannot acquire the shared device ownership lock.', { details: { serial, cause: error.message } });
    }
    let closed = false;
    return { close() { if (!closed) { closed = true; try { db.exec('ROLLBACK'); } finally { db.close(); } } } };
  }
  function write(serial, value) {
    const file = paths(serial).journal;
    const temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      const bytes = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(bytes) > maxJournalBytes) throw new Error('Device ownership journal exceeds 4 MiB.');
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      durableRename(temporary, file);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (failure) { if (failure.code !== 'ENOENT') error.cleanupError = failure.code; }
      throw new CommandError('device_ownership_unavailable', 'Cannot commit device ownership; no new action is allowed.', { details: { serial, cause: error.message } });
    }
  }
  const controlLock = serial => createOwnershipStore(path.join(directory, 'reset-controls')).lock(serial);
  // Archive original bytes before a new explicit operation supersedes orphaned
  // history. This is not a completion receipt, reset, cancellation or replay.
  function archive(serial, outcome = 'unknown') {
    const archiveDir = path.join(directory, 'unresolved', createHash('sha256').update(serial).digest('hex'));
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const archiveId = randomUUID();
    const archivePath = path.join(archiveDir, `${archiveId}.json`);
    durableCreate(archivePath, fs.readFileSync(paths(serial).journal));
    return { archiveId: `unresolved:${archiveId}`, archivePath, outcome, archivedAtMs: Date.now() };
  }
  function archives(serial) {
    const archiveDir = path.join(directory, 'unresolved', createHash('sha256').update(serial).digest('hex'));
    let files;
    try { files = fs.readdirSync(archiveDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(file => file.endsWith('.json')).sort().map(file => {
      const archivePath = path.join(archiveDir, file);
      try {
        if (fs.statSync(archivePath).size > maxJournalBytes) throw new Error('Archive exceeds 4 MiB.');
        const state = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
        if (state.serial !== serial) throw new Error('Archive serial mismatch.');
        return { archivePath, state };
      } catch (error) { return { archivePath, error: 'device_ownership_corrupt', message: error.message }; }
    });
  }
  function findPending(serial, predicate) {
    const states = [read(serial), ...archives(serial).map(item => item.state)].filter(Boolean);
    return states.flatMap(state => [state.pending, ...(state.reservations || []), ...(state.resetPending || [])])
      .find(item => item && predicate(item));
  }
  return { directory, read, lock, write, paths, controlLock, archive, archives, findPending };
}

module.exports = { createOwnershipStore, defaultDirectory, schemaVersion };
