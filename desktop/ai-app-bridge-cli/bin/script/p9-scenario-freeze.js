'use strict';

function requireP9Frozen(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'p9_manifest_invalid' };
  }
  if (manifest.login !== false || manifest.moodle !== false) {
    return { ok: false, error: 'p9_forbidden_surface' };
  }
  if (manifest.frozen !== true) {
    return { ok: false, error: 'p9_not_frozen' };
  }
  return { ok: true, manifest };
}

const FREEZE_FIELDS = ['version', 'language', 'labels', 'fixtureHash', 'initialState'];

function applyP9Freeze(manifest, freeze) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'p9_manifest_invalid' };
  }
  if (manifest.login !== false || manifest.moodle !== false) {
    return { ok: false, error: 'p9_forbidden_surface' };
  }
  if (!freeze || typeof freeze !== 'object') {
    return { ok: false, error: 'p9_freeze_required' };
  }
  for (const field of FREEZE_FIELDS) {
    if (freeze[field] == null) {
      return { ok: false, error: 'p9_freeze_required', field };
    }
  }
  return {
    ok: true,
    manifest: {
      ...manifest,
      frozen: true,
      freeze,
    },
  };
}

module.exports = { requireP9Frozen, applyP9Freeze, FREEZE_FIELDS };
