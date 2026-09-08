'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizePersistentValue } = require('../fact-codec');

const PAYLOAD_SCHEMA = 'aab.recorded-payload/v1';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const MAX_ATTACHMENTS = 10_000;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => sha256(JSON.stringify(value ?? null));

function requireValue(condition, code, detail) {
  if (!condition) throw Object.assign(new Error(code), { code, detail });
}

function readRegularFile(directory, name, maxBytes = MAX_FILE_BYTES) {
  const root = fs.lstatSync(directory);
  requireValue(root.isDirectory() && !root.isSymbolicLink(), 'invalid_archive_directory');
  requireValue(path.basename(name) === name && name !== '.' && name !== '..', 'invalid_archive_path');
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), 'invalid_archive_file', name);
  requireValue(stat.size <= maxBytes, 'archive_limit_exceeded');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    requireValue(opened.isFile() && opened.size <= maxBytes, 'invalid_archive_file', name);
    const bytes = fs.readFileSync(descriptor);
    requireValue(bytes.length <= maxBytes, 'archive_limit_exceeded');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function checkPng(bytes) {
  requireValue(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, 'invalid_screenshot');
}

// An explicitly requested, single-execution file output. No reader in the live
// capture path uses this directory, and it is never reopened for automatic replay.
function createEvidenceRecording({ directory, namespace, operationId, store, now = Date.now }) {
  requireValue(typeof directory === 'string' && directory.trim().length > 0, 'invalid_recording_directory');
  requireValue(store && typeof store.persist === 'function', 'recording_store_required');
  const root = path.resolve(directory);
  try { fs.mkdirSync(root); }
  catch (error) { if (error.code === 'EEXIST') error.code = 'output_exists'; throw error; }
  const recordingId = crypto.randomUUID();
  let sequence = 0;
  let bytesWritten = 0;
  let failure = null;
  let tail = Promise.resolve();

  function write(name, bytes) {
    requireValue(bytes.length <= MAX_FILE_BYTES && bytesWritten + bytes.length <= MAX_RECORDING_BYTES,
      'recording_limit_exceeded');
    const descriptor = fs.openSync(path.join(root, name), 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    bytesWritten += bytes.length;
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  }

  function record({ kind, revision, target, data, parentFactId }) {
    if (failure) return Promise.resolve({ ok: false, error: failure });
    let metadata;
    try {
      // Detach and copy screenshots before any await, including a previous
      // persistence receipt. Another call may reuse the original screenshot path.
      const serialized = JSON.stringify(data);
      requireValue(Buffer.byteLength(serialized) <= MAX_FILE_BYTES, 'recording_limit_exceeded');
      const original = JSON.parse(serialized);
      const detached = sanitizePersistentValue(original);
      const originalSha256 = jsonHash(original);
      const dataSha256 = jsonHash(detached);
      const sourcePayload = kind === 'script-call' && original.envelope.evidence?.source
        ? { originalSha256: jsonHash(original.envelope.result), archivedSha256: jsonHash(detached.envelope.result) }
        : null;
      requireValue(sequence < MAX_ATTACHMENTS, 'recording_limit_exceeded');
      sequence += 1;
      const screenshots = [];
      if (kind === 'script-call') {
        for (const ref of original.envelope.evidence?.refs || []) {
          if (ref.stream !== 'screenshot') continue;
          requireValue(typeof ref.screenshotId === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256),
            'invalid_screenshot_reference');
          const file = path.resolve(ref.screenshotId);
          const bytes = readRegularFile(path.dirname(file), path.basename(file));
          requireValue(sha256(bytes) === ref.sha256, 'screenshot_checksum_mismatch');
          checkPng(bytes);
          screenshots.push({ ...write(`${sequence}-${screenshots.length + 1}.png`, bytes), ref });
        }
      }
      const document = { schemaVersion: PAYLOAD_SCHEMA, namespace, operationId, recordingId,
        sequence, kind, target, data: detached, screenshots };
      const file = write(`${sequence}.json`, Buffer.from(JSON.stringify(document) + '\n'));
      metadata = {
        operationId, revision, target, recordingId, sequence, payloadKind: kind,
        timestampMs: now(), ...(parentFactId ? { parentFactId } : {}),
        evidenceId: `${namespace}:attachment:${operationId}:${recordingId}:${sequence}`,
        directory: root, file, screenshots: screenshots.map(({ ref, ...entry }) => entry),
        representation: originalSha256 === dataSha256 ? 'original-json' : 'redacted-json',
        originalSha256, dataSha256, sourcePayload,
      };
    } catch (error) {
      failure = error.code || 'recording_failed';
      return Promise.resolve({ ok: false, error: failure, detail: error.detail });
    }
    const pending = tail.then(async () => {
      if (failure) return { ok: false, error: failure };
      try {
        const receipt = await store.persist('attachment', metadata);
        requireValue(receipt?.ok === true && receipt.persisted === true, 'recording_not_persisted', receipt?.error);
        return receipt;
      } catch (error) {
        failure = error.code || 'recording_failed';
        return { ok: false, error: failure, detail: error.detail };
      }
    });
    tail = pending;
    return pending;
  }

  return { record, info: () => ({ recordingId, directory: root, attachments: sequence, bytes: bytesWritten, error: failure }) };
}

module.exports = { createEvidenceRecording, readRegularFile, checkPng, requireValue, sha256, jsonHash,
  PAYLOAD_SCHEMA, MAX_FILE_BYTES, MAX_RECORDING_BYTES, MAX_ATTACHMENTS };
