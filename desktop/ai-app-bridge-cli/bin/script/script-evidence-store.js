'use strict';

const { createEvidenceStore } = require('../shared-kernel/evidence-store');
const { randomUUID } = require('node:crypto');

function createScriptEvidenceStore(options = {}) {
  const store = createEvidenceStore({ maxBytes: 65 * 1024 * 1024, ...options, namespace: 'script' });
  // Store instances restart their local counter. IDs must not overwrite an earlier run.
  const identified = (kind, record) => ({
    ...record,
    evidenceId: record.evidenceId || `script:${kind}:${record.operationId}:${randomUUID()}`,
  });
  const persist = (kind, record) => store.persist(kind, identified(kind, record));
  return {
    ...store,
    persist,
    commit: persist,
    offer: (kind, record) => store.offer(kind, identified(kind, record)),
  };
}

module.exports = { createScriptEvidenceStore };
