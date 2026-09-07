'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifySourceProvenance } = require('../source-provenance');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aab-source-provenance-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexPath = 'validation/evidence-source-index.json';
  const bundleManifestPath = 'validation/source-evidence/bundle-manifest.json';
  const bundle = 'validation/source-evidence/';
  const prefix = 'build/history/';
  const write = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const sourceIds = ['intent-history'];
  const artifacts = [];
  const add = (name, bytes, role, references = []) => {
    bytes = Buffer.from(typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
    const row = { originalPath: prefix + name, bundlePath: bundle + 'artifacts/' + name, sha256: sha(bytes), bytes: bytes.length,
      sourceIntentExecutionIds: sourceIds, role, references };
    write(row.bundlePath, bytes); artifacts.push(row); return row;
  };
  const database = add('NotallyDatabase', 'database bytes', 'database-database');
  const transcript = add('acquisition.json', { schemaVersion: 'historical-acquisition', commands: [] }, 'database-acquisition-transcript');
  const snapshot = { schemaVersion: 'aab.notallyx-snapshot/v1',
    files: { database: { path: '/old/repository/' + database.originalPath, sha256: database.sha256, bytes: database.bytes }, wal: null },
    acquisition: { transcript: { path: '/old/repository/' + transcript.originalPath, sha256: transcript.sha256 } }, attachments: [] };
  const snapshotRow = add('snapshot.json', snapshot, 'database-snapshot-manifest');
  database.references.push({ originalPath: snapshotRow.originalPath, jsonPointer: '/files/database', originalReference: snapshot.files.database.path, sha256: database.sha256 });
  transcript.references.push({ originalPath: snapshotRow.originalPath, jsonPointer: '/acquisition/transcript', originalReference: snapshot.acquisition.transcript.path, sha256: transcript.sha256 });
  const mappings = [{ scenarioId: 'text.normal', scriptPhases: ['create'], sourceIntentExecutionIds: sourceIds, coverage: 'partial', reason: 'Historical selectors only.' }];
  const index = { schemaVersion: 'aab.notallyx.evidence-source-index/v1', sourceIntentExecutionIds: sourceIds, sourceEvidenceRefs: ['intent:history:1'],
    sourceArtifacts: [{ path: snapshotRow.originalPath, sha256: snapshotRow.sha256 }], mappings, unmapped: 'All other cases remain unmapped.' };
  const manifest = { schemaVersion: 'aab.notallyx.source-evidence-bundle/v1', pathBase: 'repository-root',
    originalIndex: { originalPath: indexPath, bundlePath: bundle + 'index-original.json' },
    sourceIntentExecutionIds: sourceIds, sourceEvidenceRefs: index.sourceEvidenceRefs, scenarioMappings: mappings, unmapped: index.unmapped,
    selection: {}, artifacts };
  const saveIndex = () => {
    const bytes = Buffer.from(JSON.stringify(index)); write(indexPath, bytes); write(manifest.originalIndex.bundlePath, bytes);
    Object.assign(manifest.originalIndex, { sha256: sha(bytes), bytes: bytes.length });
  };
  const saveManifest = (recount = true) => {
    if (recount) {
      const indexedPaths = new Set(index.sourceArtifacts.map((a) => a.path));
      const artifactBytes = manifest.artifacts.reduce((sum, row) => sum + row.bytes, 0);
      const indexedBytes = manifest.artifacts.filter((row) => indexedPaths.has(row.originalPath)).reduce((sum, row) => sum + row.bytes, 0);
      manifest.selection = { indexedArtifactCount: index.sourceArtifacts.length, referencedDependencyCount: manifest.artifacts.length - index.sourceArtifacts.length,
        sourceArtifactCount: manifest.artifacts.length, originalIndexCopies: 1, originalBytes: artifactBytes + manifest.originalIndex.bytes,
        indexedArtifactBytes: indexedBytes, dependencyBytes: artifactBytes - indexedBytes };
    }
    write(bundleManifestPath, JSON.stringify(manifest));
  };
  saveIndex(); saveManifest();
  return { root, indexPath, bundleManifestPath, index, manifest, snapshot, database, transcript, snapshotRow,
    write, add, saveIndex, saveManifest, verify: (changes = {}) => verifySourceProvenance({ repositoryRoot: root, indexPath, bundleManifestPath, ...changes }) };
}

