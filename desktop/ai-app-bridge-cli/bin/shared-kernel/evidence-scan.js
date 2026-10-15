'use strict';

const PARTITIONS = ['action', 'ui'];

function requireValue(condition, code, detail) {
  if (!condition) throw Object.assign(new Error(code), { code, detail });
}

function retentionSnapshot(status) {
  requireValue(status.ok === true, 'fact_store_unavailable');
  requireValue(typeof status.storeId === 'string' && status.storeId.length > 0
    && Number.isSafeInteger(status.sequences?.nextGlobalSeq) && status.sequences.nextGlobalSeq > 0,
  'invalid_store_snapshot');
  return PARTITIONS.map(partition => {
    const count = status.quota?.partitions?.[partition]?.evictedRecords;
    requireValue(Number.isSafeInteger(count) && count >= 0, 'invalid_store_snapshot');
    return count;
  });
}

// A fresh scan may include different retained prefixes in each partition. Its
// internal cursors therefore belong to individual partitions, never to their
// mixed global sequence. Existing cursors retain the FactStore gap contract.
function readRetainedEvidenceFacts(store, { targetKey, snapshot = store.status(), acceptFact = () => {} } = {}) {
  const retainedAtStart = retentionSnapshot(snapshot);
  const throughGlobalSeq = snapshot.sequences.nextGlobalSeq - 1;
  const facts = [];
  for (const partition of PARTITIONS) {
    const cursors = new Set();
    let cursor;
    let previousSequence = 0;
    do {
      const page = store.read({ partitions: [partition], targetKey, limit: 1000,
        ...(cursor === undefined ? {} : { cursor }) });
      requireValue(page.ok === true, 'fact_store_read_failed', page.error);
      requireValue(page.gap === false && page.cursorExpired === false, 'evidence_gap');
      requireValue(Array.isArray(page.items) && typeof page.hasMore === 'boolean', 'invalid_store_page');
      for (const fact of page.items) {
        requireValue(Number.isSafeInteger(fact.globalSeq) && fact.globalSeq > previousSequence, 'invalid_record_sequence');
        previousSequence = fact.globalSeq;
        acceptFact(fact);
        if (fact.globalSeq > throughGlobalSeq) continue;
        facts.push(fact);
      }
      if (page.hasMore) {
        requireValue(page.items.length > 0 && typeof page.cursor === 'string' && page.cursor.length > 0
          && !cursors.has(page.cursor), 'invalid_store_cursor');
        cursors.add(page.cursor);
      }
      if (!page.hasMore || previousSequence >= throughGlobalSeq) break;
      cursor = page.cursor;
    } while (true);
  }
  const after = store.status();
  const retainedAtEnd = retentionSnapshot(after);
  requireValue(after.storeId === snapshot.storeId, 'store_changed_during_read');
  // A later partition's first page has no cursor to detect an intervening
  // eviction. Compare both selected partitions across the complete scan.
  requireValue(retainedAtEnd.every((count, index) => count === retainedAtStart[index]),
    'fact_store_read_failed', 'cursor_expired');
  facts.sort((a, b) => a.globalSeq - b.globalSeq);
  requireValue(facts.every((fact, index) => index === 0 || fact.globalSeq > facts[index - 1].globalSeq),
    'invalid_record_sequence');
  return facts;
}

module.exports = { readRetainedEvidenceFacts };
