'use strict';

const { spawnSync } = require('node:child_process');
const { createChildRuntimeAdapter } = require('./node-runtime-adapter');

let cached = undefined;
let spawnFailureReprobed = false;

function inspectPython(opts = {}) {
  if (opts.resolvePython) return detectPython(opts.resolvePython, opts);
  if (opts.pythonPath || opts.env) return detectPython(undefined, opts);
  if (cached !== undefined) return cached;
  cached = detectPython(undefined, opts);
  return cached;
}

function resetPythonDetection() {
  cached = undefined;
  spawnFailureReprobed = false;
}

function pythonCandidates({ pythonPath, env = process.env } = {}) {
  const seen = new Set();
  const list = [];
  function add(value) {
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  }
  add(pythonPath);
  add(env.AI_APP_BRIDGE_PYTHON);
  add('python3');
  add('python');
  return list;
}

function probePython(executable, env) {
  const options = { encoding: 'utf8', shell: false };
  if (env) options.env = env;
  const probe = spawnSync(executable, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], options);
  if (probe.status !== 0 || !probe.stdout) {
    return { available: false, executable, error: 'runtime_unavailable' };
  }
  const parsed = parsePythonVersion(probe.stdout);
  if (!parsed) {
    return { available: false, executable, error: 'runtime_unavailable' };
  }
  if (parsed.major < 3 || (parsed.major === 3 && parsed.minor < 9)) {
    return { available: false, executable, version: parsed.version, error: 'python_too_old' };
  }
  return { available: true, executable, version: parsed.version };
}

function parsePythonVersion(stdout) {
  const version = String(stdout || '').trim();
  const match = /^(\d+)\.(\d+)\b/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), version };
}

function detectPython(resolvePython, opts = {}) {
  if (typeof resolvePython === 'function') {
    const executable = resolvePython();
    if (!executable) return { available: false, executable: null };
    return probePython(executable, opts.env);
  }
  let tooOld = null;
  for (const candidate of pythonCandidates(opts)) {
    const result = probePython(candidate, opts.env);
    if (result.available) return result;
    if (result.error === 'python_too_old' && !tooOld) tooOld = result;
  }
  return tooOld || { available: false, executable: null };
}

function resolvePythonExecutable(opts = {}) {
  return detectPython(undefined, opts).executable;
}

function createPythonRuntimeAdapter(opts = {}) {
  const resolved = inspectPython(opts);
  if (!resolved.available) {
    return {
      kind: 'python',
      unavailable: true,
      error: resolved.error || 'runtime_unavailable',
      async start() {
        return { ok: false, error: 'runtime_unavailable' };
      },
    };
  }
  return createChildRuntimeAdapter({
    kind: 'python',
    executable: resolved.executable,
    sdkFile: 'script-sdk.py',
    extension: '.py',
    onSpawnFailure() {
      if (spawnFailureReprobed) return;
      spawnFailureReprobed = true;
      cached = undefined;
    },
  });
}

module.exports = {
  createPythonRuntimeAdapter,
  inspectPython,
  resetPythonDetection,
  resolvePythonExecutable,
  detectPython,
};
