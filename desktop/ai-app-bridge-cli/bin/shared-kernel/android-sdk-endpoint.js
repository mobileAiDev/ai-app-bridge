'use strict';

const { CommandError } = require('../command-errors');

const schema = 'ai-app-bridge.android-endpoint.v1';
const endpointPath = 'files/ai_app_bridge_endpoint.json';
const epochPattern = /^[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseAndroidSdkEndpoint(text, packageName) {
  const invalid = reason => new CommandError('bridge_endpoint_invalid', `Invalid SDK endpoint for ${packageName}: ${reason}.`, { field: 'endpoint' });
  let endpoint;
  try { endpoint = JSON.parse(text); }
  catch (_) { throw invalid('expected JSON'); }
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)
    || endpoint.schema !== schema) throw invalid(`expected schema ${schema}`);
  if (endpoint.packageName !== packageName) throw new CommandError('bridge_package_mismatch',
    `SDK endpoint package mismatch: expected ${packageName}, got ${endpoint.packageName}.`, { field: 'packageName' });
  if (endpoint.transport !== 'localabstract') throw invalid('transport must be localabstract');
  if (typeof endpoint.runtimeEpoch !== 'string' || !epochPattern.test(endpoint.runtimeEpoch)
    || endpoint.socketName !== `aab-sdk-${endpoint.runtimeEpoch}`) throw invalid('socket name must match runtimeEpoch');
  if (typeof endpoint.version !== 'string' || !endpoint.version
    || !Number.isSafeInteger(endpoint.updatedAtMs) || endpoint.updatedAtMs <= 0) throw invalid('missing version or update time');
  if (endpoint.ok === false) throw new CommandError('bridge_not_ready',
    `SDK endpoint for ${packageName} is not ready: ${endpoint.error}.`, { field: 'endpoint' });
  if (endpoint.ok !== true) throw invalid('ok must be a boolean');
  return endpoint;
}

async function discoverAndroidSdkEndpoint(ctx, adb) {
  if (!ctx.packageName) throw new CommandError('target_required', 'SDK commands require packageName.', { field: 'packageName' });
  let text;
  try { text = (await adb(ctx, ['shell', 'run-as', ctx.packageName, 'cat', endpointPath])).stdout; }
  catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError('bridge_endpoint_discovery_failed',
      `Cannot read ${endpointPath} for ${ctx.packageName}. Install and launch a debuggable build with the current Android SDK.`,
      { field: 'packageName', details: { cause: String(error.message).split(/\r?\n/)[0] } });
  }
  return parseAndroidSdkEndpoint(text, ctx.packageName);
}

module.exports = { schema, endpointPath, parseAndroidSdkEndpoint, discoverAndroidSdkEndpoint };