test('portable historical byte graph verifies without original build directory and never grants current acceptance', (t) => {
  const f = fixture(t); const result = f.verify();
  assert.equal(fs.existsSync(path.join(f.root, 'build')), false);
  assert.equal(result.integrity, 'verified'); assert.equal(result.scope, 'historical-source-only');
  assert.equal(result.currentRunAcceptance, false); assert.equal(result.durableReceiptChecksums.status, 'not_verified');
  assert.deepEqual(result.scenarioMappings, f.index.mappings); assert.equal(result.scenarioMappings[0].coverage, 'partial');
  assert.equal(result.counts.indexedArtifacts, 1); assert.equal(result.counts.dependencies, 2);
  assert.equal(result.artifacts.length, 6);
  for (const artifact of result.artifacts) assert.equal(sha(fs.readFileSync(artifact.path)), artifact.sha256);
});

test('explicit frozen index outside repository can verify; bundle cannot resolve outside its own directory', (t) => {
  const f = fixture(t); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-source-index-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const frozen = path.join(temp, 'frozen.json'); fs.copyFileSync(path.join(f.root, f.indexPath), frozen);
  assert.equal(f.verify({ indexPath: frozen }).integrity, 'verified');
  f.write('elsewhere/database', 'database bytes'); f.database.bundlePath = 'elsewhere/database'; f.saveManifest();
  assert.throws(() => f.verify(), /outside_allowed_directory/);
});

test('current index changed after freezing and original copy tampering both fail closed', (t) => {
  const f = fixture(t); fs.appendFileSync(path.join(f.root, f.indexPath), '\n');
  assert.throws(() => f.verify(), /current_index_differs/);
  f.saveIndex(); f.saveManifest(); fs.appendFileSync(path.join(f.root, f.manifest.originalIndex.bundlePath), '\n');
  assert.throws(() => f.verify(), /original_index_copy_changed/);
});

test('unknown schema or pathBase is not interpreted as a compatibility format', (t) => {
  const f = fixture(t); f.manifest.pathBase = 'manifest-directory'; f.saveManifest();
  assert.throws(() => f.verify(), /unsupported_bundle_schema/);
  f.manifest.pathBase = 'repository-root'; f.index.schemaVersion = 'aab.notallyx.evidence-source-index/v2'; f.saveIndex(); f.saveManifest();
  assert.throws(() => f.verify(), /unsupported_index_schema/);
});

test('missing indexed mapping and different mapping SHA both reject', (t) => {
  const f = fixture(t); f.index.sourceArtifacts[0].sha256 = '0'.repeat(64); f.saveIndex(); f.saveManifest();
  assert.throws(() => f.verify(), /index_artifact_mapping_missing_or_changed/);
  f.index.sourceArtifacts[0].path = 'build/history/missing.json'; f.saveIndex(); f.saveManifest();
  assert.throws(() => f.verify(), /index_artifact_mapping_missing_or_changed/);
});

test('missing and tampered dependency bytes reject even when indexed snapshot remains intact', (t) => {
  const f = fixture(t); f.write(f.database.bundlePath, 'corrupt bytes');
  assert.throws(() => f.verify(), /artifact_bytes_changed/);
  fs.unlinkSync(path.join(f.root, f.database.bundlePath));
  assert.throws(() => f.verify(), /file_unreadable/);
});

test('byte count mismatch rejects independently of matching SHA', (t) => {
  const f = fixture(t); f.database.bytes++; f.saveManifest();
  assert.throws(() => f.verify(), /artifact_bytes_changed/);
});

test('removing a required dependency and recounting manifest still rejects from original snapshot declarations', (t) => {
  const f = fixture(t); f.manifest.artifacts = f.manifest.artifacts.filter((row) => row !== f.database); f.saveManifest();
  assert.throws(() => f.verify(), /snapshot_dependency_unmapped/);
});

test('changed JSON pointer, reference path and reference hash reject', (t) => {
  const f = fixture(t); const reference = f.database.references[0];
  reference.jsonPointer = '/files/missing'; f.saveManifest(); assert.throws(() => f.verify(), /dependency_pointer_missing/);
  reference.jsonPointer = '/files/database'; reference.originalReference = '/old/wrong'; f.saveManifest();
  assert.throws(() => f.verify(), /dependency_reference_changed/);
  reference.originalReference = f.snapshot.files.database.path; reference.sha256 = 'f'.repeat(64); f.saveManifest();
  assert.throws(() => f.verify(), /dependency_reference_changed/);
});

test('duplicate original mapping, bundle destination and reference are not ambiguous accepted evidence', (t) => {
  const f = fixture(t); f.manifest.artifacts.push({ ...f.database }); f.saveManifest();
  assert.throws(() => f.verify(), /duplicate_artifact_mapping/);
  f.manifest.artifacts.pop(); const prior = f.transcript.bundlePath; f.transcript.bundlePath = f.database.bundlePath; f.saveManifest();
  assert.throws(() => f.verify(), /duplicate_artifact_mapping/);
  f.transcript.bundlePath = prior; f.database.references.push({ ...f.database.references[0] }); f.saveManifest();
  assert.throws(() => f.verify(), /duplicate_dependency_reference/);
});

