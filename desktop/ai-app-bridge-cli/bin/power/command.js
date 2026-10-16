'use strict';

const { object, text, integer } = require('../shared-kernel/argument-schema');
const { variants } = require('../shared-kernel/execution-contracts');
const { capabilities } = require('./platform-adapters');

function schema() {
  const leaseMs = { ...integer(1, 86400000), description: 'Explicit work duration in milliseconds. Platform assertions expire independently if the Host stops renewing.' };
  const target = variants('platform', [
    object({ platform: { const: 'host' } }, ['platform']),
    object({ platform: { const: 'android' }, serial: text, adb: text }, ['platform', 'serial']),
    object({ platform: { const: 'ios' }, deviceId: text, bundleId: text,
      runtimeUrl: text, iosHost: text, iosPort: integer(1, 65535), devicectl: text }, ['platform', 'deviceId', 'bundleId']),
  ]);
  const operation = (name, fields = {}, required = []) => object({ operation: { const: name }, ...fields }, ['operation', ...required]);
  return variants('operation', [
    operation('capabilities'),
    operation('auto', { enabled: { type: 'boolean' } }, ['enabled']),
    operation('acquire', { ownerId: { ...text, maxLength: 256 }, target, mode: { enum: ['system', 'display', 'both'] }, leaseMs,
      recovery: { enum: ['manual', 'reacquire-ended'], description: 'Default manual. For iOS, reacquire-ended restores only an SDK-confirmed missing assertion within the original work deadline; it never retries transport, foreground or identity errors.' } }, ['ownerId', 'target', 'mode', 'leaseMs']),
    operation('renew', { leaseId: text, leaseMs }, ['leaseId', 'leaseMs']),
    operation('release', { leaseId: text }, ['leaseId']),
    operation('status', { leaseId: text }),
  ]);
}

async function handle(args, manager, work) {
  if (args.operation === 'capabilities') return { ok: true, command: 'power', hostPlatform: process.platform, capabilities,
    message: 'Idle prevention is bounded and does not unlock a device. iOS coverage is limited to the selected SDK App while foreground.' };
  try {
    if (args.operation === 'auto') return { ok: true, command: 'power', automatic: await work.configure(args.enabled), settled: true, dispatched: true, ambiguous: false };
    const { operation, ...options } = args;
    const result = await manager[operation](options);
    const releaseUnconfirmed = operation === 'release' && result.release?.released !== true;
    const inactive = ['acquire', 'renew'].includes(operation) && result.state !== 'active';
    const failed = releaseUnconfirmed || inactive;
    const { error: leaseError, ...facts } = result;
    return { ok: !failed, command: 'power', operation, ...facts,
      ...(leaseError ? { leaseError } : {}),
      ...(failed ? { error: releaseUnconfirmed ? 'power_release_unconfirmed' : leaseError?.code || 'power_activity_inactive',
        message: releaseUnconfirmed ? 'The platform did not confirm release; inspect release and platformExpiresAtMs for its expiry bound.'
          : leaseError?.message || 'The requested work lease is not active.' } : {}),
      ...(operation === 'status' && work ? { automatic: work.status() } : {}),
      dispatched: operation !== 'status', ambiguous: failed && result.release?.released !== true, settled: !failed };
  } catch (error) {
    return { ok: false, command: 'power', operation: args.operation, error: error.code || 'power_failed', message: error.message,
      ...(error.details ? { details: error.details } : {}), ...(error.lease ? { lease: error.lease } : {}),
      dispatched: error.lease ? null : false, ambiguous: Boolean(error.lease && error.lease.release?.released !== true) };
  }
}

module.exports = { schema, handle };
