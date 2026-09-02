'use strict';

const { createEvidenceStore } = require('../shared-kernel/evidence-store');

function createIntentEvidenceStore(options = {}) {
  return createEvidenceStore({ ...options, namespace: 'intent' });
}

module.exports = { createIntentEvidenceStore };
