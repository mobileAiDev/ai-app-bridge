'use strict';

const { requireP9Frozen } = require('./p9-scenario-freeze');

const TIMING_KEYS = [
  'activeMs',
  'providerWaitMs',
  'businessWaitMs',
  'decisionWaitMs',
  'pausedMs',
  'evidenceQueryMs',
  'wallMs',
];

function emptyTimings() {
  return {
    activeMs: 0,
    providerWaitMs: 0,
    businessWaitMs: 0,
    decisionWaitMs: 0,
    pausedMs: 0,
    evidenceQueryMs: 0,
    wallMs: 0,
  };
}

const STEP_REQUIRED_LABELS = {
  'search-fixed-poi': ['search', 'poi'],
  'add-bookmark': ['bookmark'],
  'route-preview-cancel': ['route', 'cancel'],
  'no-result-search': ['noResult', 'noResultQuery'],
  'bookmark-delete-restore': ['bookmarkDelete', 'bookmarkRestore'],
  'route-cancel-back': ['route', 'cancel', 'back'],
  'settings-restore': ['settings', 'settingsRestore'],
};

function unfrozenLabelBlock(step, labels, observedNotFrozen) {
  const needed = STEP_REQUIRED_LABELS[step.id];
  if (!needed) return null;
  const pending = new Set(observedNotFrozen || []);
  const missing = needed.filter((key) => {
    if (pending.has(key)) return true;
    return typeof labels?.[key] !== 'string' || labels[key].length === 0;
  });
  if (missing.length === 0) return null;
  return { status: 'blocked', error: `label_not_frozen:${missing.join(',')}` };
}

function expandSteps(manifest, scenario) {
  const included = scenario.includes ? manifest.scenarios[scenario.includes] : null;
  const prefix = included && Array.isArray(included.steps) ? included.steps : [];
  return prefix.concat(scenario.steps);
}

function scoreP9AssertionEvidence(snapshot, requiredNames) {
  const summary = snapshot && snapshot.rollingSummary && snapshot.rollingSummary.assertions;
  const history = snapshot && snapshot.history;
  if (!snapshot || snapshot.status !== 'completed') {
    return { status: 'inconclusive', error: 'assertion_run_not_completed' };
  }
  if (!summary || summary.inconclusive !== 0) {
    return { status: 'inconclusive', error: 'assertion_summary_incomplete' };
  }
  if (summary.failed !== 0) {
    return { status: 'failed', error: 'assertion_summary_failed' };
  }
  if (summary.passed !== requiredNames.length) {
    return { status: 'inconclusive', error: 'assertion_summary_count_mismatch' };
  }
  if (
    !history
    || history.gap !== false
    || history.hasMore !== false
    || history.lastSequence !== snapshot.eventSequence
    || !Array.isArray(history.items)
  ) {
    return { status: 'inconclusive', error: 'assertion_history_incomplete' };
  }
  const passedFacts = history.items.filter((fact) => fact.kind === 'assertion_passed');
  if (passedFacts.length !== summary.passed) {
    return { status: 'inconclusive', error: 'assertion_history_summary_mismatch' };
  }
  if (passedFacts.some((fact) => {
    const proof = fact.payloadSummary;
    return proof?.scope !== 'device' || typeof proof.observationId !== 'string'
      || !Array.isArray(proof.refs) || proof.refs.length === 0
      || proof.coverage?.status !== 'complete' || proof.coverage.gap !== false || proof.coverage.committed !== true;
  })) {
    return { status: 'inconclusive', error: 'assertion_device_evidence_missing' };
  }
  const passedNames = new Set(passedFacts.map(
    (fact) => fact.payloadSummary && fact.payloadSummary.name,
  ).filter((name) => typeof name === 'string' && name.length > 0));
  const missing = requiredNames.filter((name) => !passedNames.has(name));
  if (missing.length > 0) {
    return { status: 'failed', error: `assertion_missing:${missing.join(',')}` };
  }
  return { status: 'passed' };
}

function runP9Scenario(manifest, scenarioId, handlers = {}) {
  const frozen = requireP9Frozen(manifest);
  if (!frozen.ok) return frozen;
  const scenario = manifest.scenarios && manifest.scenarios[scenarioId];
  if (!scenario || !Array.isArray(scenario.steps)) {
    return { ok: false, error: 'p9_scenario_missing', scenarioId };
  }
  const steps = expandSteps(manifest, scenario);
  const results = [];
  const startedAt = Date.now();
  const timings = emptyTimings();
  let stopped = false;
  for (const step of steps) {
    if (stopped) {
      results.push({
        id: step.id,
        expectPage: step.expectPage,
        evidence: step.evidence,
        status: 'not_run',
      });
      continue;
    }
    const result = unfrozenLabelBlock(step, handlers.labels, handlers.observedNotFrozen)
      || (typeof handlers.step === 'function' ? handlers.step(step) : { status: 'blocked', error: 'p9_step_handler_missing' });
    results.push({
      id: step.id,
      expectPage: step.expectPage,
      evidence: step.evidence,
      optional: step.optional === true,
      status: result.status,
      error: result.error || null,
    });
    if (result.timings) {
      for (const key of TIMING_KEYS) {
        if (key === 'wallMs') continue;
        if (typeof result.timings[key] === 'number') {
          timings[key] += result.timings[key];
        }
      }
    }
    if (
      !step.optional
      && (result.status === 'failed' || result.status === 'blocked' || result.status === 'inconclusive')
    ) {
      stopped = true;
    }
  }
  timings.wallMs = Date.now() - startedAt;
  return {
    ok: results.every((item) => item.status === 'passed' || item.status === 'skipped'),
    scenarioId,
    kind: scenario.kind,
    steps: results,
    timings,
  };
}

module.exports = {
  TIMING_KEYS,
  emptyTimings,
  expandSteps,
  runP9Scenario,
  scoreP9AssertionEvidence,
  unfrozenLabelBlock,
  STEP_REQUIRED_LABELS,
};
