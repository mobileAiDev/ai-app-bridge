'use strict';

const { isDeepStrictEqual } = require('node:util');
const { CommandError } = require('../command-errors');
const { sanitizePersistentValue } = require('../fact-codec');
const { getHostFactStore, withHostFactStore } = require('./host-fact-store');
const { digest } = require('./uia-protocol');

const schema = 'aab.device-completion/v1';
const targetKey = serial => `device-completion:${serial}`;

function representation(json, originalSha256) {
  const stored = sanitizePersistentValue(json), storedSha256 = digest(stored);
  return { representation: stored === json ? 'original-json' : 'redacted-json', originalSha256, storedSha256, json: stored };
}

function persistCompletion({ pending, proof, historyTarget }) {
  const record = { schemaVersion: schema, kind: 'uia-node', serial: pending.target.serial,
    bootId: pending.bootId, runtimeEpoch: pending.runtimeEpoch, actionId: pending.actionId,
    request: representation(pending.requestJson, pending.requestSha256),
    completion: representation(proof.receiptJson, proof.responseSha256) };
  return withHostFactStore(historyTarget, store => {
    const key = targetKey(record.serial);
    const saved = store.record({ partition: 'action', targetKey: key, runtimeEpoch: record.runtimeEpoch, actionId: record.actionId,
      dedupeKey: `${key}:${record.runtimeEpoch}:${record.actionId}:${pending.requestSha256}:${proof.responseSha256}`,
      payload: record }, { durability: 'sync' });
    if (saved.ok !== true || saved.receipt?.stored !== true)
      throw new CommandError('device_completion_history_unavailable', 'The original completion could not be committed to FactStore; phone acknowledgement remains pending.');
    const page = store.read({ partitions: ['action'], targetKey: key, runtimeEpoch: record.runtimeEpoch, actionId: record.actionId, limit: 2 });
    if (!page.ok || page.items?.length !== 1 || !isDeepStrictEqual(page.items[0].payload, record))
      throw new CommandError('device_completion_history_invalid', 'The committed completion representation could not be read back exactly.');
    return { storeDirectory: historyTarget.directory, targetKey: key, globalSeq: page.items[0].globalSeq,
      runtimeEpoch: record.runtimeEpoch, actionId: record.actionId,
      originalCompletionAvailable: record.request.representation === 'original-json' && record.completion.representation === 'original-json' };
  });
}

function readCompletion({ serial, runtimeEpoch, actionId }) {
  const page = getHostFactStore().read({ partitions: ['action'], targetKey: targetKey(serial), runtimeEpoch, actionId, limit: 2 });
  if (!page.ok) return { ok: false, error: page.error || 'device_completion_history_unavailable' };
  if (page.items?.length !== 1) return { ok: false, error: page.items?.length ? 'device_completion_history_ambiguous' : 'device_completion_not_retained',
    serial, runtimeEpoch, actionId, message: 'No unique retained completion representation matches this identity. Absence is not an action outcome.' };
  const { payload: record, globalSeq } = page.items[0];
  if (record?.schemaVersion !== schema || record.serial !== serial || record.runtimeEpoch !== runtimeEpoch || record.actionId !== actionId
    || [record.request, record.completion].some(value => !value || typeof value.json !== 'string' || digest(value.json) !== value.storedSha256
      || !/^[0-9a-f]{64}$/.test(value.originalSha256) || value.representation !== (value.originalSha256 === value.storedSha256 ? 'original-json' : 'redacted-json')))
    return { ok: false, error: 'device_completion_history_invalid' };
  return { ok: true, serial, runtimeEpoch, actionId, source: 'host-fact-store', globalSeq,
    originalCompletionAvailable: record.request.representation === 'original-json' && record.completion.representation === 'original-json', record };
}

module.exports = { persistCompletion, readCompletion };
