'use strict';

const { object, integer, text, validateValue } = require('./argument-schema');
const { CommandError } = require('../command-errors');
const { checksumOf } = require('./evidence-schema');
const { resolveExecutablePaths } = require('./request-context');

const definitions = Object.freeze({
  android: { identity: ['serial', 'packageName'], connection: ['adb', 'port'] },
  ios: { identity: ['deviceId', 'bundleId'], connection: ['runtimeUrl', 'iosHost', 'iosPort', 'wdaUrl', 'wdaRunnerBundleId', 'wdaSessionId', 'webViewId', 'devicectl', 'xcodebuild'] },
  web: { identity: ['sessionId', 'runtimeEpoch'], connection: ['targetId'] },
});
const identityText = { ...text, maxLength: 1024, pattern: '^\\S+$' };
const identifier = { ...text, maxLength: 255, pattern: '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)*$' };
const allFields = new Set(Object.values(definitions).flatMap(value => [...value.identity, ...value.connection]));

function executionTargetSchema({ intent = false, nullable = false } = {}) {
  const branches = Object.entries(definitions).map(([platform, definition]) => {
    const properties = { platform: { const: platform } };
    for (const key of definition.identity) properties[key] = identityText;
    for (const key of definition.connection) properties[key] = text;
    if (platform === 'android') {
      properties.packageName = identifier;
      properties.port = integer(1, 65535);
      if (intent) properties.foregroundPackages = { type: 'array', items: identifier, maxItems: 32, uniqueItems: true };
    }
    if (platform === 'ios') properties.iosPort = integer(1, 65535);
    return object(properties, ['platform', ...definition.identity]);
  });
  return { anyOf: nullable ? [...branches, { type: 'null' }] : branches,
    description: 'Explicit platform and target identity. Connection options belong only to that platform.' };
}

function normalizeExecutionTarget(value, { intent = false, nullable = false } = {}) {
  validateValue(value, executionTargetSchema({ intent, nullable }), 'target');
  if (value === null) return null;
  if (value.platform === 'ios') {
    if (value.runtimeUrl !== undefined && (value.iosHost !== undefined || value.iosPort !== undefined)) {
      throw new CommandError('target_connection_conflict', 'runtimeUrl and iosHost/iosPort describe alternative runtime connections.', { field: 'target.runtimeUrl' });
    }
    for (const key of ['runtimeUrl', 'wdaUrl']) {
      if (value[key] === undefined) continue;
      let url;
      try { url = new URL(value[key]); } catch { /* rejected below */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw new CommandError('invalid_target_url', `${key} must be an HTTP(S) base URL without credentials, a query or fragment.`, { field: `target.${key}` });
      }
    }
  }
  const target = resolveExecutablePaths(structuredClone(value));
  if (target.foregroundPackages) Object.freeze(target.foregroundPackages);
  return Object.freeze(target);
}

function targetIdentity(target) {
  if (!target) return null;
  const definition = definitions[target.platform];
  if (!definition) throw new CommandError('invalid_target_platform', 'Target has no supported platform discriminator.', { field: 'target.platform' });
  // Web DOM targets share an SDK session but have distinct observation identity.
  const fields = target.platform === 'web' ? ['sessionId', 'runtimeEpoch', 'targetId'] : definition.identity;
  return `${target.platform}:${JSON.stringify(fields.map(key => target[key] ?? null))}`;
}

function targetFingerprint(target) {
  return target === null ? null : checksumOf(target);
}

function commandPlatform(command) {
  return command.startsWith('ios-') ? 'ios' : command.startsWith('web-') ? 'web' : 'android';
}

// A Script target supplies explicit defaults. A complete per-call identity can
// select another platform; a partial identity can override defaults only on the
// same platform. Never mix an Android serial with an iOS/Web connection.
function bindCommandTarget(command, args, defaultTarget = null, explicitTarget) {
  if (command === 'executor-prepare') {
    if (explicitTarget !== undefined) throw new CommandError('target_platform_mismatch', 'Executor preparation runs on the Host and accepts no device target.');
    return { target: null, args: { ...args } };
  }
  const platform = commandPlatform(command);
  const definition = definitions[platform];
  const selected = explicitTarget === undefined ? defaultTarget : normalizeExecutionTarget(explicitTarget);
  const fullIdentity = definition.identity.every(key => args[key] !== undefined);
  if (selected && selected.platform !== platform && !fullIdentity) {
    throw new CommandError('target_platform_mismatch', `${command} requires a complete ${platform} target.`, { field: 'target.platform' });
  }
  if (explicitTarget !== undefined && selected.platform !== platform) {
    throw new CommandError('target_platform_mismatch', `${command} does not execute on ${selected.platform}.`, { field: 'options.target.platform' });
  }
  const target = { ...(selected?.platform === platform ? selected : {}), platform };
  delete target.foregroundPackages;
  const schema = require('../command-registry').commandSchema(command);
  for (const key of allFields) {
    if (args[key] === undefined) continue;
    if (!definition.identity.includes(key) && !definition.connection.includes(key)) {
      // For example, Android CDP's targetId selects a WebView page. It is a
      // command argument, not the identity of a desktop Web execution target.
      if (schema.properties?.[key] !== undefined) continue;
      throw new CommandError('target_platform_mismatch', `${key} does not belong to a ${platform} target.`, { field: key });
    }
    if (explicitTarget !== undefined && target[key] !== undefined && target[key] !== args[key]) {
      throw new CommandError('target_argument_conflict', `Argument ${key} conflicts with options.target.`, { field: key });
    }
    target[key] = args[key];
  }
  const normalized = normalizeExecutionTarget(target);
  const bound = { ...args };
  const operationBranches = [...(schema.oneOf || []), ...(schema.anyOf || [])]
    .filter(branch => branch.properties?.operation?.const === args.operation && args.operation !== undefined);
  // Transport options may describe both SDK HTTP and WDA on the same iPhone;
  // each command receives only fields its public contract accepts.
  for (const [key, value] of Object.entries(normalized)) {
    if (key !== 'platform' && schema.properties?.[key] !== undefined
        && !operationBranches.some(branch => branch.properties?.[key] === false)) bound[key] = value;
  }
  return { target: normalized, args: bound };
}

module.exports = { executionTargetSchema, normalizeExecutionTarget, targetIdentity, targetFingerprint, commandPlatform, bindCommandTarget };
