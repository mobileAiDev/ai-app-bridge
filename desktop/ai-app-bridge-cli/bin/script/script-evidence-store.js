'use strict';

const { createEvidenceStore } = require('../shared-kernel/evidence-store');

function createScriptEvidenceStore(options = {}) {
  return createEvidenceStore({ ...options, namespace: 'script' });
}

module.exports = { createScriptEvidenceStore };
