'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { validateCommandArguments, commandContract, isAndroidMutation } = require('../bin/command-registry');
const { bindCommandTarget } = require('../bin/shared-kernel/execution-target');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const { prepareAndroid, prepareFlutter, withProject, productionVersions, sdkReleaseVersion } = require('../bin/executors/preparation');

function preparationWithVersions(version, sdkReleaseVersion) {
  const filename = require.resolve('../bin/executors/preparation');
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = isolated.require.bind(isolated);
  isolated.require = name => name === '../../package.json'
    ? { ...require('../package.json'), version, sdkReleaseVersion } : originalRequire(name);
  isolated._compile(fs.readFileSync(filename, 'utf8'), filename);
  return isolated.exports;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-prepare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, "existing app's project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'gradlew'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(project, 'business.txt'), 'original business source');
  return { project: fs.realpathSync(project), home: path.join(directory, 'executor-home') };
}

test('preparation has one strict Host contract for all four platforms', () => {
  const cases = [{ platform: 'android', projectDir: '/project', module: ':app', variant: 'sitDebug', adapters: ['espresso-web'] },
    { platform: 'flutter', projectDir: '/project', mainArguments: [] }, { platform: 'ios' }, { platform: 'web', browser: 'webkit' }];
  for (const args of cases) {
    assert.doesNotThrow(() => validateCommandArguments('executor-prepare', args));
    assert.equal(isAndroidMutation('executor-prepare', args), false);
    assert.throws(() => validateCommandArguments('executor-prepare', { ...args, serial: 'must-not-touch-device' }));
  }
  assert.throws(() => validateCommandArguments('executor-prepare', { platform: 'android', projectDir: '/project', module: ':app' }));
  assert.throws(() => validateCommandArguments('executor-prepare', { platform: 'ios', projectDir: '/ignored' }));
  assert.throws(() => validateCommandArguments('executor-prepare', { platform: 'flutter', projectDir: '/project', browser: 'chromium' }));
  assert.equal(commandContract('executor-prepare').platform, 'host');
  assert.equal(commandContract('executor-prepare').script.permission, 'app.test');
});

test('a Script can prepare another platform without acquiring its default phone', async () => {
  const target = { platform: 'ios', deviceId: 'phone', bundleId: 'existing.app' };
  assert.deepEqual(bindCommandTarget('executor-prepare', { platform: 'web' }, target), { target: null, args: { platform: 'web' } });
  const host = createScriptHostPort({ target, permissions: ['app.test'], executionId: 'prepare-script',
    mutationLease: { acquire() { throw new Error('must not acquire a phone'); } },
    actions: async (command, args) => { assert.equal(command, 'executor-prepare'); assert.equal(args.platform, 'web'); return { ok: true, available: true }; },
  });
  const result = await host.call('executor-prepare', { platform: 'web' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.available, true);
  assert.equal(result.execution.target, null);
});

test('Android preparation keeps Host identity independent from SDK coordinates and preserves the consumer variant', async t => {
  const { project, home } = fixture(t);
  const preparation = preparationWithVersions('0.4.8', '0.4.7');
  let calls = 0;
  let generatedConfig;
  const run = async (file, args, options) => {
    calls++;
    assert.equal(file, 'sh');
    assert.equal(args[0], path.join(project, 'gradlew'));
    assert.equal(options.cwd, project);
    assert.ok(args.includes(':app:aiAppBridgePrepareExecutor'));
    const config = JSON.parse(fs.readFileSync(args.find(arg => arg.startsWith('-Daab.prepare.config=')).split('=').slice(1).join('=')));
    generatedConfig = config;
    assert.equal(config.requirements.minCompileSdk, 35);
    fs.writeFileSync(path.join(config.directory, 'android-preflight.json'), JSON.stringify({ status: 'compatible', module: ':app', variant: 'sitDebug' }));
    const application = path.join(config.directory, 'original-app.apk'), tests = path.join(config.directory, 'original-app-test.apk');
    fs.writeFileSync(application, 'original app'); fs.writeFileSync(tests, 'instrumentation');
    fs.writeFileSync(path.join(config.directory, 'android-build.json'), JSON.stringify({ schemaVersion: 'aab.android-prepared-build/v1',
      module: ':app', variant: 'sitDebug', packageName: 'original.app.sit', testPackageName: 'original.app.sit.test', runner: 'custom.ExistingRunner',
      applicationApks: [application], testApks: [tests] }));
    return { stdout: 'BUILD SUCCESSFUL', stderr: '' };
  };
  const result = await preparation.prepareAndroid({ projectDir: project, module: ':app', variant: 'sitDebug', adapters: ['espresso-web', 'compose'] }, { run, home });
  assert.equal(calls, 1);
  assert.equal(generatedConfig.pluginCoordinate, 'com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-gradle-plugin:0.4.7');
  assert.deepEqual(generatedConfig.dependencies, [
    'com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-test-instrumentation:0.4.7',
    'com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-test-espresso-web:0.4.7',
    'com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-test-compose:0.4.7',
    'androidx.compose.ui:ui-test-junit4:1.8.3',
  ]);
  assert.equal(result.bridgeVersion, '0.4.8');
  assert.equal(result.sdkReleaseVersion, '0.4.7');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.directory, 'result.json'))), result);
  assert.equal(result.packageName, 'original.app.sit');
  assert.equal(result.instrumentation, 'original.app.sit.test/custom.ExistingRunner');
  assert.deepEqual(result.projectFilesEdited, []);
  assert.match(result.applicationApks[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(project, 'business.txt'), 'utf8'), 'original business source');
  assert.deepEqual(fs.readdirSync(project).sort(), ['build', 'business.txt', 'gradlew']);
});

