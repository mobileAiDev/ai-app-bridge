'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Installation must load its prebuild even when build tools fail. These are
// platform-specific command fixtures, not replacements for any device tool.
function createBuildToolDenial(directory, environment) {
  fs.mkdirSync(directory);
  const script = path.join(directory, 'deny.js');
  const attempts = path.join(directory, 'install-attempts.jsonl');
  const probe = path.join(directory, 'fixture-probe.jsonl');
  fs.writeFileSync(script, [
    "'use strict';",
    "require('node:fs').appendFileSync(process.env.AAB_BUILD_DENIAL_LOG, JSON.stringify({tool:process.argv[2],argv:process.argv.slice(3)})+'\\n');",
    'process.exit(127);',
  ].join('\n') + '\n');
  const tools = ['python', 'python3', 'py', 'cc', 'c++', 'clang', 'clang++',
    'gcc', 'g++', 'make', 'gmake', 'cmake', 'ninja', 'cl', 'msbuild', 'node-gyp'];
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const tool of tools) {
    const file = path.join(directory, tool + (process.platform === 'win32' ? '.cmd' : ''));
    fs.writeFileSync(file, process.platform === 'win32'
      ? '@echo off\r\n"%AAB_VALIDATION_NODE%" "%AAB_BUILD_DENIAL_SCRIPT%" "%~nx0"\r\nexit /b 127\r\n'
      : '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' ' + quote(tool) + '\n',
    { mode: 0o755 });
  }
  const env = { ...environment };
  // Windows environment names are case-insensitive; avoid two PATH entries.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const originalPath = env[pathKey] || '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  const executable = name => path.join(directory, name + (process.platform === 'win32' ? '.cmd' : ''));
  Object.assign(env, {
    PATH: directory + path.delimiter + originalPath,
    AAB_VALIDATION_NODE: process.execPath,
    AAB_BUILD_DENIAL_SCRIPT: script,
    AAB_BUILD_DENIAL_LOG: attempts,
    AI_APP_BRIDGE_PYTHON: executable('python3'),
    PYTHON: executable('python3'),
    npm_config_python: executable('python3'),
    npm_config_node_gyp: script,
    CC: executable('cc'),
    CXX: executable('c++'),
  });
  const invocation = process.platform === 'win32'
    ? [environment.ComSpec || environment.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', 'python3']]
    : [executable('python3'), []];
  const result = spawnSync(...invocation, { env: { ...env, AAB_BUILD_DENIAL_LOG: probe }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 127, JSON.stringify({ status: result.status, error: result.error?.message, stderr: result.stderr }));
  const tested = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.match(tested.tool, /^python3(?:\.cmd)?$/);
  return { env, attempts, probe, tools };
}

module.exports = { createBuildToolDenial };
