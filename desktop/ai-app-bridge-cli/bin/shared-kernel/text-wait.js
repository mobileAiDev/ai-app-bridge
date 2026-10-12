'use strict';

const { CommandError } = require('../command-errors');
const { foregroundNativeWindow, explicitlyHidden } = require('./native-target');
const { parseXmlAttributes } = require('./xml-attributes');
const { looksLikeAndroidUiHierarchyXml, visitAndroidUiHierarchyTags } = require('../android-uia-xml');
const { runExecution, checkExecution, executionSleep } = require('./execution-scope');
const { readForegroundFeedback, withForeground } = require('./android-foreground-feedback');
const { observationCoverage } = require('./observation-coverage');

function validateTextConditions({ targetText, requireText = [], absentText = [], requireActivity, provider = 'native', absenceScope = 'complete' }) {
  const invalid = (field, message) => { throw new CommandError('invalid_argument', message, { field }); };
  if (!['auto', 'native', 'flutter', 'uia'].includes(provider)) invalid('provider', 'provider must be auto, native, flutter, or uia.');
  if (!['complete', 'observed'].includes(absenceScope)) invalid('absenceScope', 'absenceScope must be complete or observed.');
  if (targetText !== undefined && (typeof targetText !== 'string' || !targetText)) invalid('targetText', 'targetText must be a non-empty exact label.');
  if (requireActivity !== undefined && (typeof requireActivity !== 'string' || !requireActivity)) invalid('requireActivity', 'requireActivity must be a full Activity class name.');
  for (const [field, values] of Object.entries({ requireText, absentText })) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) invalid(field, `${field} must be an array of non-empty exact labels.`);
  }
  const present = [...new Set([...(targetText === undefined ? [] : [targetText]), ...requireText])];
  if (!present.length && !absentText.length && !requireActivity) invalid('targetText', 'Supply targetText, requireText, absentText, or requireActivity.');
  if (!present.length && provider === 'auto') invalid('provider', 'Waiting for absence or Activity alone requires an explicit provider.');
  if (present.some(value => absentText.includes(value))) invalid('absentText', 'The same label cannot be both required and absent.');
  return { present, absent: [...new Set(absentText)], requireActivity, provider, absenceScope };
}

function visibleObservation(provider, rawTree) {
  const labels = new Set();
  let coverage = observationCoverage(provider, rawTree);
  const add = value => { if (typeof value === 'string' && value) labels.add(value); };
  const addField = (node, key) => {
    if (node[`${key}Truncated`] === true) coverage = { ...coverage, status: 'partial', reason: 'label_truncated' };
    else add(node[key]);
  };
  const unavailable = () => { throw new CommandError(rawTree?.error || 'observation_unavailable', rawTree?.message || `A valid ${provider} foreground tree is required.`); };
  if (rawTree?.ok === false) unavailable();
  if (provider === 'native') {
    const window = foregroundNativeWindow(rawTree);
    if (!window?.root || explicitlyHidden(window.root) || (window.root.visible !== true && window.root.effectiveVisible !== true)) unavailable();
    const visit = node => {
      if (!node || explicitlyHidden(node) || (node.visible !== true && node.effectiveVisible !== true)) return;
      addField(node, 'text'); addField(node, 'contentDescription');
      if (node.childrenTruncated === true) coverage = { ...coverage, status: 'partial', reason: 'children_truncated' };
      for (const child of node.children || []) visit(child);
    };
    visit(window.root);
  } else if (provider === 'flutter') {
    if (!Array.isArray(rawTree?.nodes)) unavailable();
    for (const node of rawTree.nodes) {
      if (node.visible === false || node.offstage === true) continue;
      addField(node, 'text'); addField(node, 'value'); addField(node, 'label');
    }
  } else {
    if (typeof rawTree !== 'string' || !looksLikeAndroidUiHierarchyXml(rawTree)) unavailable();
    const hidden = [];
    visitAndroidUiHierarchyTags(rawTree, ({ tag, closing, selfClosing }) => {
      if (closing) { hidden.pop(); return; }
      const attrs = parseXmlAttributes(tag);
      const isHidden = hidden.at(-1) || attrs['visible-to-user'] === 'false' || attrs.displayed === 'false';
      if (!isHidden) { add(attrs.text); add(attrs['content-desc']); }
      if (!selfClosing) hidden.push(isHidden);
    });
  }
  return { labels, coverage };
}

