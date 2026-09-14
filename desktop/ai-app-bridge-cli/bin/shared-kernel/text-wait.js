'use strict';

const { CommandError } = require('../command-errors');
const { foregroundNativeWindow, explicitlyHidden } = require('./native-target');
const { parseXmlAttributes } = require('./xml-attributes');
const { looksLikeAndroidUiHierarchyXml, visitAndroidUiHierarchyTags } = require('../android-uia-xml');
const { runExecution, checkExecution, executionSleep } = require('./execution-scope');

function validateTextConditions({ targetText, requireText = [], absentText = [], requireActivity, provider = 'auto' }) {
  const invalid = (field, message) => { throw new CommandError('invalid_argument', message, { field }); };
  if (!['auto', 'native', 'flutter', 'uia'].includes(provider)) invalid('provider', 'provider must be auto, native, flutter, or uia.');
  if (targetText !== undefined && (typeof targetText !== 'string' || !targetText)) invalid('targetText', 'targetText must be a non-empty exact label.');
  if (requireActivity !== undefined && (typeof requireActivity !== 'string' || !requireActivity)) invalid('requireActivity', 'requireActivity must be a full Activity class name.');
  for (const [field, values] of Object.entries({ requireText, absentText })) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) invalid(field, `${field} must be an array of non-empty exact labels.`);
  }
  const present = [...new Set([...(targetText === undefined ? [] : [targetText]), ...requireText])];
  if (!present.length && !absentText.length && !requireActivity) invalid('targetText', 'Supply targetText, requireText, absentText, or requireActivity.');
  if (!present.length && provider === 'auto') invalid('provider', 'Waiting for absence or Activity alone requires an explicit provider.');
  if (present.some(value => absentText.includes(value))) invalid('absentText', 'The same label cannot be both required and absent.');
  return { present, absent: [...new Set(absentText)], requireActivity, provider };
}

function visibleLabels(provider, rawTree) {
  const labels = new Set();
  const add = value => { if (typeof value === 'string' && value) labels.add(value); };
  const unavailable = () => { throw new CommandError('observation_unavailable', `A valid ${provider} foreground tree is required.`); };
  if (rawTree?.ok === false) unavailable();
  if (provider === 'native') {
    const window = foregroundNativeWindow(rawTree);
    if (!window?.root || explicitlyHidden(window.root) || (window.root.visible !== true && window.root.effectiveVisible !== true)) unavailable();
    const visit = node => {
      if (!node || explicitlyHidden(node) || (node.visible !== true && node.effectiveVisible !== true)) return;
      add(node.text); add(node.contentDescription);
      for (const child of node.children || []) visit(child);
    };
    visit(window.root);
  } else if (provider === 'flutter') {
    if (!Array.isArray(rawTree?.nodes)) unavailable();
    for (const node of rawTree.nodes) {
      if (node.visible === false || node.offstage === true) continue;
      add(node.text); add(node.value); add(node.label);
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
  return labels;
}

function checkTextConditions(labels, activity, conditions) {
  const missing = conditions.present.filter(value => !labels.has(value));
  const unexpected = conditions.absent.filter(value => labels.has(value));
  const activityMatches = !conditions.requireActivity || activity === conditions.requireActivity;
  return { ok: !missing.length && !unexpected.length && activityMatches, missing, unexpected, activity, activityMatches };
}

async function waitForText({ options, readTree, readForeground }) {
  const conditions = validateTextConditions(options);
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 500;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new CommandError('invalid_argument', 'intervalMs must be a positive integer.', { field: 'intervalMs' });
  const deadline = Date.now() + timeoutMs;
  let lastCheck = null;
  try {
    return await runExecution({ timeoutMs, mutation: false }, async () => {
      for (;;) {
        const foreground = await readForeground();
        checkExecution();
        if (!foreground?.ok) throw new CommandError('foreground_probe_failed', 'The foreground app could not be verified.');
        if (options.packageName && foreground.packageName !== options.packageName) throw new CommandError('foreground_package_mismatch', 'The foreground app differs from packageName.');
        let nativeTree;
        let successfulReads = 0;
        const failures = [];
        for (const provider of conditions.provider === 'auto' ? ['native', 'flutter', 'uia'] : [conditions.provider]) {
          try {
            if (provider === 'flutter') {
              nativeTree ??= await readTree('native');
              if (foregroundNativeWindow(nativeTree)?.type !== 'activity') throw new CommandError('native_foreground_blocks_flutter', 'A native foreground window covers Flutter.');
            }
            const rawTree = provider === 'native' ? (nativeTree = await readTree(provider)) : await readTree(provider);
            const labels = visibleLabels(provider, rawTree);
            const after = await readForeground();
            checkExecution();
            if (!after?.ok || after.component !== foreground.component || after.packageName !== foreground.packageName) {
              throw new CommandError('foreground_changed_during_observation', 'The foreground changed while reading text.');
            }
            successfulReads++;
            lastCheck = { ...checkTextConditions(labels, after.activity, conditions), provider, observedAtMs: Date.now() };
            if (lastCheck.ok) return { ok: true, conditions, matched: lastCheck };
          } catch (error) {
            checkExecution();
            failures.push({ provider, error: error.code || 'observation_unavailable', message: String(error.message).split('\n')[0] });
          }
        }
        if (!successfulReads) return { ok: false, error: 'observation_unavailable', dispatched: false, ambiguous: false, failures };
        await executionSleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
      }
    });
  } catch (error) {
    if (error.code !== 'deadline_exceeded') throw error;
    return { ok: false, error: 'deadline_exceeded', dispatched: false, ambiguous: false, timeoutMs, conditions, lastCheck };
  }
}

module.exports = { validateTextConditions, visibleLabels, checkTextConditions, waitForText };
