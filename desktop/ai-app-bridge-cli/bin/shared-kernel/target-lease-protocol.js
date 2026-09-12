'use strict';

const { targetIdentity } = require('./execution-target');

function androidAppTargetKey(serial, packageName) {
  const serialValue = String(serial || '');
  if (!serialValue) return '';
  return targetIdentity({ platform: 'android', serial: serialValue, packageName: String(packageName || '') });
}

function createTargetLease({ maxActive = 1 } = {}) {
  const held = new Map();

  function acquire(serial) {
    const key = String(serial || '');
    if (!key) return { ok: false, error: 'serial_required' };
    const active = held.get(key) || 0;
    if (active >= maxActive) {
      return { ok: false, error: 'target_busy', serial: key, active };
    }
    held.set(key, active + 1);
    return {
      ok: true,
      serial: key,
      release() {
        const current = held.get(key) || 0;
        if (current <= 1) held.delete(key);
        else held.set(key, current - 1);
      },
    };
  }

  function status(serial) {
    const key = String(serial || '');
    return { serial: key, active: held.get(key) || 0, maxActive };
  }

  return { acquire, status };
}

const processTargetLease = createTargetLease();

function getProcessTargetLease() {
  return processTargetLease;
}

module.exports = { androidAppTargetKey, createTargetLease, getProcessTargetLease };
