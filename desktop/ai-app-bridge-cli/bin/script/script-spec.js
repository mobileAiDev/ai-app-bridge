'use strict';

const fs = require('node:fs');
const { checksumOf } = require('../shared-kernel/evidence-schema');
const { scriptError } = require('./script-errors');
const { DEFAULT_PERMISSIONS } = require('./script-catalog');

const SCHEMA = 'aab.code-script/v1';
const SCRIPT_SDK_VERSION = 'aab.script-sdk/v1';
const LANGUAGES = { js: 'javascript', javascript: 'javascript', py: 'python', python: 'python' };

function isCodeScript(input) {
  return Boolean(input && typeof input === 'object' && input.schemaVersion === SCHEMA);
}

function compileScriptSpec(input = {}) {
  if (!isCodeScript(input)) return scriptError('invalid_script', { field: 'schemaVersion' });
  const language = LANGUAGES[String(input.language || '').toLowerCase()];
  if (!language) return scriptError('invalid_script', { field: 'language' });
  const hasSource = typeof input.source === 'string' && input.source.length > 0;
  const hasPath = typeof input.sourcePath === 'string' && input.sourcePath.length > 0;
  if (hasSource === hasPath) return scriptError('invalid_script', { field: 'source' });
  let source = hasSource ? input.source : null;
  if (hasPath) {
    try {
      source = fs.readFileSync(input.sourcePath, 'utf8');
    } catch {
      return scriptError('invalid_script', { field: 'sourcePath' });
    }
    if (!source) return scriptError('invalid_script', { field: 'sourcePath' });
  }
  const spec = {
    schemaVersion: SCHEMA,
    name: input.name || 'script',
    language,
    source,
    sourcePath: hasPath ? input.sourcePath : null,
    entrypoint: input.entrypoint || 'main',
    target: {
      serial: input.target?.serial || input.serial || null,
      packageName: input.target?.packageName || input.packageName || null,
    },
    inputs: input.inputs && typeof input.inputs === 'object' ? input.inputs : {},
    permissions: Array.isArray(input.permissions) ? input.permissions.slice() : DEFAULT_PERMISSIONS.slice(),
    policy: {
      timeoutMs: Number.isFinite(input.policy?.timeoutMs) ? input.policy.timeoutMs : 600_000,
      onFailure: input.policy?.onFailure || 'pause',
      restartPolicy: input.policy?.restartPolicy || 'none',
      maxOutputBytes: Number.isFinite(input.policy?.maxOutputBytes) ? input.policy.maxOutputBytes : 1_048_576,
      maxProgressBytes: Number.isFinite(input.policy?.maxProgressBytes) ? input.policy.maxProgressBytes : 1_048_576,
    },
  };
  if (!['none', 'checkpoint'].includes(spec.policy.restartPolicy)) {
    return scriptError('invalid_script', { field: 'restartPolicy' });
  }
  if (Buffer.byteLength(JSON.stringify(spec.inputs), 'utf8') > spec.policy.maxOutputBytes) {
    return scriptError('invalid_script', { field: 'inputs' });
  }
  return {
    ok: true,
    spec,
    hash: scriptHash(spec),
  };
}

function scriptHash(spec) {
  return checksumOf({
      source: spec.source,
      sourcePath: spec.sourcePath,
      inputs: spec.inputs,
      policy: spec.policy,
      language: spec.language,
      entrypoint: spec.entrypoint,
      sdkVersion: SCRIPT_SDK_VERSION,
    });
}

module.exports = { SCHEMA, SCRIPT_SDK_VERSION, isCodeScript, compileScriptSpec, scriptHash };
