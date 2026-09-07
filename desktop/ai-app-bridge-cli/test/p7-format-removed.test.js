'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRemovedScriptFormat, removedScriptFormatError } = require('../bin/script/script-format-removed');

test('P7 removed format helper recognizes old steps payloads', () => {
  assert.equal(isRemovedScriptFormat({ name: 'old', steps: [{ id: 'o1', type: 'observe' }] }), true);
  assert.equal(isRemovedScriptFormat(JSON.stringify({ name: 'old', steps: [{ id: 'o1', type: 'observe' }] })), true);
  assert.equal(isRemovedScriptFormat('name: old\nsteps:\n  - id: o1\n    type: observe\n'), true);
  assert.equal(isRemovedScriptFormat('name: old\n  steps:\n    - id: o1\n      type: observe\n'), true);
  assert.equal(isRemovedScriptFormat({
    schemaVersion: 'aab.code-script/v1',
    name: 'old',
    steps: [{ id: 'o1', type: 'observe' }],
  }), true);
  assert.equal(isRemovedScriptFormat({
    schemaVersion: 'aab.code-script/v1',
    language: 'javascript',
    source: 'function main() {}\nmodule.exports = { main };',
  }), false);
  assert.equal(removedScriptFormatError().error, 'script_format_removed');
});
