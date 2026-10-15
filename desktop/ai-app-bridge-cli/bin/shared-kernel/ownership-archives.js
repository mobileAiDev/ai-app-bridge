'use strict';

const fs = require('node:fs'), path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { createOwnershipStore } = require('./device-ownership-store');
const { durableRename, durableRemove } = require('./durable-files');

const idPattern = /^(unresolved|force-stopped):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const operations = new Set(['archives', 'archive', 'reconcile-archive', 'delete-archive']);
function schema() {
  const properties = { operation: { enum: ['status', 'reconcile', 'receipt', 'cancel-install', 'force-stop', ...operations] },
    serial: { type: 'string', minLength: 1 }, archiveId: { type: 'string', pattern: idPattern.source },
    entryId: { type: 'string', minLength: 1, maxLength: 1024 }, cursor: { type: 'string', pattern: idPattern.source },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    runtimeEpoch: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    actionId: { type: 'string', minLength: 1, maxLength: 1024 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } };
  const branch = (operation, allowed, required = []) => ({ properties: { operation: { const: operation },
    ...Object.fromEntries(Object.keys(properties).filter(key => !['operation', 'serial', ...allowed].includes(key)).map(key => [key, false])) }, required });
  return { type: 'object', additionalProperties: false, properties, required: ['operation', 'serial'], oneOf: [
    ...['status', 'reconcile', 'force-stop'].map(operation => branch(operation, ['timeoutMs'])),
    branch('receipt', ['runtimeEpoch', 'actionId'], ['runtimeEpoch', 'actionId']),
    branch('cancel-install', ['actionId', 'timeoutMs'], ['actionId']), branch('archives', ['actionId', 'cursor', 'limit']),
    branch('archive', ['archiveId'], ['archiveId']), branch('delete-archive', ['archiveId'], ['archiveId']),
    branch('reconcile-archive', ['archiveId', 'entryId', 'timeoutMs'], ['archiveId', 'entryId']),
  ] };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const entries = state => [...new Map([state?.pending, ...(state?.reservations || []), ...(state?.resetPending || []),
  ...(state?.pendingAcknowledgements || []).map(item => item.pending)].filter(Boolean).map(item => [item.id, item])).values()];

function writeJson(file, value) {
  const directory = path.dirname(file); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  durableRename(temporary, file);
}
function readBytes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size > 4 * 1024 * 1024) throw new CommandError('ownership_archive_too_large', 'The archived journal exceeds 4 MiB; inspect archivePath directly.', { details: { archivePath: file } });
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// Forced reset may archive invalid JSON. Its serial is recorded separately so
// the original bytes stay untouched and remain discoverable after new work.
function recordForceStoppedArchive(directory, resetId, serial) {
  writeJson(path.join(directory, 'archive-metadata', `${resetId}.json`), { serial });
}

