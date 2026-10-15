'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') throw new Error('Windows acceptance must run on Windows. Mac protocol tests are not a substitute.');
const root = path.resolve(__dirname, '../..');
// Actual Win32 power/process calls plus shared execution, persistence and
// recovery contracts. Device fixture suites have their own acceptance scope.
const files = [
  'windows-runtime-contract.test.js', 'windows-process.integration.test.js',
  'windows-runtime.integration.test.js',
  'windows-command.integration.test.js', 'windows-power.integration.test.js',
  'durable-files.test.js', 'portable-exec-file.test.js',
  'script-module-loading.test.js', 'runtime-entrypoints.test.js',
  'script-production-recovery.test.js', 'script-recording-restart.test.js',
  'script-original-spec-recovery.test.js', 'device-ownership.test.js',
  'ownership-archives.test.js', 'executor-preparation.test.js',
  'fact-store.test.js', 'segmented-fact-store.test.js',
];
const result = spawnSync(process.execPath, ['--import', './test-support/ownership-test-sandbox.js',
  '--test', '--test-concurrency=2', ...files.map(file => path.join('test', file))], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