test('unreferenced extra dependency and inaccurate selection totals reject', (t) => {
  const f = fixture(t); f.add('unrelated', 'unrelated bytes', 'unrelated'); f.saveManifest();
  assert.throws(() => f.verify(), /unreferenced_dependency/);
  f.manifest.artifacts.pop(); f.saveManifest(); f.manifest.selection.originalBytes++; f.saveManifest(false);
  assert.throws(() => f.verify(), /selection_totals_mismatch/);
});

test('portable manifest retains exact mapping qualifications and Intent references', (t) => {
  const f = fixture(t); f.manifest.scenarioMappings = structuredClone(f.index.mappings); f.manifest.scenarioMappings[0].coverage = 'full'; f.saveManifest();
  assert.throws(() => f.verify(), /index_bundle_metadata_mismatch/);
  f.manifest.scenarioMappings = f.index.mappings; f.manifest.sourceEvidenceRefs = ['invented']; f.saveManifest();
  assert.throws(() => f.verify(), /index_bundle_metadata_mismatch/);
});

test('traversal, absolute, Windows and normalized-alias artifact paths are rejected', (t) => {
  const f = fixture(t);
  for (const unsafe of ['../outside', '/tmp/outside', 'C:/outside', 'folder\\outside', 'folder/./file', 'folder//file', 'folder/../file']) {
    f.database.bundlePath = unsafe; f.saveManifest(); assert.throws(() => f.verify(), /unsafe_relative_path/, unsafe);
  }
});

test('symlinked dependency cannot escape bundle even to valid bytes elsewhere in repository', (t) => {
  const f = fixture(t); const outside = f.write('outside/database', 'database bytes');
  const destination = path.join(f.root, f.database.bundlePath); fs.unlinkSync(destination); fs.symlinkSync(outside, destination);
  assert.throws(() => f.verify(), /symlink_outside_allowed_directory/);
});

test('attachments are required dependencies, even when omitted from edited manifest selection', (t) => {
  const f = fixture(t); f.snapshot.attachments.push({ path: '/old/repository/build/history/photo.jpg', sha256: 'f'.repeat(64), bytes: 3 });
  const bytes = Buffer.from(JSON.stringify(f.snapshot)); f.write(f.snapshotRow.bundlePath, bytes);
  f.snapshotRow.sha256 = sha(bytes); f.snapshotRow.bytes = bytes.length; f.index.sourceArtifacts[0].sha256 = sha(bytes);
  f.saveIndex(); f.saveManifest(); assert.throws(() => f.verify(), /snapshot_dependency_unmapped/);
});

test('historical inconclusive execution status stays inconclusive and receipt verification stays separate', (t) => {
  const f = fixture(t);
  f.index.sourceExecutionStatus = { 'intent-history': { status: 'inconclusive', reason: 'Only a fragment succeeded.' } };
  f.index.historicalReceiptLimitation = 'Preserved byte hashes do not validate old receipt envelopes.';
  f.saveIndex(); f.saveManifest();
  const result = f.verify();
  assert.deepEqual(result.sourceExecutionStatus, f.index.sourceExecutionStatus);
  assert.equal(result.historicalReceiptLimitation, f.index.historicalReceiptLimitation);
  assert.equal(result.durableReceiptChecksums.status, 'not_verified');
  assert.equal(result.currentRunAcceptance, false);
});

test('an attachment with intact bytes and original JSON reference is included in the verified graph', (t) => {
  const f = fixture(t); const photo = f.add('photo.jpg', 'photo bytes', 'database-attachment');
  const descriptor = { path: '/old/repository/' + photo.originalPath, sha256: photo.sha256, bytes: photo.bytes, kind: 'images', name: 'photo.jpg' };
  f.snapshot.attachments.push(descriptor);
  photo.references.push({ originalPath: f.snapshotRow.originalPath, jsonPointer: '/attachments/0', originalReference: descriptor.path, sha256: photo.sha256 });
  const bytes = Buffer.from(JSON.stringify(f.snapshot)); f.write(f.snapshotRow.bundlePath, bytes);
  f.snapshotRow.sha256 = sha(bytes); f.snapshotRow.bytes = bytes.length; f.index.sourceArtifacts[0].sha256 = sha(bytes);
  f.saveIndex(); f.saveManifest();
  assert.equal(f.verify().counts.dependencies, 3);
});
