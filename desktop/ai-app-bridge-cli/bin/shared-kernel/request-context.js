'use strict';

const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

const requestDirectory = () => context.getStore()?.cwd ?? process.cwd();
const resolveRequestPath = value => path.resolve(requestDirectory(), value);
const inRequestDirectory = (cwd, action) => context.run({ cwd }, action);
const localPaths = ['outFile', 'artifactDir', 'apkPath', 'appPath', 'recordingDir', 'outputDir', 'archiveDir', 'wdaProjectPath', 'agentModule'];
const executables = ['adb', 'aaptPath', 'apksignerPath', 'devicectl', 'xcodebuild', 'pythonPath'];

// Only contract-defined filesystem fields are resolved. Web URL paths, source
// text and arbitrary Script inputs keep their original values.
function resolveExecutablePaths(args) {
  const resolved = { ...args };
  for (const field of executables) {
    if (typeof resolved[field] === 'string' && /[\\/]/.test(resolved[field])) resolved[field] = resolveRequestPath(resolved[field]);
  }
  return resolved;
}

function resolveCommandPaths(command, args) {
  const resolved = resolveExecutablePaths(args);
  for (const field of localPaths) {
    if (typeof resolved[field] === 'string') resolved[field] = resolveRequestPath(resolved[field]);
  }
  if (command === 'script' && args.operation === 'start') {
    resolved.script = { ...args.script, cwd: resolveRequestPath(args.script.cwd ?? requestDirectory()) };
    if (args.script.sourcePath !== undefined) resolved.script.sourcePath = resolveRequestPath(args.script.sourcePath);
  }
  return resolved;
}

module.exports = { requestDirectory, resolveRequestPath, inRequestDirectory, resolveCommandPaths, resolveExecutablePaths };
