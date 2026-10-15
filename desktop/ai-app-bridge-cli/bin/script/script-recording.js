'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createEvidenceRecording, requireValue } = require('../shared-kernel/evidence-recording');

function createScriptRecording({ directory, previous, checkpointEnabled, operationId, store, now }) {
  if (directory === undefined && !previous) return null;
  if (!checkpointEnabled) return createEvidenceRecording({ directory, namespace: 'script', operationId, store, now });
  const rootDirectory = previous ? previous.rootDirectory : path.resolve(directory);
  requireValue(typeof rootDirectory === 'string' && rootDirectory.length > 0, 'recording_root_unavailable');
  fs.mkdirSync(rootDirectory, { recursive: true });
  const stat = fs.lstatSync(rootDirectory);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'invalid_recording_directory');
  const rootFile = path.join(rootDirectory, 'script-recording.json');
  if (!previous) {
    requireValue(fs.readdirSync(rootDirectory).length === 0, 'output_exists', 'recordingDir must be empty.');
    const fd = fs.openSync(rootFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 'aab.script-recording/v1', operationId }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } else {
    const root = require('../shared-kernel/evidence-recording').readRegularFile(rootDirectory, path.basename(rootFile));
    const identity = JSON.parse(root);
    requireValue(identity.schemaVersion === 'aab.script-recording/v1' && identity.operationId === operationId, 'recording_identity_mismatch');
  }
  const attemptId = randomUUID();
  const recording = createEvidenceRecording({ directory: path.join(rootDirectory, `attempt-${attemptId}`),
    namespace: 'script', operationId, store, now });
  const parent = fs.openSync(rootDirectory, 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  return { record: recording.record, info: () => ({ ...recording.info(), rootDirectory, attemptId,
    previousRecordingId: previous?.recordingId ?? null }) };
}

module.exports = { createScriptRecording };
