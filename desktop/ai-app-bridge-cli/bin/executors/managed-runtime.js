'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { execFileBounded } = require('../shared-kernel/execution-io');

const executorHome = () => path.resolve(process.env.AI_APP_BRIDGE_EXECUTOR_HOME || path.join(os.homedir(), '.ai-app-bridge', 'executors'));

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function packageLocation(name = 'playwright', home = executorHome()) {
  if (name !== 'playwright') throw new CommandError('executor_unknown', 'Unknown managed executor.');
  const source = path.resolve(__dirname, '../../runtime/executors', name);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const lock = fs.readFileSync(path.join(source, 'package-lock.json'));
  const digest = createHash('sha256').update(JSON.stringify(manifest)).update(lock).digest('hex');
  const directory = path.join(home, 'packages', name, `${process.platform}-${process.arch}`, digest);
  return { name, source, directory, digest, version: manifest.dependencies.playwright,
    browsersPath: path.join(directory, 'browsers'), readyFile: path.join(directory, 'prepared.json') };
}

function packageStatus(browser = 'chromium', home = executorHome()) {
  const location = packageLocation('playwright', home);
  const ready = readJson(location.readyFile);
  const installed = readJson(path.join(location.directory, 'node_modules/playwright/package.json'));
  const matching = ready?.digest === location.digest && installed?.version === location.version;
  const executable = matching ? ready.browsers?.[browser] : null;
  return { ok: true, engine: 'playwright', version: location.version, browser,
    available: Boolean(executable && fs.existsSync(executable)),
    reason: executable && fs.existsSync(executable) ? null : 'executor_not_prepared',
    directory: location.directory, dependencyDigest: location.digest,
    ...(executable ? { executablePath: executable } : {}) };
}

async function preparePackage(browser = 'chromium', { home = executorHome(), run = execFileBounded } = {}) {
  if (!['chromium', 'firefox', 'webkit'].includes(browser)) throw new CommandError('invalid_argument', 'Unknown browser.', { field: 'browser' });
  const location = packageLocation('playwright', home);
  fs.mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const lock = new DatabaseSync(path.join(location.directory, 'prepare.sqlite'));
  let locked = false;
  const startedAtMs = Date.now();
  try {
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); locked = true; }
    catch (error) { if (error.errcode === 5) throw new CommandError('executor_preparing', 'This exact executor package is being prepared by another process.'); throw error; }
    const status = packageStatus(browser, home);
    if (status.available) return { ...status, reused: true, elapsedMs: Date.now() - startedAtMs };
    const old = readJson(location.readyFile);
    const installed = readJson(path.join(location.directory, 'node_modules/playwright/package.json'));
    if (old?.digest !== location.digest || installed?.version !== location.version) {
      for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(location.source, name), path.join(location.directory, name));
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: location.directory, timeoutMs: 300000, maxBuffer: 4 * 1024 * 1024 });
    }
    const environment = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: location.browsersPath };
    await run(process.execPath, [path.join(location.directory, 'node_modules/playwright/cli.js'), 'install', browser],
      { cwd: location.directory, env: environment, timeoutMs: 300000, maxBuffer: 4 * 1024 * 1024 });
    const probe = await run(process.execPath, ['-e', 'process.stdout.write(require("playwright")[process.argv[1]].executablePath())', browser],
      { cwd: location.directory, env: environment, timeoutMs: 10000 });
    const executable = probe.stdout.trim();
    if (!fs.existsSync(executable)) throw new CommandError('executor_browser_missing', 'Browser installation did not produce its declared executable.');
    atomicJson(location.readyFile, { schemaVersion: 'aab.executor-package/v1', digest: location.digest,
      version: location.version, preparedAtMs: Date.now(), browsers: { ...(old?.digest === location.digest ? old.browsers : {}), [browser]: executable } });
    return { ...packageStatus(browser, home), reused: false, elapsedMs: Date.now() - startedAtMs };
  } finally { if (locked) lock.exec('ROLLBACK'); lock.close(); }
}

module.exports = { executorHome, atomicJson, readJson, packageLocation, packageStatus, preparePackage };
