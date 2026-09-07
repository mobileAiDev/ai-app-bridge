'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const localsend = require('./fixtures/p9-localsend-acceptance');
const organic = require('./fixtures/p9-organic-maps-acceptance');
const { scoreOrganicMapsStep } = require('./support/p9-acceptance-scorer');

const labels = {
  receive: 'Receive', send: 'Send', settings: 'Settings', about: 'About', aboutOpen: 'Open', back: 'Back',
  theme: 'Theme', themeRestore: 'System', language: 'Language', languageRestore: 'System',
  fileSelect: 'Files', noPeer: 'No peers', cancel: 'Close', themeLight: 'Light', themeDark: 'Dark',
  languageEnglish: 'English', languageRestoreEn: 'Use system', search: 'Search', poi: 'Monaco',
  noResultQuery: 'zzzz', noResult: 'No results', bookmark: 'Save', bookmarkDelete: 'Delete', bookmarkRestore: 'Restore',
  route: 'Route', routeDownloadLater: 'Later', routePreview: 'Frozen preview marker', menu: 'Menu',
  bookmarkList: 'Bookmarks', settingsRestore: '3D buildings',
};
const node = (text, attrs = '') => `<node text="${text}" content-desc="${text}" ${attrs}/>`;
const xml = (...nodes) => `<hierarchy>${nodes.join('')}</hierarchy>`;
const settingsXml = (restored) => xml(
  node('Settings Theme Language'), node('System', 'class="android.widget.Button" bounds="[0,0][100,100]"'),
  node(restored ? 'System' : 'English', 'class="android.widget.Button" bounds="[0,100][100,200]"'), node(labels.noPeer),
);

test('LocalSend evaluates a fresh settings tree after restore; unchanged titles cannot hide wrong values', async () => {
  for (const restoreWorks of [true, false]) {
    let restoreAttempted = false;
    const verdicts = [];
    const host = createScriptHostPort({ target: { serial: `localsend-${restoreWorks}` }, actions: async (command, args) => {
      if (command === 'tap-uia-text' && args.text === labels.languageRestoreEn) restoreAttempted = true;
      if (command === 'uia-tree') return { ok: true, result: settingsXml(!restoreAttempted || restoreWorks) };
      if (command === 'flutter-tree') return { ok: true, root: { text: labels.about } };
      if (command === 'screenshot') return { ok: true, path: '/tmp/current-localsend.png' };
      return { ok: true };
    } });
    await localsend.main({ ...host, inputs: { labels }, checkpoint: async () => {}, assert: async (assertion) => {
      const verdict = await host.assert(assertion); verdicts.push(verdict); return verdict;
    } });
    const restored = verdicts.find((item) => item.name === 'theme-language-restored');
    assert.equal(restored.verdict, restoreWorks ? 'passed' : 'failed');
  }
});

test('Organic Maps requires independent bookmark and switch states', () => {
  assert.equal(organic.bookmarkState(xml(node(labels.poi), node(labels.bookmark)), labels, 'saved'), false);
  assert.equal(organic.bookmarkState(xml(node(labels.poi), node(labels.bookmarkDelete)), labels, 'saved'), true);
  assert.equal(organic.bookmarkState(xml(node(labels.poi), node(labels.bookmarkDelete)), labels, 'deleted'), false);
  assert.equal(organic.bookmarkState(xml(node(labels.poi), node(labels.bookmarkRestore)), labels, 'deleted'), true);
  const preference = (checked) => xml(`<node>${node(labels.settingsRestore)}${node('', `checkable="true" checked="${checked}"`)}</node>`);
  assert.equal(organic.settingState(preference(true), labels.settingsRestore), true);
  assert.equal(organic.settingState(preference(false), labels.settingsRestore), false);
  assert.equal(organic.settingState(xml(node(labels.settingsRestore)), labels.settingsRestore), null);
});

function snapshot(items) {
  return { status: 'completed', eventSequence: items.length, history: { items, gap: false, hasMore: false, lastSequence: items.length } };
}
function assertionFact(name, kind = 'assertion_passed', extra = {}) {
  return { kind, payloadSummary: { name, scope: 'device', observationId: `issued:${name}`, refs: [{ stream: 'tree', hostObservationId: `issued:${name}` }], coverage: { status: 'complete', gap: false, committed: true }, ...extra } };
}