function createArchiveStore(directory) {
  const store = createOwnershipStore(directory);
  const locks = createOwnershipStore(path.join(store.directory, 'archive-controls'));
  function paths(serial, archiveId) {
    const match = idPattern.exec(archiveId);
    if (!match) throw new CommandError('invalid_ownership_archive_id', 'Use an archiveId returned by device-ownership archives.');
    const [, kind, id] = match;
    return { file: path.join(store.directory, kind, ...(kind === 'unresolved' ? [digest(serial)] : []), `${id}.json`),
      metadata: kind === 'force-stopped' ? path.join(store.directory, 'archive-metadata', `${id}.json`) : null,
      result: path.join(store.directory, 'archive-results', digest(serial), `${kind}-${id}.json`), kind };
  }
  function checkSerial(serial, files, recordedSerial) {
    if (files.kind === 'force-stopped' && recordedSerial === undefined) {
      try { recordedSerial = JSON.parse(readBytes(files.metadata)).serial; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (recordedSerial === undefined) {
        // Pre-metadata resets can still be identified by the current journal.
        try { if (store.read(serial)?.lastReset?.archivePath === files.file) recordedSerial = serial; }
        catch (error) { if (error.code !== 'device_ownership_corrupt') throw error; }
      }
    }
    if (files.kind === 'force-stopped' ? recordedSerial !== serial : recordedSerial !== undefined && recordedSerial !== serial)
      throw new CommandError('ownership_archive_serial_mismatch', 'This archive cannot be attributed to the requested serial.');
  }
  function read(serial, archiveId) {
    const files = paths(serial, archiveId);
    let bytes;
    try { bytes = readBytes(files.file); }
    catch (error) {
      if (error.code === 'ENOENT') throw new CommandError('ownership_archive_not_found', 'This archive is absent or was explicitly deleted. List archives again.', { details: { archiveId } });
      throw error;
    }
    let state = null, parseError;
    try {
      state = JSON.parse(bytes);
      if (!state || typeof state !== 'object' || !Array.isArray(state.reservations)
        || ['resetPending', 'pendingAcknowledgements'].some(key => state[key] !== undefined && !Array.isArray(state[key]))) throw new Error('Invalid ownership journal.');
    } catch (error) { parseError = error.message; state = null; }
    checkSerial(serial, files, state?.serial);
    const checksum = digest(bytes);
    let reconciliation = null, reconciliationError;
    try {
      reconciliation = JSON.parse(readBytes(files.result));
      if (reconciliation?.archiveId !== archiveId || reconciliation.checksum !== checksum) throw new Error('Original archive checksum changed.');
      if (!reconciliation.results || typeof reconciliation.results !== 'object' || Array.isArray(reconciliation.results)) throw new Error('Invalid reconciliation results.');
    } catch (error) { reconciliation = null; if (error.code !== 'ENOENT') reconciliationError = error.message; }
    return { archiveId, archivePath: files.file, checksum, bytes: bytes.length, archivedAtMs: fs.statSync(files.file).mtimeMs,
      outcome: 'unknown', journal: state, ...(parseError ? { parseError, rawText: bytes.toString('utf8') } : {}),
      reconciliation, ...(reconciliationError ? { reconciliationError } : {}) };
  }
  function ids(serial) {
    return ['unresolved', 'force-stopped'].flatMap(kind => {
      const directory = path.join(store.directory, kind, ...(kind === 'unresolved' ? [digest(serial)] : []));
      let files;
      try { files = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return files.filter(file => file.endsWith('.json')).map(file => `${kind}:${file.slice(0, -5)}`).filter(id => idPattern.test(id));
    }).sort();
  }
  function list(args) {
    const items = [], limit = args.limit ?? 20; let hasMore = false, unattributed = 0;
    for (const id of ids(args.serial)) {
      if (args.cursor && id <= args.cursor) continue;
      let archive;
      try { archive = read(args.serial, id); }
      catch (error) {
        if (error.code === 'ownership_archive_serial_mismatch') { unattributed++; continue; }
        if (error.code === 'ownership_archive_not_found') continue; // A concurrent explicit deletion.
        archive = { archiveId: id, archivePath: paths(args.serial, id).file, journal: null, error: error.code || 'ownership_archive_unreadable', message: error.message };
      }
      const actions = entries(archive.journal);
      if (args.actionId && !actions.some(item => item.actionId === args.actionId)) continue;
      if (items.length === limit) { hasMore = true; break; }
      const { journal, rawText, reconciliation, ...metadata } = archive;
      items.push({ ...metadata, entryCount: actions.length, entries: actions.slice(0, 10).map(item => ({ entryId: item.id,
        kind: item.kind, actionId: item.actionId ?? null, runtimeEpoch: item.runtimeEpoch ?? null })),
        entriesTruncated: actions.length > 10,
        ...(reconciliation ? { reconciledAtMs: reconciliation.checkedAtMs, reconciledEntries: Object.keys(reconciliation.results).length } : {}),
        read: { command: 'device-ownership', arguments: { operation: 'archive', serial: args.serial, archiveId: id } } });
    }
    return { ok: true, serial: args.serial, items, hasMore, nextCursor: hasMore ? items.at(-1).archiveId : null,
      retention: 'kept_until_explicitly_deleted', ...(unattributed ? { otherOrUnattributedArchivesSkipped: unattributed } : {}) };
  }
  async function handle(args, verify) {
    if (args.operation === 'archives') return list(args);
    if (args.operation === 'archive') return { ok: true, serial: args.serial, ...read(args.serial, args.archiveId) };
    const lock = locks.lock(`${args.serial}:${args.archiveId}`);
    if (!lock) throw new CommandError('ownership_archive_busy', 'This archive is being reconciled or deleted. Retry this archive operation.');
    try {
      const files = paths(args.serial, args.archiveId);
      let archive;
      try { archive = read(args.serial, args.archiveId); }
      catch (error) {
        if (args.operation !== 'delete-archive' || error.code !== 'ownership_archive_too_large') throw error;
        checkSerial(args.serial, files);
      }
      if (args.operation === 'delete-archive') {
        for (const file of [files.result, files.metadata, files.file].filter(Boolean)) {
          try { durableRemove(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return { ok: true, serial: args.serial, archiveId: args.archiveId, deleted: true,
          message: 'Only this local archive and its reconciliation record were deleted. Remote actions and current device ownership were not changed.' };
      }
      const pending = entries(archive.journal).find(item => item.id === args.entryId);
      if (!pending) throw new CommandError('ownership_archive_entry_not_found', 'Use an entryId from this archive. Invalid journals retain their original bytes but cannot identify an action.');
      const retained = archive.reconciliation?.results[pending.id];
      if (retained?.settled === true) return { ok: true, serial: args.serial, archiveId: args.archiveId,
        originalOutcome: 'unknown', result: retained, cached: true,
        message: 'Returned the original terminal proof already saved for this unchanged archive. No device query was repeated.' };
      const proof = await verify(pending);
      const checkedAtMs = Date.now();
      const result = { entryId: pending.id, kind: pending.kind, actionId: pending.actionId ?? null, checkedAtMs, ...proof };
      const reconciliation = { archiveId: args.archiveId, checksum: archive.checksum, checkedAtMs,
        results: { ...archive.reconciliation?.results, [pending.id]: result } };
      writeJson(files.result, reconciliation);
      return { ok: true, serial: args.serial, archiveId: args.archiveId, originalOutcome: 'unknown', result,
        message: 'Queried the original action without replay, cancellation or receipt cleanup. The immutable archive and current device ownership are unchanged.' };
    } finally { lock.close(); }
  }
  return { handle };
}

module.exports = { createArchiveStore, recordForceStoppedArchive, operations, idPattern, schema };
