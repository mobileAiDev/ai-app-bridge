'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = [
  'p7-g8-localsend.js',
  'p7-g8-localsend.py',
  'p9-localsend.js',
  'p9-localsend.py',
  'p9-localsend-acceptance.js',
  'p9-localsend-acceptance.py',
  'p9-wikipedia.js',
  'p9-wikipedia.py',
  'p9-wikipedia-acceptance.js',
  'p9-wikipedia-acceptance.py',
  'p9-vlc.js',
  'p9-vlc.py',
  'p9-vlc-acceptance.js',
  'p9-vlc-acceptance.py',
  'p9-organic-maps.js',
  'p9-organic-maps.py',
  'p9-organic-maps-acceptance.js',
  'p9-organic-maps-acceptance.py',
];

test('P9 script fixtures are JS/Python pairs on catalog commands', () => {
  for (const name of FIXTURES) {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
    assert.equal(/clear-app-data|install-apk|h5-eval|adb /.test(source), false, name);
    assert.equal(/explore|export-to-script|assemble-report/.test(source), false, name);
  }
  assert.equal(FIXTURES.filter((name) => name.endsWith('.js')).length, 9);
  assert.equal(FIXTURES.filter((name) => name.endsWith('.py')).length, 9);
  const localsend = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-localsend.js'), 'utf8');
  assert.equal(localsend.includes('ctx.inputs.labels'), true);
  assert.equal(localsend.includes('设置'), false);
  const omAcceptance = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-organic-maps-acceptance.js'), 'utf8');
  const omAcceptancePy = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-organic-maps-acceptance.py'), 'utf8');
  assert.equal(omAcceptance.includes('searchSubmit'), false);
  assert.equal(omAcceptancePy.includes('searchSubmit'), false);
  assert.equal(omAcceptance.includes("ctx.call('screenshot'"), true);
  const omCore = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-organic-maps.js'), 'utf8');
  assert.equal(omCore.includes("ctx.call('screenshot'"), true);
  const vlc = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-vlc.js'), 'utf8');
  const vlcPy = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-vlc.py'), 'utf8');
  const vlcAccept = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-vlc-acceptance.js'), 'utf8');
  assert.equal(vlc.includes('tapX: 540'), true);
  assert.equal(vlcPy.includes('"tapX": 540'), true);
  assert.equal(vlcAccept.includes('tapX: 972'), true);
  assert.equal(vlc.includes("callOk(ctx, 'screenshot'"), true);
  const wikiAccept = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-wikipedia-acceptance.js'), 'utf8');
  const wikiAcceptPy = fs.readFileSync(path.join(__dirname, 'fixtures', 'p9-wikipedia-acceptance.py'), 'utf8');
  assert.equal(wikiAccept.includes("tap-uia-text', { text: labels.back }"), true);
  assert.equal(wikiAccept.includes("requireActivity: 'SearchActivity'"), true);
  assert.equal(wikiAccept.includes("absentText: labels.switchedTitle"), true);
  assert.equal(wikiAccept.includes("requireActivity: 'PageActivity'"), true);
  assert.equal(wikiAccept.includes('compactHasText'), true);
  assert.equal(wikiAccept.includes("test collection p9-test is in the compact uia tree after opening the reading list"), true);
  assert.equal(wikiAcceptPy.includes("test collection p9-test is in the compact uia tree after opening the reading list"), true);
  assert.equal(wikiAcceptPy.includes('"tap-uia-text"'), true);
  assert.equal(wikiAcceptPy.includes('"requireActivity": "SearchActivity"'), true);
  assert.equal(wikiAcceptPy.includes('"absentText": labels["switchedTitle"]'), true);
  assert.equal(wikiAcceptPy.includes('"requireActivity": "PageActivity"'), true);
  assert.equal(wikiAcceptPy.includes('compact_has_text'), true);
  const launchThenTwoShots = /launch-app[\s\S]*screenshot[\s\S]*screenshot[\s\S]*openMoviesAndPlay/;
  assert.equal(launchThenTwoShots.test(vlc), true);
  const browseThenMovies = /tapX: 540, tapY: 2292[\s\S]*screenshot[\s\S]*tapX: 540, tapY: 780/;
  assert.equal(browseThenMovies.test(vlc), true);
  assert.equal(browseThenMovies.test(vlcAccept), true);
});
