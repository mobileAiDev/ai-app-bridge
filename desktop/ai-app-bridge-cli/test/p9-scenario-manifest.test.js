'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/p9-scenario-manifests.json'), 'utf8'),
);

test('P9 manifests cover four apps and reject login/Moodle', () => {
  assert.equal(manifest.login, false);
  assert.equal(manifest.moodle, false);
  assert.equal(manifest.frozen, false);
  assert.deepEqual(manifest.apps.map((app) => app.id), [
    'localsend-flutter',
    'wikipedia-android',
    'vlc-android',
    'organic-maps-android',
  ]);
  assert.deepEqual(manifest.apps.map((app) => app.packageName), [
    'org.localsend.localsend_app.debug',
    'org.wikipedia.dev',
    'org.videolan.vlc.bridge_sample.debug',
    'app.organicmaps.web',
  ]);
});

test('P9 core and acceptance scenarios are versioned and not empty', () => {
  for (const app of manifest.apps) {
    const core = manifest.scenarios[app.coreId];
    const acceptance = manifest.scenarios[app.acceptanceId];
    assert.equal(core.kind, 'core');
    assert.equal(acceptance.kind, 'acceptance');
    assert.equal(core.maxMs, 300000);
    assert.equal(acceptance.maxMs, 600000);
    assert.equal(core.steps.length >= 4, true, app.coreId);
    assert.equal(acceptance.steps.length >= 4, true, app.acceptanceId);
    assert.equal(core.steps.every((step) => step.id && step.expectPage && Array.isArray(step.evidence)), true);
    assert.equal(acceptance.includes, app.coreId);
  }
});
