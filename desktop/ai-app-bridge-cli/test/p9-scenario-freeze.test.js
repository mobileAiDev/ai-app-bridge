'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireP9Frozen, applyP9Freeze } = require('../bin/script/p9-scenario-freeze');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/p9-scenario-manifests.json'), 'utf8'),
);

test('P9 runner refuses to start before Intent freeze', () => {
  const blocked = requireP9Frozen(manifest);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'p9_not_frozen');
});

test('P9 runner refuses login or Moodle surfaces', () => {
  const login = requireP9Frozen({ ...manifest, frozen: true, login: true });
  assert.equal(login.error, 'p9_forbidden_surface');
  const moodle = requireP9Frozen({ ...manifest, frozen: true, moodle: true });
  assert.equal(moodle.error, 'p9_forbidden_surface');
  const ready = requireP9Frozen({ ...manifest, frozen: true });
  assert.equal(ready.ok, true);
});

test('P9 freeze record requires version language labels fixtureHash and initialState', () => {
  const missing = applyP9Freeze(manifest, { version: '1', language: 'zh' });
  assert.equal(missing.error, 'p9_freeze_required');
  assert.equal(missing.field, 'labels');
  const frozen = applyP9Freeze(manifest, {
    version: '1.0.0',
    language: 'zh-CN',
    labels: { settings: '设置' },
    fixtureHash: 'fixture-1',
    initialState: { page: 'home' },
  });
  assert.equal(frozen.ok, true);
  assert.equal(frozen.manifest.frozen, true);
  assert.equal(frozen.manifest.freeze.fixtureHash, 'fixture-1');
  assert.equal(requireP9Frozen(frozen.manifest).ok, true);
});
