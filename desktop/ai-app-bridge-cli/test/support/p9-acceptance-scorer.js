'use strict';

const ORGANIC_MAPS_POSTCONDITIONS = Object.freeze({
  'open-offline-map': ['map-visible'],
  'search-fixed-poi': ['poi-visible'],
  'add-bookmark': ['bookmark-added'],
  'route-preview-cancel': ['route-preview', 'route-cancelled'],
  'no-result-search': ['no-result-search'],
  'bookmark-delete-restore': ['bookmark-deleted', 'bookmark-restored'],
  'route-cancel-back': ['route-preview', 'route-cancelled'],
  'settings-restore': ['settings-changed', 'settings-restored', 'map-after-settings'],
});

function scoreNamedPostconditions(snapshot, names) {
  const history = snapshot?.history;
  if (snapshot?.status !== 'completed' || !history || history.gap !== false || history.hasMore !== false
    || history.lastSequence !== snapshot.eventSequence || !Array.isArray(history.items)) {
    return { status: 'inconclusive', error: 'postcondition_history_incomplete' };
  }
  for (const name of names) {
    const facts = history.items.filter((fact) => fact.kind.startsWith('assertion_') && fact.payloadSummary?.name === name);
    if (facts.length !== 1) return { status: 'inconclusive', error: `postcondition_missing_or_duplicate:${name}` };
    const fact = facts[0];
    if (fact.kind === 'assertion_failed') return { status: 'failed', error: `postcondition_failed:${name}` };
    const payload = fact.payloadSummary;
    if (fact.kind !== 'assertion_passed' || payload.scope !== 'device'
      || !payload.observationId || !Array.isArray(payload.refs) || payload.refs.length === 0
      || payload.coverage?.status !== 'complete' || payload.coverage.gap !== false || payload.coverage.committed !== true) {
      return { status: 'inconclusive', error: `postcondition_not_verified:${name}` };
    }
  }
  return { status: 'passed' };
}

function scoreOrganicMapsStep(snapshot, step) {
  if (step.id === 'onboarding' && step.optional === true) return { status: 'skipped' };
  const names = ORGANIC_MAPS_POSTCONDITIONS[step.id];
  if (!names) return { status: 'inconclusive', error: `postcondition_not_defined:${step.id}` };
  return scoreNamedPostconditions(snapshot, names);
}

module.exports = { ORGANIC_MAPS_POSTCONDITIONS, scoreNamedPostconditions, scoreOrganicMapsStep };
