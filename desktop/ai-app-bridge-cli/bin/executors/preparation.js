'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { object, text, integer } = require('../shared-kernel/argument-schema');
const { resolveRequestPath } = require('../shared-kernel/request-context');
const { execFileBounded } = require('../shared-kernel/execution-io');
const { executorHome, atomicJson, readJson, preparePackage } = require('./managed-runtime');
const bridgeVersion = require('../../package.json').version;
const testClass = 'io.github.mobileaidev.aiappbridge.generated.BridgeSessionTest';
const identifier = { ...text, maxLength: 4096 };
const common = { timeoutMs: integer(1, 1800000), requestId: identifier, feedback: { enum: ['auto', 'off', 'full'] } };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function preparationSchema() {
  const definitions = {
    android: { properties: { projectDir: identifier, module: { ...text, pattern: '^(:[A-Za-z0-9_-]+)+$' },
      variant: { ...text, pattern: '^[A-Za-z][A-Za-z0-9]*$' },
      adapters: { type: 'array', uniqueItems: true, maxItems: 2, items: { enum: ['espresso-web', 'compose'] } },
      repositoryUrl: identifier, gradlePath: identifier }, required: ['projectDir', 'module', 'variant'] },
    flutter: { properties: { projectDir: identifier, entrypoint: identifier, flutterPath: identifier,
      flavor: { ...text, pattern: '^[A-Za-z][A-Za-z0-9_]*$' }, testPackagePath: identifier,
      mainArguments: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 100 },
      dartDefines: { type: 'array', items: identifier, maxItems: 100 } }, required: ['projectDir'] },
    ios: { properties: { xcodebuild: identifier }, required: [] },
    web: { properties: { browser: { enum: ['chromium', 'firefox', 'webkit'] } }, required: [] },
  };
  const branches = Object.entries(definitions).map(([platform, definition]) =>
    object({ platform: { const: platform }, ...common, ...definition.properties }, ['platform', ...definition.required]));
  return { type: 'object', additionalProperties: false, required: ['platform'],
    properties: { ...Object.assign({}, ...branches.map(branch => branch.properties)), platform: { enum: Object.keys(definitions) } }, anyOf: branches };
}

function requireFile(file) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile())
    throw new CommandError('executor_prepare_file_missing', `Required project file is missing: ${file}`);
  return file;
}

