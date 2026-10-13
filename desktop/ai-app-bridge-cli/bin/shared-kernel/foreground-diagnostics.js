'use strict';

// Keep identity and warnings in the decision surface, and point to verbose
// diagnostics in the original retained response or observation evidence.
function projectForegroundDiagnostics(value, { path = '', evidenceId, diagnostic = false } = {}) {
  if (Array.isArray(value)) return value.map((item, index) => projectForegroundDiagnostics(item,
    { path: `${path}/${index}`, evidenceId, diagnostic }));
  if (!value || typeof value !== 'object') return value;
  diagnostic ||= value.source === 'android-window-manager';
  const result = {}, omitted = [];
  for (const [key, item] of Object.entries(value)) {
    const sourcePath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    const encoded = diagnostic && ['evidence', 'raw', 'stdout', 'stderr', 'message'].includes(key) ? JSON.stringify(item) : null;
    if (encoded && Buffer.byteLength(encoded) > 1024) {
      omitted.push({ field: key, sourcePath, bytes: Buffer.byteLength(encoded), ...(evidenceId ? { evidenceId } : {}) });
    } else result[key] = projectForegroundDiagnostics(item, { path: sourcePath, evidenceId, diagnostic });
  }
  if (omitted.length) result.diagnostics = omitted;
  return result;
}

module.exports = { projectForegroundDiagnostics };
