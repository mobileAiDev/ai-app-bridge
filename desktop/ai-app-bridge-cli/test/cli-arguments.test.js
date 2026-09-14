'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { parseArgs } = require('../bin/ai-app-bridge');
const cli = path.resolve(__dirname, '../bin/ai-app-bridge.js');

for (const flag of ['--version', '-V', 'version']) {
  test(`CLI ${flag} prints the installed package version without a device or Runtime`, () => {
    const result = spawnSync(process.execPath, [cli, flag], { encoding: 'utf8',
      env: { ...process.env, ADB: '/missing-version-test-adb' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), require('../package.json').version);
    assert.equal(result.stderr, '');
  });
}

test('CLI without arguments shows help without starting a device command', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Usage: ai-app-bridge/);
});

test('raw CLI preserves value tokens and the two repeatable launch fields', () => {
  assert.deepEqual(parseArgs(['launch-activity', '--serial', 'device',
    '--category', 'first', '--category', 'second', '--extra', 'one=1',
    '--extra', 'two=hello world', '--timeout-ms', '-1']), {
    command: 'launch-activity', options: { serial: 'device', category: ['first', 'second'],
      extra: ['one=1', 'two=hello world'], timeoutMs: '-1' },
  });
});

for (const argv of [['--help'], ['help'], ['--help', 'tap'], ['tap', '--help']]) {
  test(`CLI help is explicit and needs no device: ${argv.join(' ')}`, () => {
    const result = spawnSync(process.execPath, [cli, ...argv], {
      encoding: 'utf8', env: { ...process.env, ADB: '/missing-cli-test-adb' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, argv.includes('tap') ? /"tapX"/ : /Usage: ai-app-bridge/);
  });
}

const rejects = [
  { name: 'stray positional', args: ['unexpected-positional', '--operation', 'status'],
    error: 'unexpected_argument', field: 'argv[1]' },
  { name: 'duplicate operation cannot replace the rejected first value',
    args: ['--operation', 'invalid-operation', '--operation', 'status'],
    error: 'duplicate_argument', field: 'operation' },
  { name: 'duplicate serial cannot redirect the selected phone',
    args: ['--operation', 'status', '--serial', 'another-device'],
    error: 'duplicate_argument', field: 'serial' },
  { name: 'camel-case is not a second spelling of a canonical flag',
    args: ['--packageName', 'com.example.app'], error: 'invalid_argument', field: 'argv[1]' },
  { name: 'bare option terminator is not ignored', args: ['--'],
    error: 'invalid_argument', field: 'argv[1]' },
];
for (const item of rejects) {
  test(`raw CLI rejects ${item.name} before device access`, () => {
    const argv = ['device-ownership', ...item.args, '--serial', 'test-device'];
    const result = spawnSync(process.execPath, [cli, ...argv], {
      encoding: 'utf8', env: { ...process.env, ADB: '/missing-cli-test-adb' },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stderr, '', 'The public CLI must return one JSON error, not a parser stack trace.');
    const value = JSON.parse(result.stdout).value;
    assert.equal(value.ok, false);
    assert.equal(value.error, item.error);
    assert.equal(value.field, item.field);
    assert.equal(value.dispatched, false);
    assert.equal(value.ambiguous, false);
    assert(value.message.length > 0);
  });
}