test('a failed or cancelled prepare retains its log and releases the project lock', async t => {
  const { project, home } = fixture(t);
  let released;
  const first = withProject(project, async () => new Promise(resolve => { released = resolve; }), { home });
  await assert.rejects(withProject(project, async () => assert.fail('concurrent preparation ran'), { home }), { code: 'executor_preparing' });
  released({ prepared: true }); await first;
  const { DatabaseSync } = require('node:sqlite');
  const lockFiles = fs.readdirSync(path.join(home, 'preparation-locks'));
  assert.equal(lockFiles.length, 1);
  const reader = new DatabaseSync(path.join(home, 'preparation-locks', lockFiles[0]));
  try {
    reader.exec('BEGIN; SELECT * FROM sqlite_schema');
    assert.equal((await withProject(project, async () => ({ prepared: true }), { home })).prepared, true);
  } finally { reader.close(); }
  await assert.rejects(prepareAndroid({ projectDir: project, module: ':app', variant: 'debug' }, { home,
    run: async () => { throw Object.assign(new Error('original compiler failure'), { stdout: 'COMPILER EVIDENCE', stderr: '', code: 1 }); } }),
  error => {
    assert.equal(error.code, 'executor_prepare_build_failed');
    assert.match(fs.readFileSync(path.join(error.details.directory, 'gradle-build.log'), 'utf8'), /COMPILER EVIDENCE/);
    assert.equal(JSON.parse(fs.readFileSync(error.details.resultFile)).ok, false);
    return true;
  });
  assert.equal((await withProject(project, async () => ({ prepared: true }), { home })).prepared, true);
});

