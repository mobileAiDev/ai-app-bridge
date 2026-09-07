'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireThat(condition, code) {
  if (!condition) { const error = new Error(`historical_source_${code}`); error.code = error.message; throw error; }
}
function relativePath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value) && !/[\\\x00-\x1f]/.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..'), 'unsafe_relative_path');
  return value;
}
function contained(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function readFile(file, allowedRoot) {
  const resolved = path.resolve(file);
  let real, bytes;
  try {
    real = fs.realpathSync(resolved);
    if (allowedRoot) requireThat(contained(allowedRoot, real), 'symlink_outside_allowed_directory');
    requireThat(fs.statSync(real).isFile(), 'regular_file_required');
    bytes = fs.readFileSync(real);
  } catch (error) {
    if (error.code?.startsWith('historical_source_')) throw error;
    requireThat(false, 'file_unreadable');
  }
  return { bytes, descriptor: { path: real, sha256: sha256(bytes), bytes: bytes.length } };
}
function json(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { requireThat(false, 'invalid_json'); }
}
function fileIdentity(descriptor) {
  requireThat(object(descriptor) && typeof descriptor.sha256 === 'string' && /^[a-f0-9]{64}$/.test(descriptor.sha256)
    && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0, 'invalid_file_identity');
}
function stringSet(values, label, nonempty = false) {
  requireThat(Array.isArray(values) && (!nonempty || values.length > 0)
    && values.every((value) => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length, `${label}_unique_strings_required`);
}
function pointerValue(parent, pointer) {
  requireThat(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/.test(pointer), 'invalid_json_pointer');
  let value = parent;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    requireThat(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'dependency_pointer_missing');
    value = value[key];
  }
  return value;
}

/** Verifies preserved historical bytes and their portable dependency graph, never a current business outcome. */
function verifySourceProvenance({ repositoryRoot, indexPath, bundleManifestPath }) {
  requireThat(typeof repositoryRoot === 'string' && typeof indexPath === 'string' && typeof bundleManifestPath === 'string', 'input_paths_required');
  let root;
  try { root = fs.realpathSync(repositoryRoot); } catch { requireThat(false, 'repository_root_unreadable'); }
  const manifestFile = readFile(path.resolve(root, bundleManifestPath), root);
  const bundleRoot = fs.realpathSync(path.dirname(manifestFile.descriptor.path));
  requireThat(contained(root, bundleRoot), 'bundle_directory_required');
  const manifest = json(manifestFile.bytes);
  requireThat(manifest?.schemaVersion === 'aab.notallyx.source-evidence-bundle/v1'
    && manifest.pathBase === 'repository-root', 'unsupported_bundle_schema');
  fileIdentity(manifest.originalIndex);
  relativePath(manifest.originalIndex.originalPath);
  const copyFile = readFile(path.resolve(root, relativePath(manifest.originalIndex.bundlePath)), bundleRoot);
  // indexPath is an explicit input and may be a frozen copy in an output directory outside the repository.
  const indexFile = readFile(path.resolve(root, indexPath));
  requireThat(copyFile.descriptor.sha256 === manifest.originalIndex.sha256 && copyFile.descriptor.bytes === manifest.originalIndex.bytes,
    'original_index_copy_changed');
  requireThat(indexFile.bytes.equals(copyFile.bytes), 'current_index_differs_from_original_copy');
  const index = json(indexFile.bytes);
  requireThat(index?.schemaVersion === 'aab.notallyx.evidence-source-index/v1', 'unsupported_index_schema');
  stringSet(index.sourceIntentExecutionIds, 'intent_ids', true);
  stringSet(index.sourceEvidenceRefs, 'evidence_refs');
  requireThat(Array.isArray(index.mappings) && index.mappings.every((mapping) => object(mapping)
    && typeof mapping.scenarioId === 'string' && mapping.scenarioId.length > 0
    && Array.isArray(mapping.scriptPhases) && mapping.scriptPhases.length > 0
    && mapping.scriptPhases.every((phase) => typeof phase === 'string' && phase.length > 0)
    && Array.isArray(mapping.sourceIntentExecutionIds) && mapping.sourceIntentExecutionIds.length > 0
    && mapping.sourceIntentExecutionIds.every((id) => index.sourceIntentExecutionIds.includes(id)))
    && new Set(index.mappings.map((mapping) => mapping.scenarioId)).size === index.mappings.length, 'invalid_scenario_mappings');
  for (const [left, right] of [['sourceIntentExecutionIds', 'sourceIntentExecutionIds'], ['sourceEvidenceRefs', 'sourceEvidenceRefs'],
    ['mappings', 'scenarioMappings'], ['unmapped', 'unmapped']]) {
    requireThat(isDeepStrictEqual(index[left], manifest[right]), 'index_bundle_metadata_mismatch');
  }
  if (index.sourceExecutionStatus !== undefined) requireThat(object(index.sourceExecutionStatus)
    && Object.entries(index.sourceExecutionStatus).every(([id, status]) => index.sourceIntentExecutionIds.includes(id)
      && object(status) && typeof status.status === 'string' && typeof status.reason === 'string'), 'invalid_source_execution_status');
  if (index.historicalReceiptLimitation !== undefined) requireThat(typeof index.historicalReceiptLimitation === 'string', 'invalid_receipt_limitation');
  requireThat(Array.isArray(index.sourceArtifacts) && index.sourceArtifacts.length > 0
    && Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'artifact_lists_required');

  const entries = new Map(), bundlePaths = new Set([copyFile.descriptor.path, manifestFile.descriptor.path]);
  for (const artifact of manifest.artifacts) {
    fileIdentity(artifact);
    const originalPath = relativePath(artifact.originalPath);
    const bundlePath = path.resolve(root, relativePath(artifact.bundlePath));
    requireThat(!entries.has(originalPath) && !bundlePaths.has(bundlePath), 'duplicate_artifact_mapping');
    stringSet(artifact.sourceIntentExecutionIds, 'artifact_intent_ids', true);
    requireThat(artifact.sourceIntentExecutionIds.every((id) => index.sourceIntentExecutionIds.includes(id))
      && typeof artifact.role === 'string' && artifact.role.length > 0 && Array.isArray(artifact.references), 'invalid_artifact_metadata');
    const file = readFile(bundlePath, bundleRoot);
    requireThat(file.descriptor.sha256 === artifact.sha256 && file.descriptor.bytes === artifact.bytes, 'artifact_bytes_changed');
    entries.set(originalPath, { artifact, file });
    bundlePaths.add(bundlePath);
  }
  const indexed = new Set();
  for (const source of index.sourceArtifacts) {
    requireThat(object(source), 'invalid_index_artifact');
    const originalPath = relativePath(source.path);
    const entry = entries.get(originalPath);
    requireThat(!indexed.has(originalPath), 'duplicate_index_artifact');
    requireThat(entry && entry.artifact.sha256 === source.sha256, 'index_artifact_mapping_missing_or_changed');
    indexed.add(originalPath);
  }

  const documents = new Map();
  const document = (originalPath) => {
    if (!documents.has(originalPath)) documents.set(originalPath, json(entries.get(originalPath).file.bytes));
    return documents.get(originalPath);
  };
  const links = new Map(), outgoing = new Map();
  for (const [dependencyPath, { artifact }] of entries) {
    for (const reference of artifact.references) {
      requireThat(object(reference) && entries.has(relativePath(reference.originalPath)), 'dependency_parent_missing');
      const value = pointerValue(document(reference.originalPath), reference.jsonPointer);
      requireThat(object(value) && value.path === reference.originalReference && value.sha256 === reference.sha256
        && reference.sha256 === artifact.sha256
        && (value.bytes === undefined || value.bytes === artifact.bytes), 'dependency_reference_changed');
      requireThat(typeof reference.originalReference === 'string' && (reference.originalReference === dependencyPath
        || reference.originalReference.endsWith(`/${dependencyPath}`)), 'dependency_original_path_mismatch');
      const key = JSON.stringify([reference.originalPath, reference.jsonPointer]);
      requireThat(!links.has(key), 'duplicate_dependency_reference');
      links.set(key, dependencyPath);
      if (!outgoing.has(reference.originalPath)) outgoing.set(reference.originalPath, []);
      outgoing.get(reference.originalPath).push(dependencyPath);
    }
  }
  // Snapshot v1 declares its required DB, sidecars, preferences, transcript and attachments explicitly.
  // Checking the original JSON closes omissions even if the bundle's dependency counts were also edited.
  for (const [originalPath, { artifact }] of entries) {
    if (!originalPath.endsWith('.json') && artifact.role !== 'database-snapshot-manifest') continue;
    const value = document(originalPath);
    if (value?.schemaVersion !== 'aab.notallyx-snapshot/v1') {
      requireThat(artifact.role !== 'database-snapshot-manifest', 'unsupported_snapshot_schema');
      continue;
    }
    requireThat(object(value.files) && object(value.files.database) && object(value.acquisition?.transcript)
      && Array.isArray(value.attachments), 'invalid_snapshot_dependencies');
    const pointers = ['/acquisition/transcript'];
    for (const [name, descriptor] of Object.entries(value.files)) {
      if (descriptor !== null) pointers.push(`/files/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
    for (let i = 0; i < value.attachments.length; i++) pointers.push(`/attachments/${i}`);
    for (const pointer of pointers) requireThat(links.has(JSON.stringify([originalPath, pointer])), 'snapshot_dependency_unmapped');
  }
  const reachable = new Set(indexed), queue = [...indexed];
  for (let i = 0; i < queue.length; i++) for (const dependency of outgoing.get(queue[i]) || []) {
    if (!reachable.has(dependency)) { reachable.add(dependency); queue.push(dependency); }
  }
  requireThat(reachable.size === entries.size, 'unreferenced_dependency');

  const rows = [...entries.values()];
  const indexedBytes = rows.filter(({ artifact }) => indexed.has(artifact.originalPath)).reduce((sum, { artifact }) => sum + artifact.bytes, 0);
  const artifactBytes = rows.reduce((sum, { artifact }) => sum + artifact.bytes, 0);
  const counts = { indexedArtifacts: indexed.size, dependencies: entries.size - indexed.size, artifacts: entries.size, artifactBytes };
  const expectedSelection = { indexedArtifactCount: counts.indexedArtifacts, referencedDependencyCount: counts.dependencies,
    sourceArtifactCount: counts.artifacts, originalIndexCopies: 1, originalBytes: artifactBytes + copyFile.descriptor.bytes,
    indexedArtifactBytes: indexedBytes, dependencyBytes: artifactBytes - indexedBytes };
  requireThat(object(manifest.selection) && Object.entries(expectedSelection).every(([key, value]) => manifest.selection[key] === value), 'selection_totals_mismatch');
  return {
    schemaVersion: 'aab.notallyx.source-provenance/v1', integrity: 'verified', scope: 'historical-source-only', currentRunAcceptance: false,
    durableReceiptChecksums: { status: 'not_verified', reason: 'Only preserved file hashes and dependency integrity were verified; this verifier does not reopen durable envelope checksums.' },
    sourceIntentExecutionIds: index.sourceIntentExecutionIds, sourceEvidenceRefs: index.sourceEvidenceRefs,
    scenarioMappings: index.mappings, counts,
    ...(index.sourceExecutionStatus !== undefined ? { sourceExecutionStatus: index.sourceExecutionStatus } : {}),
    ...(index.historicalReceiptLimitation !== undefined ? { historicalReceiptLimitation: index.historicalReceiptLimitation } : {}),
    artifacts: [
      { ...indexFile.descriptor, role: 'historical-source-index' },
      { ...copyFile.descriptor, role: 'historical-source-index-copy', originalPath: manifest.originalIndex.originalPath },
      { ...manifestFile.descriptor, role: 'historical-source-manifest' },
      ...rows.map(({ artifact, file }) => ({ ...file.descriptor, role: 'historical-source', originalRole: artifact.role, originalPath: artifact.originalPath })),
    ],
  };
}

module.exports = { verifySourceProvenance };
