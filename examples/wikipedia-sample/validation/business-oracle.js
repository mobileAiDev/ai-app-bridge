'use strict';

// This oracle owns original-file reads at the Script's eight declared safe
// points. Its caller owns the Host, Script decisions, cancellation and archives.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const PACKAGE = 'org.wikipedia.dev.bridge_sample';
const STAGES = ['baseline', 'language-changed', 'language-restored', 'list-cancelled',
  'list-created', 'theme-light', 'theme-restored', 'final-restored'];
const BASE_PREFS = { colorTheme: 1, matchSystemTheme: true, languageApp: 'zh-cn,zh-tw' };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

// Reading recency and sync bookkeeping may change while reading an article.
// These are the business records that cancellation/cleanup must preserve.
function inventory(database) {
  const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
  return {
    lists: database.tables.ReadingList.map(row => pick(row, ['id', 'listTitle', 'description'])),
    pages: database.tables.ReadingListPage.map(row => pick(row,
      ['id', 'listId', 'wiki', 'namespace', 'apiTitle', 'lang', 'offline', 'status'])),
  };
}

function createBusinessOracle({ directory, serial, run, python, sources, sourceSha256, inputs, getOperationId }) {
  assert(['b46093e6', 'FYZLAU49X8OVQGJ7'].includes(serial), 'An explicitly authorized OPPO serial is required');
  assert.equal(inputs.serial, serial);
  assert(path.isAbsolute(directory));
  assert(/^[a-f0-9]{64}$/.test(sourceSha256), 'Frozen Script source hash required');
  const readerHashes = Object.fromEntries(['databaseReader', 'preferencesReader'].map(name => [name, hash(sources[name])]));
  const decisions = [];
  let baseline, operationId, lastActionSequence = 0;
  const adb = (args, options = {}) => execFileSync('adb', ['-s', serial, ...args],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024, ...options });

  async function snapshot(stage) {
    const output = path.join(directory, 'oracle-' + stage);
    fs.mkdirSync(output);
    const metadata = { serial, packageName: PACKAGE, operationId, stage, startedAtMs: Date.now() };
    assert.equal(adb(['get-state']).trim(), 'device');
    try {
      // freeze-app can stop some processes before returning a failure. Its
      // invocation must be inside the same finally that always attempts thaw.
      const frozen = await run('freeze-app', { serial, packageName: PACKAGE });
      assert.equal(frozen.ok, true);
      assert(frozen.pids.length > 0, 'An actual App process is required');
      const stopped = () => frozen.pids.map(pid => {
        const status = adb(['shell', 'run-as', PACKAGE, 'cat', '/proc/' + pid + '/status']);
        const processState = status.split('\n').find(line => line.startsWith('State:'));
        assert(/^State:\s+T\s/.test(processState), 'Every copied App process must be stopped');
        return { pid, state: processState };
      });
      metadata.before = stopped();
      const bytes = adb(['exec-out', 'run-as', PACKAGE, 'tar', '-cf', '-', 'databases'], { encoding: null });
      const archive = path.join(output, 'databases.tar');
      fs.writeFileSync(archive, bytes, { flag: 'wx' });
      metadata.archive = { path: archive, sha256: hash(archive), bytes: bytes.length };
      metadata.after = stopped();
      const preferences = JSON.parse(execFileSync(python, [sources.preferencesReader, serial],
        { encoding: 'utf8', timeout: 25000 }));
      assert.equal(preferences.serial, serial); assert.equal(preferences.packageName, PACKAGE);
      write(path.join(output, 'preferences.json'), preferences);
      metadata.preferences = preferences;
    } catch (error) {
      metadata.error = error.stack;
      throw error;
    } finally {
      try {
        const resumed = await run('thaw-app', { serial, packageName: PACKAGE });
        assert.equal(resumed.ok, true);
        metadata.resumed = true;
      } catch (error) {
        metadata.resumed = false; metadata.thawError = error.stack;
        throw error;
      } finally {
        metadata.finishedAtMs = Date.now();
        write(path.join(output, 'snapshot.json'), metadata);
      }
    }
    execFileSync(python, [sources.databaseReader, '--archive', metadata.archive.path,
      '--output', path.join(output, 'database')], { timeout: 25000 });
    const database = read(path.join(output, 'database', 'result.json'));
    assert.deepEqual(database.integrity, ['ok']); assert.equal(database.databaseVersion, 35);
    assert.equal(database.sourceSha256, metadata.archive.sha256);
    return { metadata, database, inventory: inventory(database) };
  }

  function assess(stage, actual) {
    const predicates = [];
    const check = (name, condition) => predicates.push({ name, passed: condition });
    const lists = actual.database.tables.ReadingList, pages = actual.database.tables.ReadingListPage;
    const expectedPrefs = stage === 'theme-light' ? { ...BASE_PREFS, colorTheme: 0, matchSystemTheme: false }
      : stage === 'language-changed' ? { ...BASE_PREFS, languageApp: 'zh-tw,zh-cn' } : BASE_PREFS;
    check('exact original business preferences', isDeepStrictEqual(actual.metadata.preferences.values, expectedPrefs));
    check('cancelled test collection absent', lists.every(row => row.listTitle !== inputs.cancelledListName));
    if (stage === 'baseline') {
      check('one original default collection', lists.length === 1 && lists[0].id === 1 && lists[0].listTitle === '');
      check('one saved default Moon article', pages.length === 1 && pages[0].id === 1 && pages[0].listId === 1
        && pages[0].wiki === 'zh.wikipedia.org' && pages[0].apiTitle === '月球' && pages[0].lang === 'zh-cn'
        && pages[0].status === 1 && pages[0].offline === 1);
      check('new test collection absent', lists.every(row => row.listTitle !== inputs.listName));
    } else if (stage === 'list-created') {
      const created = lists.filter(row => row.listTitle === inputs.listName);
      check('one new collection with exact description', created.length === 1 && created[0].description === inputs.listDescription);
      const listId = created.length === 1 ? created[0].id : null;
      const saved = pages.filter(row => row.listId === listId);
      check('real Moon record associated with new collection', saved.length === 1 && saved[0].apiTitle === '月球'
        && saved[0].wiki === 'zh.wikipedia.org' && saved[0].lang === 'zh-cn' && saved[0].status === 1);
      const original = { lists: actual.inventory.lists.filter(row => row.id !== listId),
        pages: actual.inventory.pages.filter(row => row.listId !== listId) };
      check('original collections and articles preserved', isDeepStrictEqual(original, baseline));
    } else {
      check('original collection and article inventory preserved', isDeepStrictEqual(actual.inventory, baseline));
    }
    return predicates;
  }

  async function answer(context) {
    const currentOperationId = getOperationId();
    assert(typeof currentOperationId === 'string' && currentOperationId.length > 0, 'Original Script operation required');
    if (operationId === undefined) operationId = currentOperationId;
    assert.equal(currentOperationId, operationId, 'Oracle belongs to another Script operation');
    assert.equal(context.kind, 'wikipedia.business-oracle/v1');
    assert.equal(context.stage, STAGES[decisions.length], 'Unexpected or repeated external business stage');
    assert.equal(context.serial, serial); assert.equal(context.packageName, PACKAGE);
    for (const key of ['listName', 'cancelledListName', 'listDescription']) assert.equal(context[key], inputs[key]);
    let actionSequence = 0;
    if (context.stage === 'baseline') assert.equal(context.lastActionId, null, 'Baseline must precede the first business action');
    else {
      const prefix = operationId + ':action-';
      assert(typeof context.lastActionId === 'string' && context.lastActionId.startsWith(prefix), 'Oracle action belongs to another execution');
      const suffix = context.lastActionId.slice(prefix.length);
      assert(/^[1-9][0-9]*$/.test(suffix), 'Original Script action identity required');
      actionSequence = Number(suffix);
      assert(Number.isSafeInteger(actionSequence) && actionSequence > lastActionSequence, 'Oracle action must advance with its stage');
      assert(baseline !== undefined, 'Passed original baseline required');
    }
    const actual = await snapshot(context.stage);
    const predicates = assess(context.stage, actual);
    const artifact = path.join(directory, 'oracle-' + context.stage, 'assessment.json');
    write(artifact, { operationId, sourceSha256, context,
      snapshot: actual.metadata, actualInventory: actual.inventory, predicates,
      evidenceScope: 'Independent original SQLite and SharedPreferences files; not a device ctx.assert observation' });
    const decision = { kind: 'wikipedia.business-oracle-result/v1', stage: context.stage,
      verdict: predicates.every(item => item.passed) ? 'passed' : 'failed',
      artifact: { path: artifact, sha256: hash(artifact) },
      verifiedPredicates: predicates.filter(item => item.passed).map(item => item.name) };
    if (context.stage === 'baseline' && decision.verdict === 'passed') baseline = actual.inventory;
    decisions.push(decision); lastActionSequence = actionSequence;
    console.log(JSON.stringify({ stage: context.stage, verdict: decision.verdict }));
    return decision;
  }

  function verifyComplete() {
    assert(baseline !== undefined, 'Passed original baseline required');
    assert.equal(getOperationId(), operationId, 'Oracle belongs to another Script operation');
    assert.equal(decisions.length, STAGES.length);
    for (const [index, decision] of decisions.entries()) {
      assert.equal(decision.stage, STAGES[index]); assert.equal(decision.verdict, 'passed');
      assert.equal(decision.artifact.path, path.join(directory, 'oracle-' + decision.stage, 'assessment.json'));
      assert.equal(hash(decision.artifact.path), decision.artifact.sha256, 'Independent assessment changed');
      const assessment = read(decision.artifact.path);
      assert.equal(assessment.operationId, operationId); assert.equal(assessment.sourceSha256, sourceSha256);
      assert.equal(assessment.context.stage, decision.stage); assert.equal(assessment.snapshot.resumed, true);
      const output = path.join(directory, 'oracle-' + decision.stage);
      assert.equal(assessment.snapshot.archive.path, path.join(output, 'databases.tar'));
      assert.equal(hash(assessment.snapshot.archive.path), assessment.snapshot.archive.sha256, 'Original database archive changed');
      assert.deepEqual(read(path.join(output, 'preferences.json')), assessment.snapshot.preferences, 'Original preference evidence changed');
      assert(assessment.predicates.length > 0 && assessment.predicates.every(item => item.passed === true));
      if (decision.stage === 'baseline' || decision.stage === 'final-restored')
        assert.deepEqual(assessment.actualInventory, baseline, 'Original inventory was not preserved');
    }
    for (const [name, expected] of Object.entries(readerHashes)) assert.equal(hash(sources[name]), expected, 'Copied reader changed: ' + name);
    return true;
  }

  return { answer, decisions, get baseline() { return baseline; }, verifyComplete };
}

module.exports = { createBusinessOracle, inventory };