test('Android preflight exposes compileSdk conflicts before build and retains actual/required values', async t => {
  const { project, home } = fixture(t);
  for (const adapters of [[], ['compose']]) {
    await assert.rejects(prepareAndroid({ projectDir: project, module: ':app', variant: 'debug', adapters }, { home,
      run: async (_file, args) => {
        const config = JSON.parse(fs.readFileSync(args.find(arg => arg.startsWith('-Daab.prepare.config=')).slice('-Daab.prepare.config='.length)));
        assert.equal(config.requirements.minCompileSdk, adapters.length ? 35 : 34);
        const preflight = { module: ':app', variant: 'debug', status: 'incompatible', actual: { compileSdk: 33 },
          requirements: config.requirements, issues: ['compileSdk 33 < required ' + config.requirements.minCompileSdk] };
        fs.writeFileSync(path.join(config.directory, 'android-preflight.json'), JSON.stringify(preflight));
        throw Object.assign(new Error('configuration failed'), { stdout: 'preflight only, no compilation', stderr: '', code: 1 });
      } }), error => {
      assert.equal(error.code, 'executor_prepare_incompatible');
      assert.equal(error.details.preflight.actual.compileSdk, 33);
      assert.equal(error.details.preflight.requirements.minCompileSdk, adapters.length ? 35 : 34);
      assert.match(error.message, /No project configuration was upgraded/);
      assert.equal(fs.readFileSync(path.join(project, 'business.txt'), 'utf8'), 'original business source');
      return true;
    });
  }
});

test('Flutter dependency comparison traverses business dependencies across workspace roots, excluding dev-only packages', () => {
  const graph = { packages: [
    { name: 'app', version: '1', kind: 'root', directDependencies: ['business'], devDependencies: ['tests'] },
    { name: 'another_app', version: '1', kind: 'root', directDependencies: ['storage'], devDependencies: [] },
    { name: 'business', version: '2', kind: 'direct', directDependencies: ['storage'] },
    { name: 'storage', version: '3', kind: 'transitive', directDependencies: [] },
    { name: 'tests', version: '4', kind: 'dev', directDependencies: [] },
  ] };
  assert.deepEqual([...productionVersions(graph)], [['business', '2'], ['storage', '3']]);
});

function flutterFixture(t, mode, helperVersion = sdkReleaseVersion) {
  const { project, home } = fixture(t);
  fs.mkdirSync(path.join(project, 'lib'));
  fs.writeFileSync(path.join(project, 'lib/main.dart'), 'void main(List<String> args) {}');
  const pubspec = path.join(project, 'pubspec.yaml'), lock = path.join(project, 'pubspec.lock');
  fs.writeFileSync(pubspec, 'original manifest'); fs.writeFileSync(lock, 'original lock');
  fs.mkdirSync(path.join(project, '.dart_tool'));
  const helper = { name: 'ai_app_bridge_test', version: helperVersion, source: 'hosted', kind: 'dev', directDependencies: [] };
  const graph = { packages: [{ name: 'app', version: '1.0.0', kind: 'root', directDependencies: ['business'], devDependencies: [] },
    { name: 'business', version: '2.0.0', source: 'hosted', directDependencies: [] }, ...(mode === 'reuse' ? [helper] : [])] };
  const config = () => fs.writeFileSync(path.join(project, '.dart_tool/package_config.json'), JSON.stringify({
    packages: graph.packages.filter(p => p.name === helper.name).map(p => ({ name: p.name, rootUri: '../helper/' })) }));
  config();
  const calls = [];
  const run = async (_file, args) => {
    calls.push(args);
    let stdout = '';
    if (args[0] === '--version') stdout = JSON.stringify({ frameworkVersion: '3.41.9' });
    else if (args[0] === 'pub' && args[1] === 'get') assert.ok(args.includes('--enforce-lockfile'));
    else if (args[1] === 'deps') stdout = JSON.stringify(graph);
    else if (args[1] === 'add') {
      assert.notEqual(mode, 'reuse', 'Repeated preparation must reuse the resolved helper');
      fs.writeFileSync(pubspec, 'manifest with helper'); fs.writeFileSync(lock, 'changed lock');
      graph.packages.push(helper); config();
      if (mode === 'partial-failure') throw new Error('Pub failed after changing metadata');
      if (mode === 'conflict') graph.packages[1].version = '3.0.0';
    } else if (args[0] === 'build') {
      assert.ok(['reuse', 'add'].includes(mode), 'A dependency failure must never build the App');
      const apk = path.join(project, 'build/app/outputs/flutter-apk/app-debug.apk');
      fs.mkdirSync(path.dirname(apk), { recursive: true }); fs.writeFileSync(apk, 'original App test build');
    } else assert.fail(JSON.stringify(args));
    return { stdout, stderr: '' };
  };
  return { project, home, pubspec, lock, calls, run };
}

