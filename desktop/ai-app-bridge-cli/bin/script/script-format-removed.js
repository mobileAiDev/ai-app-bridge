'use strict';

const { scriptError } = require('./script-errors');

function isRemovedScriptFormat(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('{')) {
      try {
        return isRemovedScriptFormat(JSON.parse(trimmed));
      } catch {
        return false;
      }
    }
    return /(^|\n)[ \t]*steps\s*:/.test(trimmed);
  }
  if (!input || typeof input !== 'object') return false;
  return Array.isArray(input.steps);
}

function removedScriptFormatError() {
  return scriptError('script_format_removed', { field: 'steps' });
}

module.exports = { isRemovedScriptFormat, removedScriptFormatError };
