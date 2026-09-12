'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createMemoryEvidenceAdapter({ maxBytes = Number.MAX_SAFE_INTEGER, fault = null } = {}) {
  const records = new Map();
  let sequence = 0;
  const adapter = {
    record(envelope) {
      if (fault === 'throw') {
        throw new Error('writer_crash');
      }
      if (fault === 'enospc') {
        const error = new Error('ENOSPC');
        error.code = 'ENOSPC';
        return { ok: false, error: 'ENOSPC' };
      }
      if (fault === 'hang') {
        return new Promise(() => {});
      }
      const bytes = Buffer.byteLength(JSON.stringify(envelope));
      if (bytes > maxBytes) {
        return { ok: false, error: 'payload_too_large', bytes, maxBytes };
      }
      sequence += 1;
      const stored = fault === 'corrupt_manifest'
        ? { ...envelope, checksum: '0'.repeat(64) }
        : { ...envelope };
      records.set(stored.evidenceId, stored);
      return { ok: true, stored: true, globalSeq: sequence, evidenceId: stored.evidenceId };
    },
    offer(envelope) {
      return { accepted: true, completion: Promise.resolve().then(() => adapter.record(envelope)) };
    },
    readById(evidenceId) {
      return records.get(evidenceId) || null;
    },
    list({ namespace, operationId } = {}) {
      return [...records.values()].filter((item) => (
        (!namespace || item.namespace === namespace)
        && (!operationId || item.operationId === operationId)
      ));
    },
    status() {
      if (fault === 'corrupt_manifest') {
        return { ok: false, error: 'corrupt_manifest', count: records.size };
      }
      return { ok: true, adapter: 'memory', count: records.size, degraded: false };
    },
    close() {
      records.clear();
    },
  };
  return adapter;
}

function createSegmentedEvidenceAdapter(factStore, { ownsStore = false } = {}) {
  if (!factStore || typeof factStore.record !== 'function' || typeof factStore.read !== 'function') {
    throw new TypeError('segmented evidence adapter requires a FactStore');
  }
  function factFor(envelope) {
    return {
      partition: partitionFor(envelope.kind),
      targetKey: `evidence:${envelope.namespace}:${envelope.operationId}`,
      app: { platform: 'host', packageName: envelope.namespace },
      runtimeEpoch: String(envelope.operationId),
      actionId: envelope.evidenceId,
      timestamps: {
        occurredAtMs: envelope.committedAtMs,
        observedAtMs: envelope.committedAtMs,
      },
      payload: envelope,
    };
  }
  const adapter = {
    record(envelope) {
      try {
        const result = factStore.record(factFor(envelope), { durability: 'sync' });
        const receipt = result.receipt || result.receipts?.[0] || result;
        if (receipt?.ok === false || result.ok === false) {
          return { ok: false, error: receipt?.error || result.error || 'persist_failed' };
        }
        return { ok: true, stored: true, evidenceId: envelope.evidenceId, globalSeq: receipt.globalSeq };
      } catch (error) {
        return {
          ok: false,
          error: error.code || 'persist_failed',
          detail: error.message || String(error),
        };
      }
    },
    offer(envelope) {
      if (typeof factStore.offer !== 'function') {
        return { accepted: false, reason: 'async_offer_unsupported' };
      }
      const offered = factStore.offer(factFor(envelope), { durability: 'sync' });
      if (!offered.accepted) return offered;
      return {
        ...offered,
        completion: offered.completion.then((result) => {
          const receipt = result.receipt || result.receipts?.[0] || result;
          if (receipt?.ok === false || result.ok === false) {
            return { ok: false, stored: false, error: receipt?.error || result.error || 'persist_failed' };
          }
          return {
            ok: true,
            stored: true,
            evidenceId: envelope.evidenceId,
            globalSeq: receipt.globalSeq,
          };
        }),
      };
    },
    readById(evidenceId) {
      const page = factStore.read({ actionId: evidenceId, limit: 1 });
      if (!page.ok) throw Object.assign(new Error(page.error || 'Evidence store read failed.'), { code: 'evidence_read_failed' });
      const item = page.items?.[0];
      return item?.payload || null;
    },
    list({ namespace, operationId } = {}) {
      const items = [];
      let cursor;
      do {
        const page = factStore.read({
          targetKey: operationId ? `evidence:${namespace}:${operationId}` : undefined,
          cursor,
          limit: 1_000,
        });
        if (!page.ok) throw Object.assign(new Error(page.error || 'Evidence store read failed.'), { code: 'evidence_read_failed' });
        items.push(...(page.items || []));
        cursor = page.hasMore ? page.cursor : null;
      } while (cursor);
      return items
        .map((item) => item.payload)
        .filter((payload) => payload
          && (!namespace || payload.namespace === namespace)
          && (!operationId || payload.operationId === operationId));
    },
    status() {
      return factStore.status();
    },
    close() {
      if (ownsStore) factStore.close?.();
    },
  };
  return adapter;
}

