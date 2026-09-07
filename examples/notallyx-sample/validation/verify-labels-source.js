'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { verifySourceProvenance } = require('./source-provenance');
const { readSnapshot, checkSnapshot, compareCanonical, hashFile } = require('./oracles');

const VALIDATION = 'examples/notallyx-sample/validation';
const BASE = 'build/ai_app_bridge_artifacts/notallyx-migration';
const INDEX = `${VALIDATION}/labels-evidence-source-index-v1.json`;
const MANIFEST = `${VALIDATION}/source-evidence-labels-v1/bundle-manifest.json`;
const TARGET = { serial: 'FYZLAU49X8OVQGJ7', packageName: 'io.github.mobileaidev.notallyx.sample' };
const APK = 'b4fe597c6154b5fdd119746226b235e7a207fa221cefde49cdb355053967c233';

/** Replays this historical rejection from preserved portable evidence; never contacts a device. */
function verifyLabelsSource({ repositoryRoot = path.resolve(__dirname, '../../..') } = {}) {
  const provenance = verifySourceProvenance({ repositoryRoot, indexPath: INDEX, bundleManifestPath: MANIFEST });
  const entries = new Map(provenance.artifacts.filter((a) => a.originalPath && a.role === 'historical-source').map((a) => [a.originalPath, a]));
  const artifact = (originalPath) => { const row = entries.get(originalPath); assert(row, `missing portable artifact: ${originalPath}`); return row; };
  const read = (originalPath) => JSON.parse(fs.readFileSync(artifact(originalPath).path, 'utf8'));
  const newTrace = `${BASE}/intent-exploration/1788752615378`;
  const afterObserve = read(`${newTrace}/11-observe.json`).result;
  assert.equal(afterObserve.operationId, 'intent-1788752668874-1');
  assert.equal(afterObserve.ok, true); assert.equal(afterObserve.error, null);
  assert.equal(afterObserve.status, 'waiting_for_decision');
  const history = read(`${newTrace}/13-history.json`).result;
  assert.equal(history.operationId, afterObserve.operationId); assert.equal(history.status, 'completed');
  const terminal = history.events.find((event) => event.type === 'terminal'); assert(terminal);
  const shot = read(`${newTrace}/10-screenshot.json`).result;
  const png = artifact(`${BASE}/expansion-FYZLAU49X8OVQGJ7/duplicate-rejected.png`);
  assert.equal(shot.ok, true); assert.equal(shot.foregroundMatchesPackage, true);
  assert.equal(shot.targetPackageName, TARGET.packageName); assert.equal(shot.artifact.sha256, png.sha256);
  assert(fs.readFileSync(png.path).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  // Original JSON remains unchanged. Resolve declared dependencies through the verified portable graph.
  const remap = (descriptor) => {
    if (descriptor === null) return null;
    const matches = [...entries.values()].filter((row) => descriptor.path.endsWith(`/${row.originalPath}`));
    assert.equal(matches.length, 1, 'one portable dependency required');
    assert.equal(matches[0].sha256, descriptor.sha256);
    return { ...descriptor, path: matches[0].path };
  };
  const snapshot = (name, context) => {
    const original = read(`${BASE}/${name}/snapshot.json`);
    const manifest = structuredClone(original);
    manifest.acquisition.transcript = remap(manifest.acquisition.transcript);
    manifest.files = Object.fromEntries(Object.entries(manifest.files).map(([key, value]) => [key, remap(value)]));
    manifest.attachments = manifest.attachments.map(remap);
    const observed = readSnapshot(manifest, { expectedTarget: TARGET, expectedApkSha256: APK, ...context });
    assert.equal(observed.ok, true, observed.reason); return observed;
  };
  const before = snapshot('script-oppo-r8/list-restarted-db', { runId: 'script-1788752487009-10e9d2', afterSequence: 61 });
  const after = snapshot('expansion-FYZLAU49X8OVQGJ7/duplicate-rejected-snapshot', { runId: 'expansion-labels-bulk-20260907-FYZLAU49X8OVQGJ7', afterSequence: 13, minCapturedAtMs: terminal.atMs });
  assert.equal(before.snapshotId, 'efabebce-b713-45c9-a653-7bad28d42ba2');
  assert.equal(after.snapshotId, '31bc8892-b7ad-4f9d-8b8c-77b11905ab35');
  const canonical = compareCanonical(before, after, { id: 'duplicate-label-no-business-mutation', ignoreFields: [] });
  assert.equal(canonical.verdict, 'passed');
  assert.deepEqual(canonical, read(`${BASE}/expansion-FYZLAU49X8OVQGJ7/duplicate-rejection-oracle.json`));
  const business = checkSnapshot(after, { id: 'duplicate-label-exact-existing-row', noteCount: 2,
    labels: [{ value: 'AAB项目-script-1788752487009-10e9d2', order: 0 }],
    notes: [{ where: { id: 1 }, fields: { labels: ['AAB项目-script-1788752487009-10e9d2'] } }, { where: { id: 2 }, fields: { labels: [] } }] });
  assert.equal(business.verdict, 'passed');
  const staleAfter = compareCanonical(before, before);
  const unverifiedAfter = compareCanonical(before, structuredClone(after));
  assert.equal(staleAfter.verdict, 'inconclusive'); assert.equal(staleAfter.reason, 'fresh_after_snapshot_required');
  assert.equal(unverifiedAfter.verdict, 'inconclusive'); assert.equal(unverifiedAfter.reason, 'unverified_snapshot');
  for (const row of provenance.artifacts) assert.equal(hashFile(row.path), row.sha256, 'review changed preserved bytes');
  return { schemaVersion: 'aab.notallyx.labels-source-review/v1', ok: true, deviceOperations: false,
    scope: 'historical-duplicate-create-rejection-only', currentRunAcceptance: false, fullTemplatePassed: false,
    target: TARGET, apkSha256: APK, canonical, business,
    negativeChecks: [{ verdict: staleAfter.verdict, reason: staleAfter.reason }, { verdict: unverifiedAfter.verdict, reason: unverifiedAfter.reason }],
    ui: { freshObservation: afterObserve.evidenceId, screenshotSha256: png.sha256,
      toast: { text: '标签已存在', method: 'human/assistant visual review of preserved PNG; this verifier does not perform OCR' } },
    counts: provenance.counts, allArtifactsUnchangedAfterReview: true,
    provenance: { integrity: provenance.integrity, sourceExecutionStatus: provenance.sourceExecutionStatus,
      durableReceiptChecksums: { status: 'not_verified', reason: 'This replay verifies preserved file hashes and snapshot provenance; it does not reopen the Intent durable store.' } } };
}

if (require.main === module) console.log(JSON.stringify(verifyLabelsSource(), null, 2));
module.exports = { verifyLabelsSource };
