'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireP9Frozen } = require('../bin/script/p9-scenario-freeze');
const {
  TIMING_KEYS,
  expandSteps,
  runP9Scenario,
  scoreP9AssertionEvidence,
} = require('../bin/script/p9-scenario-runner');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/p9-scenario-manifests.json'), 'utf8'),
);

test('P9 runner stays blocked until Intent freeze', () => {
  const result = runP9Scenario(manifest, 'localsend-core-v1', {
    step: () => ({ status: 'passed' }),
  });
  assert.equal(result.error, 'p9_not_frozen');
});

test('P9 runner keeps failed steps and records the timing matrix', () => {
  const frozen = { ...manifest, frozen: true };
  const acceptance = frozen.scenarios['localsend-acceptance-v1'];
  const expanded = expandSteps(frozen, acceptance);
  assert.equal(expanded.length > acceptance.steps.length, true);
  const result = runP9Scenario(frozen, 'localsend-acceptance-v1', {
    step(step) {
      if (step.id === 'file-select-cancel') return { status: 'blocked', error: 'fixture_missing' };
      return { status: 'passed' };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps.some((step) => step.id === 'file-select-cancel' && step.status === 'blocked'), true);
  assert.equal(result.steps.some((step) => step.status === 'not_run'), true);
  assert.equal(result.steps.filter((step) => step.id === 'file-select-cancel').length, 1);
  for (const key of TIMING_KEYS) {
    assert.equal(typeof result.timings[key], 'number');
  }
});

test('P9 optional skipped onboarding does not drop later steps', () => {
  const frozen = { ...manifest, frozen: true };
  const result = runP9Scenario(frozen, 'wikipedia-core-v1', {
    step(step) {
      if (step.id === 'onboarding') return { status: 'skipped' };
      if (step.id === 'search-fixed-article') {
        return { status: 'passed', timings: { providerWaitMs: 12, evidenceQueryMs: 3 } };
      }
      return { status: 'passed' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].status, 'skipped');
  assert.equal(result.steps[0].optional, true);
  assert.equal(result.steps.some((step) => step.id === 'settings' && step.status === 'passed'), true);
  assert.equal(result.timings.providerWaitMs, 12);
  assert.equal(result.timings.evidenceQueryMs, 3);
});

test('P9 unfrozen Organic Maps labels block the step and keep later steps', () => {
  const frozen = { ...manifest, frozen: true };
  const result = runP9Scenario(frozen, 'organic-maps-core-v1', {
    labels: { search: '搜索', poi: 'Monaco', cancel: '关闭' },
    observedNotFrozen: ['bookmark', 'route'],
    step: () => ({ status: 'passed' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps.some((step) => step.id === 'add-bookmark' && step.status === 'blocked'), true);
  assert.equal(result.steps.some((step) => step.id === 'add-bookmark' && step.error === 'label_not_frozen:bookmark'), true);
  assert.equal(result.steps.some((step) => step.id === 'route-preview-cancel' && step.status === 'not_run'), true);
});

test('P9 freeze helper still rejects login and Moodle', () => {
  assert.equal(requireP9Frozen({ ...manifest, frozen: true, login: true }).error, 'p9_forbidden_surface');
});

test('P9 assertion scoring uses complete material history after live events are evicted', () => {
  const names = [
    'no-result',
    'article-visible',
    'toc-visible',
    'reading-list-sheet',
    'language-switched',
    'theme-language-restored',
    'left-article-search',
    'settings-visible',
    'repeat-left-article-search',
  ];
  const retainedAssertionNames = new Map([
    [146, 'reading-list-sheet'],
    [239, 'language-switched'],
    [275, 'theme-language-restored'],
    [296, 'left-article-search'],
    [327, 'settings-visible'],
    [383, 'repeat-left-article-search'],
  ]);
  const snapshot = {
    status: 'completed',
    eventSequence: 385,
    events: Array.from({ length: 256 }, (_, index) => {
      const sequence = index + 130;
      const name = retainedAssertionNames.get(sequence);
      return name
        ? { sequence, type: 'assertion_passed', name }
        : { sequence, type: 'call_completed' };
    }),
    rollingSummary: { assertions: { passed: 9, failed: 0, inconclusive: 0 } },
    history: {
      gap: false,
      hasMore: false,
      lastSequence: 385,
      items: names.map((name) => ({ kind: 'assertion_passed', payloadSummary: { name, scope: 'device', observationId: `obs:${name}`, refs: [{ stream: 'tree', hostObservationId: `obs:${name}` }], coverage: { status: 'complete', gap: false, committed: true } } })),
    },
  };
  assert.deepEqual(scoreP9AssertionEvidence(snapshot, names), { status: 'passed' });
});

test('P9 assertion scoring does not call a missing assertion failed when history has a gap', () => {
  const result = scoreP9AssertionEvidence({
    status: 'completed',
    eventSequence: 385,
    events: [],
    rollingSummary: { assertions: { passed: 1, failed: 0, inconclusive: 0 } },
    history: { gap: true, hasMore: false, lastSequence: 385, items: [] },
  }, ['article-visible']);
  assert.deepEqual(result, { status: 'inconclusive', error: 'assertion_history_incomplete' });
});