test('Organic Maps scoring never upgrades POI visibility, a tap receipt, or completed execution to bookmark/route success', () => {
  const old = snapshot([assertionFact('poi-visible'), { kind: 'call_completed', payloadSummary: { command: 'tap-uia-text', text: labels.bookmark } }]);
  for (const id of ['add-bookmark', 'route-preview-cancel', 'bookmark-delete-restore', 'settings-restore', 'unknown-step']) {
    assert.equal(scoreOrganicMapsStep(old, { id }).status, 'inconclusive');
  }
  assert.equal(scoreOrganicMapsStep(snapshot([assertionFact('bookmark-added', 'assertion_failed')]), { id: 'add-bookmark' }).status, 'failed');
  assert.equal(scoreOrganicMapsStep(snapshot([assertionFact('bookmark-added', 'assertion_passed', { scope: 'code' })]), { id: 'add-bookmark' }).status, 'inconclusive');
  assert.equal(scoreOrganicMapsStep(snapshot([assertionFact('bookmark-added', 'assertion_passed', { refs: [] })]), { id: 'add-bookmark' }).status, 'inconclusive');
  assert.equal(scoreOrganicMapsStep(snapshot([assertionFact('bookmark-added')]), { id: 'add-bookmark' }).status, 'passed');
});

test('Organic Maps cannot begin mutation with the old freeze missing a route-preview oracle', async () => {
  let calls = 0;
  await assert.rejects(organic.main({ inputs: { labels: { ...labels, routePreview: undefined } }, call: async () => { calls += 1; } }), /label_not_frozen:routePreview/);
  assert.equal(calls, 0);
});

test('Organic Maps full fixture distinguishes no-save, missing bookmark restore, and missing settings restore', async () => {
  for (const fault of [null, 'no-save', 'no-bookmark-restore', 'no-settings-restore', 'no-route-cancel']) {
    let page = 'map';
    let query = '';
    let bookmark = 'unsaved';
    let setting = false;
    let settingTaps = 0;
    const verdicts = [];
    const mapNodes = () => [node(labels.search), node(labels.menu), node(labels.bookmarkList)];
    const tree = () => {
      if (page === 'map') return xml(...mapNodes());
      if (page === 'settings') return xml(`<node>${node(labels.settingsRestore)}${node('', `checkable="true" checked="${setting}"`)}</node>`);
      if (page === 'route') return xml(...mapNodes(), node(labels.routePreview), node(labels.cancel));
      const nodes = [node('', 'class="android.widget.EditText" bounds="[0,0][100,100]"'),
        node(labels.poi, 'resource-id="app:id/title" bounds="[0,200][200,400]"'), node(labels.cancel)];
      if (query === labels.noResultQuery) nodes.push(node(labels.noResult));
      if (page === 'detail') nodes.push(node(labels.route), node(bookmark === 'saved' ? labels.bookmarkDelete : bookmark === 'deleted' ? labels.bookmarkRestore : labels.bookmark));
      return xml(...nodes);
    };
    const host = createScriptHostPort({ target: { serial: `maps-${fault}` }, actions: async (command, args) => {
      if (command === 'uia-tree') return { ok: true, result: tree() };
      if (command === 'screenshot') return { ok: true, path: '/tmp/maps-postcondition.png' };
      if (command === 'input-text') { query = args.text; page = 'search'; }
      if (command === 'tap' && args.tapY > 100) page = 'detail';
      if (command === 'tap-uia-text') {
        switch (args.text) {
          case labels.search: page = 'search'; break;
          case labels.bookmark: if (fault !== 'no-save') bookmark = 'saved'; break;
          case labels.bookmarkDelete: bookmark = 'deleted'; break;
          case labels.bookmarkRestore: if (fault !== 'no-bookmark-restore') bookmark = 'saved'; break;
          case labels.route: page = 'route'; break;
          case labels.cancel: if (!(page === 'route' && fault === 'no-route-cancel')) page = 'map'; break;
          case labels.settings: page = 'settings'; break;
          case labels.settingsRestore:
            settingTaps += 1;
            if (!(settingTaps === 2 && fault === 'no-settings-restore')) setting = !setting;
            break;
          case labels.back: page = 'map'; break;
          default: break;
        }
      }
      return { ok: true };
    } });
    await organic.main({ ...host, inputs: { labels }, checkpoint: async () => {}, assert: async (assertion) => {
      const verdict = await host.assert(assertion); verdicts.push(verdict); return verdict;
    } });
    const expected = { 'no-save': 'bookmark-added', 'no-bookmark-restore': 'bookmark-restored', 'no-settings-restore': 'settings-restored', 'no-route-cancel': 'route-cancelled' }[fault];
    if (expected) assert.equal(verdicts.find((item) => item.name === expected).verdict, 'failed', fault);
    else assert.equal(verdicts.every((item) => item.verdict === 'passed'), true);
  }
});
