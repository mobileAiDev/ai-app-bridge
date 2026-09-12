'use strict';

const { isDeepStrictEqual } = require('node:util');
const { CommandError } = require('../command-errors');
const uia = require('./uia-protocol');
const path = require('node:path');

const capacity = 8;

// These are cleanup obligations, never an alternative completion authority.
// Keep both original request and receipt bytes after the effect marker clears.
function completion(pending, proof) {
  const response = { schemaVersion: proof?.schemaVersion, bootId: proof?.bootId, runtimeEpoch: proof?.runtimeEpoch,
    actionId: proof?.actionId, requestSha256: proof?.requestSha256, settled: true,
    receiptJson: proof?.receiptJson, receiptSha256: proof?.responseSha256 };
  const expected = uia.settlementProof(response, pending);
  if (!expected || !isDeepStrictEqual(expected, proof))
    throw new CommandError('device_acknowledgement_invalid', 'Acknowledgement requires the exact original UIA request and durable completion receipt.');
  return response;
}

function entry(pending, proof) {
  if (pending.kind !== 'uia-node' || typeof proof?.receiptJson !== 'string') return null;
  completion(pending, proof);
  return structuredClone({ pending, proof, historyTarget: require('./host-fact-store').hostFactStoreTarget() });
}

function valid(entry, serial) {
  if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 3 || !entry.pending || !entry.proof
    || typeof entry.pending.id !== 'string' || !entry.pending.id || entry.pending.target?.serial !== serial
    || !entry.historyTarget || typeof entry.historyTarget.directory !== 'string' || !path.isAbsolute(entry.historyTarget.directory)
    || !['auto', '64mb', '256mb', '512mb', '1gb'].includes(entry.historyTarget.profile)) return false;
  try { completion(entry.pending, entry.proof); return true; } catch { return false; }
}

function checkCapacity(state, descriptor) {
  if (descriptor.kind === 'uia-node' && state.pendingAcknowledgements.length >= capacity)
    throw new CommandError('device_acknowledgements_full', 'UIA has 8 pending receipt acknowledgements. Run device-ownership reconcile before another UIA action.',
      { dispatched: false, ambiguous: false });
}

function append(state, pending, proof) {
  const next = entry(pending, proof);
  if (!next) return;
  checkCapacity(state, pending);
  if (state.pendingAcknowledgements.some(item => item.pending.id === pending.id))
    throw new CommandError('device_acknowledgement_invalid', 'This original action already has a pending acknowledgement.');
  state.pendingAcknowledgements.push(next);
}

const accepted = value => value?.ok === true && ['acknowledged', 'not_retained'].includes(value.disposition);

module.exports = { capacity, completion, entry, valid, checkCapacity, append, accepted };
