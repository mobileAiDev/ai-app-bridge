'use strict';

const fs = require('node:fs');
const { requestDirectory, resolveRequestPath } = require('../shared-kernel/request-context');
const { checksumOf } = require('../shared-kernel/evidence-schema');
const { scriptError } = require('./script-errors');
const { DEFAULT_PERMISSIONS } = require('./script-catalog');
const { scriptPermissions } = require('../command-registry');
const { validateValue } = require('../shared-kernel/argument-schema');
const { scriptSpecSchema } = require('../shared-kernel/execution-contracts');
const { CommandError } = require('../command-errors');
const { normalizeExecutionTarget } = require('../shared-kernel/execution-target');

const SCHEMA = 'aab.code-script/v1';
const SCRIPT_SDK_VERSION = 'aab.script-sdk/v1';

function isCodeScript(input) {
  return Boolean(input && typeof input === 'object' && input.schemaVersion === SCHEMA);
}

function compileScriptSpec(input = {}) {
  if (!isCodeScript(input)) return scriptError('invalid_script', { field: 'schemaVersion' });
  try { validateValue(input, scriptSpecSchema(Object.keys(scriptPermissions))); }
  catch (error) {
    if (!(error instanceof CommandError)) throw error;
    return scriptError(error.code, { field: error.field, message: error.message,
      ...(error.details ? { details: error.details } : {}), dispatched: false, ambiguous: false });
  }
  let target;
  try { target = normalizeExecutionTarget(input.target ?? null, { nullable: true }); }
  catch (error) { return scriptError(error.code, { field: error.field, message: error.message, dispatched: false, ambiguous: false }); }
  const language = input.language;
  const hasPath = Object.hasOwn(input, 'sourcePath');
  let source = input.source;
  if (hasPath) {
    try {
      source = fs.readFileSync(input.sourcePath, 'utf8');
    } catch (error) {
      return scriptError('source_read_failed', { field: 'sourcePath', message: error.message });
    }
    if (!source) return scriptError('invalid_script', { field: 'sourcePath' });
  }
  const spec = {
    schemaVersion: SCHEMA,
    name: input.name ?? 'script',
    language,
    cwd: resolveRequestPath(input.cwd ?? requestDirectory()),
    source,
    sourcePath: hasPath ? input.sourcePath : null,
    entrypoint: input.entrypoint ?? 'main',
    target,
    inputs: structuredClone(input.inputs ?? {}),
    permissions: [...(input.permissions ?? DEFAULT_PERMISSIONS)],
    policy: {
      timeoutMs: input.policy?.timeoutMs ?? 600_000,
      restartPolicy: input.policy?.restartPolicy ?? 'none',
      maxOutputBytes: input.policy?.maxOutputBytes ?? 1_048_576,
      maxProgressBytes: input.policy?.maxProgressBytes ?? 1_048_576,
    },
  };
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
      cwd: spec.cwd,
      inputs: spec.inputs,
      policy: spec.policy,
      language: spec.language,
      entrypoint: spec.entrypoint,
      sdkVersion: SCRIPT_SDK_VERSION,
      target: spec.target,
      permissions: spec.permissions,
    });
}

module.exports = { SCHEMA, SCRIPT_SDK_VERSION, isCodeScript, compileScriptSpec, scriptHash };
