'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyLabelsSource } = require('../verify-labels-source');
const validation = path.resolve(__dirname, '..');

function portable(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notallyx-labels-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'examples/notallyx-sample/validation');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['source-evidence-labels-v1', 'labels-evidence-source-index-v1.json', 'verify-labels-source.js', 'source-provenance.js', 'oracles.js', 'read_snapshot.py']) fs.cpSync(path.join(validation, name), path.join(destination, name), { recursive: true });
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
  return { root, destination };
}

test('preserved duplicate rejection has exact canonical equality and does not complete the label template', () => {
  const result = verifyLabelsSource();
  assert.equal(result.ok, true); assert.equal(result.fullTemplatePassed, false);
  assert.deepEqual(result.canonical.ignoreFields, []); assert.deepEqual(result.canonical.differences, []);
  assert.equal(result.business.verdict, 'passed');
  assert.equal(result.provenance.sourceExecutionStatus['intent-1788751052004-2'].status, 'failed');
  assert(result.negativeChecks.every((check) => check.verdict === 'inconclusive'));
});

test('complete labels evidence replays after relocation without original build files', (t) => {
  const { root, destination } = portable(t);
  const result = require(path.join(destination, 'verify-labels-source.js')).verifyLabelsSource({ repositoryRoot: root });
  assert.equal(result.ok, true); assert.equal(result.counts.artifacts, 37);
  assert.equal(result.allArtifactsUnchangedAfterReview, true);
});

test('changed SQLite evidence is rejected before a historical business result can pass', (t) => {
  const { root, destination } = portable(t);
  const file = path.join(destination, 'source-evidence-labels-v1/artifacts/expansion-FYZLAU49X8OVQGJ7/duplicate-rejected-snapshot/NotallyDatabase-wal');
  const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => require(path.join(destination, 'verify-labels-source.js')).verifyLabelsSource({ repositoryRoot: root }), /historical_source_artifact_bytes_changed/);
});
