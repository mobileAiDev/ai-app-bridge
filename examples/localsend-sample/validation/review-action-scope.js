#!/usr/bin/env node
'use strict';

// Offline companion for external preference reads and screenshots. These files
// are separate from the public Bridge archive, which contains queried facts.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] || path.join(root, 'external-evidence'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = read(path.join(root, 'report.json'));
assert.equal(report.ok, true);
fs.mkdirSync(out);
const baseline = { 'flutter.ls_theme': 'system', 'flutter.ls_color': 'system' };
const files = [], oracles = [];
const copy = relative => {
  const from = path.join(root, relative), to = path.join(out, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  const sha256 = hash(from); assert.equal(hash(to), sha256);
  files.push({ path: relative, sha256 });
};
for (const file of ['report.json', 'script.js', 'controller.js', 'mcp.jsonl']) copy(file);
assert.equal(hash(path.join(out, 'script.js')), report.sourceSha256);
for (const trial of report.trials) {
  assert.equal(trial.ok, true); assert.equal(trial.offlineVerified, true);
  const events = read(path.join(root, trial.name, 'events.json'));
  events.forEach((event, index) => assert.equal(event.sequence, index + 1));
  copy(`${trial.name}/events.json`);
  for (const phase of ['before', 'after']) {
    const rel = `${trial.name}/${phase}-settings.json`, actual = read(path.join(root, rel));
    assert.equal(actual.serial, report.target.serial); assert.equal(actual.packageName, report.target.packageName);
    assert.deepEqual(actual.settings, baseline); copy(rel);
  }
  for (const phase of ['initial', 'final']) {
    const screen = read(path.join(root, trial.name, `${phase}-screenshot.json`));
    assert.equal(screen.foregroundMatchesPackage, true); assert.equal(screen.foreground.packageName, report.target.packageName);
    for (const file of [`${phase}.png`, `${phase}-screenshot.json`, `${phase}-tree.json`]) copy(`${trial.name}/${file}`);
  }
  for (const oracle of trial.oracles) {
    const rel = `${trial.name}/${oracle.checkpoint}-settings.json`, actual = read(path.join(root, rel));
    assert.equal(oracle.artifact.path, path.join(root, rel)); assert.equal(hash(oracle.artifact.path), oracle.artifact.sha256);
    assert.equal(actual.serial, report.target.serial); assert.equal(actual.packageName, report.target.packageName);
    const expected = oracle.checkpoint === 'dark' ? { ...baseline, 'flutter.ls_theme': 'dark' } : baseline;
    assert.deepEqual(actual.settings, expected); assert.deepEqual(oracle.observedSettings, expected);
    const questions = events.filter(e => e.type === 'agent_question_created' && e.request.context.checkpoint === oracle.checkpoint);
    assert.equal(questions.length, 1); const q = questions[0];
    const answer = events.find(e => e.type === 'agent_decision' && e.requestId === q.requestId);
    assert.deepEqual(answer.decision, oracle); assert.deepEqual(q.request.context.expectedSettings, expected);
    const timestamp = Date.parse(actual.capturedAt);
    assert(timestamp >= q.atMs && timestamp <= answer.atMs);
    const action = events.filter(e => e.type === 'call_completed' && e.command === 'tap-flutter' && e.sequence < q.sequence).at(-1);
    const route = trial.result.routes.find(r => r.actionId === action.actionId);
    assert(route); assert.equal(route.name, oracle.checkpoint === 'dark' ? 'select Dark' : 'restore System');
    assert.equal(route.route.data.action, 'pop'); assert(route.route.timestampMs <= timestamp);
    assert(!events.some(e => e.type === 'call_started' && e.command === 'tap-flutter' &&
      e.sequence > action.sequence && e.sequence < answer.sequence));
    oracles.push({ trial: trial.name, checkpoint: oracle.checkpoint, actionId: action.actionId,
      queryObservationId: route.evidence.observationId, routeCaptureId: route.route.id,
      artifact: { path: rel, sha256: oracle.artifact.sha256 },
      scope: 'external preference read between the controller question and reply; no intervening mutation' });
    copy(rel);
  }
}
const result = { ok: true, scope: 'external companion; does not rewrite public archives or mobile facts',
  sourceSha256: report.sourceSha256, oracles, files,
  archives: report.trials.map(t => ({ name: t.name, manifestSha256: t.archive.manifestSha256 })) };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, out, oracleCount: oracles.length, files: files.length, manifestSha256: hash(path.join(out, 'manifest.json')) }));
