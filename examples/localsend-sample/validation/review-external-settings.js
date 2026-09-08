#!/usr/bin/env node
'use strict';

// Offline companion to the public Bridge archives, which do not bundle files
// written by an external business oracle. This reviewer never contacts a phone.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expected = {
  'settings-dark': { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system' },
  'settings-dark-english': { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system', 'flutter.ls_locale': 'en' },
  'settings-restored': { 'flutter.ls_theme': 'system', 'flutter.ls_color': 'system' },
};

function review(directory, outputDirectory) {
  directory = path.resolve(directory);
  const report = read(path.join(directory, 'report.json'));
  assert.equal(report.ok, true, 'only_finished_successful_control_matrix_can_be_reviewed');
  const baseline = read(path.join(directory, 'baseline.json'));
  assert.deepEqual(baseline.settings, expected['settings-restored']);
  // An explicit second directory permits another review without overwriting an earlier bundle.
  const output = outputDirectory === undefined ? path.join(directory, 'portable-settings-review') : path.resolve(outputDirectory);
  fs.mkdirSync(output);
  fs.copyFileSync(path.join(directory, 'baseline.json'), path.join(output, 'baseline.json'));
  const results = [];
  for (const trial of report.trials) {
    const source = path.join(directory, trial.name), destination = path.join(output, trial.name);
    fs.mkdirSync(destination);
    const eventSource = path.join(source, 'events.json'), eventCopy = path.join(destination, 'events.json');
    fs.copyFileSync(eventSource, eventCopy); assert.equal(hash(eventSource), hash(eventCopy));
    const events = read(eventCopy);
    const files = [{ path: path.relative(output, eventCopy), sha256: hash(eventCopy), kind: 'public-mcp-execution-events' }];
    for (const name of ['settings-before.json', 'settings-after.json', ...trial.externalOracles.map(oracle => oracle.checkpoint + '.json')]) {
      const file = path.join(source, name), copy = path.join(destination, name);
      fs.copyFileSync(file, copy);
      const digest = hash(copy); assert.equal(digest, hash(file));
      const actual = read(copy);
      assert.equal(actual.schemaVersion, 'localsend.settings-oracle/v1');
      assert.equal(actual.serial, report.target.serial); assert.equal(actual.packageName, report.target.packageName);
      if (name === 'settings-before.json' || name === 'settings-after.json') {
        assert.deepEqual(actual.settings, baseline.settings, name + ':fixture_changed');
        const time = Date.parse(actual.capturedAt); assert(Number.isFinite(time));
        if (name === 'settings-before.json') assert(time <= events[0].atMs, 'initial_oracle_after_execution_start');
        else assert(time >= events.at(-1).atMs, 'final_oracle_before_terminal');
      } else {
        const checkpoint = name.slice(0, -'.json'.length);
        const oracle = trial.externalOracles.find(item => item.checkpoint === checkpoint);
        assert.equal(oracle.artifact.path, file); assert.equal(oracle.artifact.sha256, digest);
        assert.equal(oracle.verdict, 'passed'); assert.deepEqual(actual.settings, expected[checkpoint]);
        const question = events.find(event => event.type === 'agent_question_created' && event.request.context.checkpoint === checkpoint);
        assert(question, 'oracle_question_missing');
        const answer = events.find(event => event.type === 'agent_decision' && event.requestId === question.requestId);
        assert(answer, 'oracle_decision_missing'); assert.deepEqual(answer.decision, oracle);
        const time = Date.parse(actual.capturedAt);
        assert(time >= question.atMs && time <= answer.atMs, 'oracle_outside_its_control_checkpoint');
      }
      files.push({ path: path.relative(output, copy), sha256: digest, kind: 'independent-settings-read' });
    }
    results.push({ trial: trial.name, beforeAndAfterEqual: true, checkedChanges: trial.externalOracles.length, files });
  }
  const result = { schemaVersion: 'localsend.portable-settings-review/v1', ok: true,
    method: 'Copied allowlisted preference reads and public MCP execution events; exact values, target, checkpoint timing and recorded controller-decision hashes. These external events are a separate bundle, not claimed as public Bridge archive payloads. No ADB or live Host.',
    sourceSha256: report.sourceSha256, controllerReportSha256: hash(path.join(directory, 'report.json')),
    baselineSha256: hash(path.join(output, 'baseline.json')), results };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (require.main === module) {
  assert([3, 4].includes(process.argv.length), 'pass_the_finished_validation_directory_and_optional_new_output_directory');
  const result = review(process.argv[2], process.argv[3]); console.log(JSON.stringify({ ok: result.ok, trials: result.results.length }));
}
module.exports = { review };
