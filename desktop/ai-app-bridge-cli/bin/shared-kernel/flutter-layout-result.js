'use strict';

const sources = ['widgetInspector', 'widgetDump', 'semantics', 'operable'];

// The SDK reports each source separately. A successful read may still have
// unavailable or truncated sources; keep their original evidence intact.
function flutterLayoutResult(status) {
  if (status?.ok === false) return status;
  const layout = status?.flutter?.layout;
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return { ok: false, error: 'flutter_layout_absent', dispatched: false, ambiguous: false,
      message: 'The Flutter snapshot did not include a layout.' };
  }
  if (layout.ok === false) return layout;
  const availableSources = sources.filter(source => layout[source]?.ok === true);
  const unavailableSources = sources.filter(source => layout[source]?.ok !== true);
  return { ...layout, ok: availableSources.length > 0,
    ...(availableSources.length ? {}
      : { error: 'flutter_layout_unavailable', dispatched: false, ambiguous: false,
        message: 'No Flutter layout source is available; inspect the source errors.' }),
    availableSources, unavailableSources };
}

module.exports = { flutterLayoutResult };