function createLegacyFactStoreAdapter(factStore) {
  if (
    !factStore
    || typeof factStore.record !== 'function'
    || typeof factStore.read !== 'function'
    || typeof factStore.status !== 'function'
  ) {
    throw new TypeError('legacy fact adapter requires a FactStore');
  }
  return {
    append(partitionOrFact, maybeFact) {
      const fact = maybeFact === undefined
        ? partitionOrFact
        : { ...maybeFact, partition: String(partitionOrFact) };
      const result = factStore.record(fact, { durability: 'sync' });
      return result.receipt || result.receipts?.[0] || result;
    },
    query(query = {}) {
      return factStore.read({
        partitions: query.partitions || (query.partition ? [query.partition] : undefined),
        targetKey: query.targetKey ?? query.target,
        runtimeEpoch: query.runtimeEpoch,
        cursor: query.cursor,
        limit: query.limit,
        ...(Object.prototype.hasOwnProperty.call(query, 'actionId')
          ? { actionId: query.actionId }
          : {}),
      });
    },
    status() {
      return factStore.status();
    },
    close() {},
  };
}

function partitionFor(kind) {
  if (kind === 'observation' || kind === 'summary') return 'ui';
  return 'action';
}

function createFileEvidenceAdapter({ dir } = {}) {
  if (!dir) throw new TypeError('dir is required');
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, 'index.json');

  function loadIndex() {
    if (!fs.existsSync(indexPath)) return [];
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }

  function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  function saveIndex(ids) {
    writeAtomic(indexPath, JSON.stringify(ids));
  }

  function fileFor(evidenceId) {
    return path.join(dir, `${encodeURIComponent(evidenceId)}.json`);
  }

  const adapter = {
    record(envelope) {
      writeAtomic(fileFor(envelope.evidenceId), JSON.stringify(envelope));
      const ids = loadIndex();
      ids.push(envelope.evidenceId);
      saveIndex(ids);
      return { ok: true, stored: true, evidenceId: envelope.evidenceId, globalSeq: ids.length };
    },
    offer(envelope) {
      return { accepted: true, completion: Promise.resolve().then(() => adapter.record(envelope)) };
    },
    readById(evidenceId) {
      const file = fileFor(evidenceId);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    list({ namespace, operationId } = {}) {
      return loadIndex()
        .map((id) => this.readById(id))
        .filter((item) => item
          && (!namespace || item.namespace === namespace)
          && (!operationId || item.operationId === operationId));
    },
    status() {
      return { ok: true, adapter: 'file', dir, count: loadIndex().length };
    },
    close() {},
  };
  return adapter;
}

module.exports = {
  createLegacyFactStoreAdapter,
  createMemoryEvidenceAdapter,
  createSegmentedEvidenceAdapter,
  createFileEvidenceAdapter,
};