for (const mode of ['conflict', 'partial-failure']) test(`Flutter ${mode} restores consumer pubspec and lock before returning failure`, async t => {
  const f = flutterFixture(t, mode);
  await assert.rejects(prepareFlutter({ projectDir: f.project }, f), {
    code: mode === 'conflict' ? 'executor_flutter_dependency_conflict' : 'executor_prepare_build_failed' });
  assert.equal(fs.readFileSync(f.pubspec, 'utf8'), 'original manifest');
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'original lock');
  assert.ok(f.calls.some(args => args.includes('--offline')));
  assert.equal(f.calls.some(args => args[0] === 'build'), false);
});

test('Flutter preparation adds the declared SDK helper without changing Host identity', async t => {
  const f = flutterFixture(t, 'add', '0.4.7');
  const preparation = preparationWithVersions('0.4.8', '0.4.7');
  const result = await preparation.prepareFlutter({ projectDir: f.project }, f);
  assert.deepEqual(f.calls.find(args => args[1] === 'add'), ['pub', 'add', 'dev:ai_app_bridge_test:0.4.7']);
  assert.equal(result.bridgeVersion, '0.4.8');
  assert.equal(result.sdkReleaseVersion, '0.4.7');
  assert.deepEqual(result.dependencySource, { hosted: 'pub.dev', version: '0.4.7' });
  assert.equal(result.reusedDependency, false);
  assert.ok(f.calls.some(args => args[0] === 'build' && args.includes('--no-pub')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.directory, 'result.json'))), result);
});

test('Flutter repeated preparation reuses the SDK helper across a Host-only release and keeps business main untouched', async t => {
  const f = flutterFixture(t, 'reuse', '0.4.7');
  const preparation = preparationWithVersions('0.4.8', '0.4.7');
  const result = await preparation.prepareFlutter({ projectDir: f.project, mainArguments: ['$literal', '中文'] }, f);
  assert.equal(result.reusedDependency, true);
  assert.equal(f.calls.some(args => args[1] === 'add'), false);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'original lock');
  assert.deepEqual(result.projectFilesEdited, []);
  assert.deepEqual(result.applicationDependencyVersionsChanged, []);
  assert.equal(fs.readFileSync(path.join(f.project, 'lib/main.dart'), 'utf8'), 'void main(List<String> args) {}');
  assert.match(fs.readFileSync(result.generatedEntrypoint, 'utf8'), /\\\$literal/);
});

test('Flutter rejects a helper resolved to the Host version and restores the original lock', async t => {
  const f = flutterFixture(t, 'mismatch', '0.4.8');
  const preparation = preparationWithVersions('0.4.8', '0.4.7');
  await assert.rejects(preparation.prepareFlutter({ projectDir: f.project }, f), error => {
    assert.equal(error.code, 'executor_flutter_dependency_mismatch');
    assert.match(error.message, /must resolve ai_app_bridge_test 0\.4\.7; received 0\.4\.8/);
    const result = JSON.parse(fs.readFileSync(error.details.resultFile));
    assert.equal(result.bridgeVersion, '0.4.8');
    assert.equal(result.sdkReleaseVersion, '0.4.7');
    return true;
  });
  assert.deepEqual(f.calls.find(args => args[1] === 'add'), ['pub', 'add', 'dev:ai_app_bridge_test:0.4.7']);
  assert.equal(fs.readFileSync(f.pubspec, 'utf8'), 'original manifest');
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'original lock');
  assert.ok(f.calls.some(args => args.includes('--offline') && args.includes('--enforce-lockfile')));
  assert.equal(f.calls.some(args => args[0] === 'build'), false);
});