function visibleLabels(provider, rawTree) { return visibleObservation(provider, rawTree).labels; }

function checkTextConditions(labels, activity, conditions, coverage = { status: 'unknown' }) {
  const missing = conditions.present.filter(value => !labels.has(value));
  const unexpected = conditions.absent.filter(value => labels.has(value));
  const activityMatches = !conditions.requireActivity || activity === conditions.requireActivity;
  const absenceProven = !conditions.absent.length || conditions.absenceScope === 'observed' || coverage.status === 'complete';
  return { ok: !missing.length && !unexpected.length && activityMatches && absenceProven,
    missing, unexpected, activity, activityMatches, absenceProven, coverage,
    ...(conditions.absent.length ? { absenceScope: conditions.absenceScope } : {}) };
}

async function waitForText({ options, readTree, readForeground }) {
  const conditions = validateTextConditions(options);
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 500;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new CommandError('invalid_argument', 'intervalMs must be a positive integer.', { field: 'intervalMs' });
  const deadline = Date.now() + timeoutMs;
  const startedAtMs = Date.now();
  let lastCheck = null;
  let feedback;
  let rounds = 0, attempts = 0, successfulReads = 0, failedReads = 0;
  const failures = new Map();
  const foreground = previous => readForegroundFeedback(options,
    () => conditions.requireActivity ? readForeground() : runExecution({ timeoutMs: Math.max(1, Math.min(500, Math.floor(timeoutMs / 4))) }, readForeground), previous);
  const progress = () => ({ rounds, attempts, successfulReads, failedReads, elapsedMs: Date.now() - startedAtMs,
    failures: [...failures.values()] });
  try {
    return await runExecution({ timeoutMs, mutation: false }, async () => {
      const initialFeedback = await foreground();
      feedback = initialFeedback;
      for (;;) {
        rounds++;
        checkExecution();
        for (const provider of conditions.provider === 'auto' ? ['native', 'flutter', 'uia'] : [conditions.provider]) {
          attempts++;
          try {
            const rawTree = await readTree(provider);
            const { labels, coverage } = visibleObservation(provider, rawTree);
            checkExecution();
            successfulReads++;
            lastCheck = { ...checkTextConditions(labels, null, conditions, coverage), provider, observedAtMs: Date.now() };
            // Poll the requested evidence, not two WindowManager dumps on every
            // failed text check. Keep the initial and latest foreground facts.
            if (lastCheck.ok || conditions.requireActivity) {
              const before = feedback.foregroundObservations.at(-1);
              const after = await foreground(before);
              feedback = withForeground(after, initialFeedback);
              checkExecution();
              const actual = after.foregroundObservations[0].actual;
              const activity = actual?.ok && (!options.packageName || actual.packageName === options.packageName) ? actual.activity : null;
              lastCheck = { ...lastCheck, ...checkTextConditions(labels, activity, conditions, coverage) };
            }
            if (lastCheck.ok) return withForeground({ ok: true, conditions, matched: lastCheck, ...progress() }, feedback);
          } catch (error) {
            checkExecution();
            failedReads++;
            failures.set(provider, { provider, error: error.code || 'observation_unavailable', message: String(error.message).split('\n')[0], observedAtMs: Date.now() });
          }
        }
        await executionSleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
      }
    });
  } catch (error) {
    if (error.code !== 'deadline_exceeded') throw error;
    return withForeground({ ok: false, error: successfulReads ? 'deadline_exceeded' : 'observation_unavailable',
      deadlineExceeded: true, dispatched: false, ambiguous: false, timeoutMs, conditions, lastCheck, ...progress() }, feedback);
  }
}

module.exports = { validateTextConditions, visibleLabels, visibleObservation, checkTextConditions, waitForText };