function repository(value = 'https://jitpack.io') {
  const url = new URL(value);
  if (!['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new CommandError('invalid_argument', 'repositoryUrl must be an HTTPS or local file Maven repository without credentials, query or fragment.');
  return url.href;
}

async function withProject(projectDir, action, { home = executorHome() } = {}) {
  const project = fs.realpathSync(resolveRequestPath(projectDir));
  const locks = path.join(home, 'preparation-locks');
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const lock = new DatabaseSync(path.join(locks, `${digest(project)}.sqlite`));
  let locked = false;
  try {
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); locked = true; }
    catch (error) { if (error.errcode === 5) throw new CommandError('executor_preparing', 'This project is already being prepared.'); throw error; }
    const directory = path.join(project, 'build', 'ai-app-bridge', 'prepare', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const startedAtMs = Date.now();
    try {
      const result = { ok: true, bridgeVersion, directory, ...await action(project, directory), elapsedMs: Date.now() - startedAtMs };
      atomicJson(path.join(directory, 'result.json'), result);
      return result;
    } catch (error) {
      const result = { ok: false, bridgeVersion, directory, error: error.code || 'executor_prepare_failed',
        message: error.message, elapsedMs: Date.now() - startedAtMs };
      atomicJson(path.join(directory, 'result.json'), result);
      throw new CommandError(result.error, result.message, { details: { directory, resultFile: path.join(directory, 'result.json') } });
    }
  } finally { if (locked) lock.exec('ROLLBACK'); lock.close(); }
}

async function loggedRun(run, file, args, directory, name, options) {
  const logFile = path.join(directory, `${name}.log`);
  try {
    const result = await run(file, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(logFile, result.stdout + result.stderr, { mode: 0o600 });
    return result;
  } catch (error) {
    fs.writeFileSync(logFile, String(error.stdout || '') + String(error.stderr || '') + '\n' + error.message, { mode: 0o600 });
    throw new CommandError('executor_prepare_build_failed', `${name} failed. Read ${logFile}`, { details: { logFile, exitCode: error.code } });
  }
}

function androidEntry(adapters) {
  const compose = adapters.includes('compose');
  return `package io.github.mobileaidev.aiappbridge.generated;
public final class BridgeSessionTest extends io.github.mobileaidev.aiappbridge.executor.instrumentation.AndroidExecutorTest {
${compose ? '  @org.junit.Rule public final androidx.compose.ui.test.junit4.ComposeTestRule compose = androidx.compose.ui.test.junit4.AndroidComposeTestRule_androidKt.createEmptyComposeRule();' : ''}
  @Override protected java.util.Map<String, io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter> adapters() {
    java.util.Map<String, io.github.mobileaidev.aiappbridge.executor.ExecutorAdapter> adapters = super.adapters();
${adapters.includes('espresso-web') ? '    adapters.put("espresso-web", new io.github.mobileaidev.aiappbridge.executor.web.EspressoWebExecutor());' : ''}
${compose ? '    adapters.put("compose", new io.github.mobileaidev.aiappbridge.executor.compose.ComposeExecutor(compose));' : ''}
    return adapters;
  }
}
`;
}

async function prepareAndroid(args, { run = execFileBounded, home } = {}) {
  if (process.platform === 'win32') throw new CommandError('executor_host_unsupported', 'Android preparation currently supports macOS/Linux Gradle wrappers.');
  const repositoryUrl = repository(args.repositoryUrl);
  return withProject(args.projectDir, async (project, directory) => {
    const wrapper = requireFile(args.gradlePath ? resolveRequestPath(args.gradlePath) : path.join(project, 'gradlew'));
    const adapters = args.adapters ?? [];
    const javaFile = path.join(directory, 'java', ...testClass.split('.')) + '.java';
    fs.mkdirSync(path.dirname(javaFile), { recursive: true });
    fs.writeFileSync(javaFile, androidEntry(adapters));
    const coordinate = module => `com.github.mobileAiDev.ai-app-bridge:${module}:${bridgeVersion}`;
    const config = { directory, module: args.module, variant: args.variant, repositoryUrl,
      pluginCoordinate: coordinate('ai-app-bridge-gradle-plugin'),
      dependencies: [coordinate('ai-app-bridge-test-instrumentation'), ...adapters.map(adapter => coordinate(`ai-app-bridge-test-${adapter}`)),
        ...(adapters.includes('compose') ? ['androidx.compose.ui:ui-test-junit4:1.8.3'] : [])] };
    const configFile = path.join(directory, 'config.json');
    atomicJson(configFile, config);
    const template = path.resolve(__dirname, '../../runtime/executors/android/prepare.init.gradle');
    await loggedRun(run, 'sh', [wrapper, '--init-script', template, `-Daab.prepare.config=${configFile}`,
      `${args.module}:aiAppBridgePrepareExecutor`, '--console=plain', '--no-configuration-cache', '--max-workers=2'],
    directory, 'gradle-build', { cwd: project, timeoutMs: args.timeoutMs ?? 600000 });
    const build = readJson(path.join(directory, 'android-build.json'));
    if (build?.schemaVersion !== 'aab.android-prepared-build/v1' || build.variant !== args.variant || build.module !== args.module
      || !build.packageName || !build.testPackageName || !build.runner || !build.applicationApks?.length || !build.testApks?.length)
      throw new CommandError('executor_prepare_artifact_missing', 'The requested application/test variant did not produce complete build metadata.');
    const artifacts = files => files.map(file => ({ path: requireFile(file), sha256: digest(fs.readFileSync(file)) }));
    return { platform: 'android', engine: 'android-instrumentation', ...build, testClass,
      instrumentation: `${build.testPackageName}/${build.runner}`, repositoryUrl,
      adapters: ['uiautomator', 'espresso', ...adapters], applicationApks: artifacts(build.applicationApks), testApks: artifacts(build.testApks),
      lifecycle: 'built-not-installed', projectFilesEdited: [],
      next: 'Install the matching application and test APKs, then android-executor open with the returned component and class plus the actual launcher Activity.' };
  }, { home });
}

async function prepareFlutter(args, { run = execFileBounded, home } = {}) {
  return withProject(args.projectDir, async (project, directory) => {
    const flutter = args.flutterPath ?? 'flutter';
    const entrypoint = requireFile(path.resolve(project, args.entrypoint ?? 'lib/main.dart'));
    const pubspec = requireFile(path.join(project, 'pubspec.yaml'));
    const original = fs.readFileSync(pubspec);
    const defines = args.dartDefines ?? [];
    if (defines.some(value => value.split('=')[0] === 'INTEGRATION_TEST_SHOULD_REPORT_RESULTS_TO_NATIVE'))
      throw new CommandError('invalid_argument', 'The Bridge test entrypoint owns INTEGRATION_TEST_SHOULD_REPORT_RESULTS_TO_NATIVE.');
    const probe = await loggedRun(run, flutter, ['--version', '--machine'], directory, 'flutter-version', { cwd: project, timeoutMs: 30000 });
    const sdk = JSON.parse(probe.stdout);
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(sdk.frameworkVersion);
    if (!version || Number(version[1]) !== 3 || Number(version[2]) < 41)
      throw new CommandError('executor_flutter_sdk_unsupported', `Flutter ${sdk.frameworkVersion} is outside the supported stable Flutter 3.41+ profile.`);
    // Establish the baseline from the existing lock, even on a clean computer.
    // A normal pub get could silently change versions before our comparison.
    await loggedRun(run, flutter, ['pub', 'get', '--enforce-lockfile'], directory, 'flutter-pub-get', { cwd: project, timeoutMs: args.timeoutMs ?? 600000 });
    const beforeGraph = JSON.parse((await loggedRun(run, flutter, ['pub', 'deps', '--json'], directory, 'flutter-deps-before', { cwd: project, timeoutMs: 30000 })).stdout);
    if (productionVersions(beforeGraph).has('ai_app_bridge_test'))
      throw new CommandError('executor_flutter_dependency_scope', 'ai_app_bridge_test must be a dev_dependency; move the existing production dependency before preparing.');
    let packageRoot = project;
    while (!fs.existsSync(path.join(packageRoot, '.dart_tool/package_config.json'))) {
      const parent = path.dirname(packageRoot);
      if (parent === packageRoot) throw new CommandError('executor_flutter_dependency_missing', 'Pub did not create a package configuration.');
      packageRoot = parent;
    }
    const lockFile = requireFile(path.join(packageRoot, 'pubspec.lock'));
    const originalLock = fs.readFileSync(lockFile);
    const packageConfig = path.join(packageRoot, '.dart_tool/package_config.json');
    const beforeHelper = JSON.parse(fs.readFileSync(packageConfig)).packages.find(item => item.name === 'ai_app_bridge_test');
    const beforeDependency = beforeGraph.packages.find(item => item.name === 'ai_app_bridge_test');
    const matchingSource = beforeHelper && (args.testPackagePath
      ? fs.realpathSync(fileURLToPath(new URL(beforeHelper.rootUri, pathToFileURL(packageConfig)))) === fs.realpathSync(resolveRequestPath(args.testPackagePath))
      : beforeDependency?.source === 'hosted');
    const dependency = args.testPackagePath
      ? `dev:ai_app_bridge_test:${JSON.stringify({ path: fs.realpathSync(resolveRequestPath(args.testPackagePath)) })}`
      : `dev:ai_app_bridge_test:${bridgeVersion}`;
    const reusedDependency = matchingSource && beforeDependency.version === bridgeVersion;
    try {
      if (!reusedDependency) await loggedRun(run, flutter, ['pub', 'add', dependency], directory, 'flutter-dependencies', { cwd: project, timeoutMs: args.timeoutMs ?? 600000 });
      const afterGraph = JSON.parse((await loggedRun(run, flutter, ['pub', 'deps', '--json'], directory, 'flutter-deps-after', { cwd: project, timeoutMs: 30000 })).stdout);
      const afterVersions = new Map(afterGraph.packages.map(item => [item.name, item.version]));
      const changes = [...productionVersions(beforeGraph)].filter(([name, version]) => afterVersions.get(name) !== version)
        .map(([name, before]) => ({ name, before, after: afterVersions.get(name) ?? null }));
      if (changes.length) {
        atomicJson(path.join(directory, 'dependency-conflicts.json'), changes);
        throw new CommandError('executor_flutter_dependency_conflict', 'The test helper would change existing application dependencies; its pubspec/lock changes were reverted. See dependency-conflicts.json.');
      }
      const packages = JSON.parse(fs.readFileSync(path.join(packageRoot, '.dart_tool/package_config.json')));
      const helper = packages.packages.find(item => item.name === 'ai_app_bridge_test');
      if (!helper || afterVersions.get('ai_app_bridge_test') !== bridgeVersion)
        throw new CommandError('executor_flutter_dependency_mismatch', `Pub must resolve ai_app_bridge_test ${bridgeVersion}; received ${afterVersions.get('ai_app_bridge_test')}.`);
    } catch (error) {
      if (!original.equals(fs.readFileSync(pubspec)) || !originalLock.equals(fs.readFileSync(lockFile))) {
        fs.writeFileSync(pubspec, original);
        fs.writeFileSync(lockFile, originalLock);
        try {
          await loggedRun(run, flutter, ['pub', 'get', '--offline', '--enforce-lockfile'], directory, 'flutter-restore-dependencies', { cwd: project, timeoutMs: 60000 });
        } catch (restoreError) {
          throw new CommandError('executor_flutter_dependency_restore_failed', `Pubspec and lock were restored, but Pub metadata restoration failed after ${error.code || error.message}. ${restoreError.message}`);
        }
      }
      throw error;
    }
    const generated = path.join(directory, 'bridge_test.dart');
    const launch = args.mainArguments === undefined ? 'app.main' : `() => app.main(<String>${JSON.stringify(args.mainArguments).replaceAll('$', '\\$')})`;
    const importUri = pathToFileURL(entrypoint).href.replaceAll("'", '%27').replaceAll('$', '%24');
    fs.writeFileSync(generated, `import 'package:ai_app_bridge_test/ai_app_bridge_test.dart';\nimport '${importUri}' as app;\nvoid main() => aiAppBridgeTest(${launch});\n`);
    await loggedRun(run, flutter, ['build', 'apk', '--debug', '--no-pub', '--target', generated,
      '--dart-define=INTEGRATION_TEST_SHOULD_REPORT_RESULTS_TO_NATIVE=false',
      ...(args.flavor ? ['--flavor', args.flavor] : []), ...defines.map(value => `--dart-define=${value}`)],
    directory, 'flutter-build', { cwd: project, timeoutMs: args.timeoutMs ?? 600000 });
    const apk = requireFile(path.join(project, 'build/app/outputs/flutter-apk', `app-${args.flavor ? `${args.flavor}-` : ''}debug.apk`));
    return { platform: 'flutter', devicePlatform: 'android', engine: 'flutter-integration-test', flutter: sdk,
      projectDir: project, entrypoint, generatedEntrypoint: generated,
      reusedDependency: Boolean(reusedDependency),
      applicationApks: [{ path: apk, sha256: digest(fs.readFileSync(apk)) }], lifecycle: 'built-not-installed',
      dependencySource: args.testPackagePath ? { path: fs.realpathSync(resolveRequestPath(args.testPackagePath)) } : { hosted: 'pub.dev', version: bridgeVersion },
      projectFilesEdited: original.equals(fs.readFileSync(pubspec)) ? [] : ['pubspec.yaml'],
      applicationDependencyVersionsChanged: [],
      dependencyMetadata: ['pubspec.lock', '.dart_tool/package_config.json', '.flutter-plugins-dependencies'],
      next: 'Install this debug APK into the original application package, then flutter-executor open. Ordinary lib/main.dart builds do not start WidgetTester.' };
  }, { home });
}

function productionVersions(graph) {
  const packages = new Map(graph.packages.map(item => [item.name, item]));
  const versions = new Map();
  function visit(name) {
    if (versions.has(name)) return;
    const item = packages.get(name);
    if (!item) throw new CommandError('executor_flutter_dependency_graph_invalid', `Pub dependency is absent: ${name}`);
    versions.set(name, item.version);
    for (const child of item.directDependencies) visit(child);
  }
  for (const item of graph.packages.filter(item => item.kind === 'root')) for (const name of item.directDependencies) visit(name);
  return versions;
}

async function prepareExecutor(args, dependencies = {}) {
  if (args.platform === 'android') return prepareAndroid(args, dependencies);
  if (args.platform === 'flutter') return prepareFlutter(args, dependencies);
  if (args.platform === 'web') return { platform: 'web', bridgeVersion, ...await preparePackage(args.browser ?? 'chromium', dependencies) };
  if (args.platform === 'ios') {
    const { prepareManagedWda, wdaBuildEnvironment } = require('../ios-wda-project');
    const xcode = await (dependencies.run ?? execFileBounded)(args.xcodebuild ?? 'xcodebuild', ['-version'],
      { timeoutMs: 30000, env: wdaBuildEnvironment() });
    return { ...await prepareManagedWda(dependencies), xcode: xcode.stdout.trim() };
  }
  throw new CommandError('invalid_argument', 'Select android, flutter, ios or web.');
}

module.exports = { preparationSchema, prepareExecutor, prepareAndroid, prepareFlutter, androidEntry, withProject, loggedRun, testClass, bridgeVersion, productionVersions };
