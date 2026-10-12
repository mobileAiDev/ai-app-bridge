'use strict';

const { parseXmlAttributes } = require('./xml-attributes');

// Coverage describes the material supplied by the provider. It is independent
// of Host summary/output budgets and never changes action admission.
function observationCoverage(provider, rawTree) {
  let source = rawTree;
  let scope = 'provider-tree';
  if (provider === 'native') {
    scope = 'foreground-window';
    source = Array.isArray(rawTree?.windows) && rawTree.windows.length
      ? rawTree.windows.find(window => window.windowId === rawTree.foregroundWindowId)
        || { coverage: { status: 'unknown', reason: 'foreground_window_unavailable' } } : rawTree;
  } else if (provider === 'flutter') {
    scope = 'operable-nodes';
    source = rawTree?.operable || rawTree?.layout?.operable || rawTree;
  } else if (provider === 'h5') {
    scope = 'dom-observation';
    source = rawTree?.dom || rawTree;
  } else if (provider === 'uia') {
    scope = 'accessibility-windows';
    const xml = typeof rawTree === 'string' ? rawTree : rawTree?.xml || rawTree?.hierarchy;
    if (typeof xml === 'string') {
      const tag = xml.match(/<hierarchy\b[^>]*>/)?.[0];
      const attrs = tag ? parseXmlAttributes(tag) : {};
      const truncated = attrs['aab-truncated'];
      source = { ...(typeof rawTree === 'object' ? rawTree : {}),
        ...(['true', 'false'].includes(truncated) ? { truncated: truncated === 'true' } : {}) };
      try { source.warnings = JSON.parse(attrs['aab-warnings'] || '[]'); } catch { /* Preserve unreported coverage. */ }
      if (Array.isArray(source.warnings) && source.warnings.some(warning => ['uia_window_root_unavailable', 'uia_tree_incomplete', 'uia_windows_unavailable'].includes(warning?.code))) source.truncated = true;
      if (!require('../android-uia-xml').looksLikeAndroidUiHierarchyXml(xml)) source.truncated = true;
    }
  }
  const reported = source?.coverage;
  if (reported && ['complete', 'partial', 'unknown'].includes(reported.status)) return { ...reported, scope };
  const truncated = source?.truncated === true || source?.bodyTextTruncated === true;
  return { status: truncated ? 'partial' : source?.truncated === false ? 'complete' : 'unknown', scope,
    ...(truncated ? { reason: 'provider_truncated' } : source?.truncated === false ? {} : { reason: 'provider_coverage_unreported' }) };
}

module.exports = { observationCoverage };
