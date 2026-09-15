'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { atomicJson, readJson } = require('./managed-runtime');

const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

class ReceiptJournal {
  constructor(directory, identity, { maxActions = 4096 } = {}) {
    this.directory = directory;
    this.identity = identity;
    this.maxActions = maxActions;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  receipt(actionId) {
    const value = readJson(path.join(this.directory, `${hash(actionId)}.json`));
    if (value && (value.actionId !== actionId || JSON.stringify(value.identity) !== JSON.stringify(this.identity))) {
      throw new CommandError('executor_receipt_identity_mismatch', 'Receipt does not belong to this executor session.');
    }
    return value;
  }

  begin(actionId, request) {
    const digest = hash(JSON.stringify(canonical(request)));
    const existing = this.receipt(actionId);
    if (existing) {
      if (existing.requestDigest !== digest) throw new CommandError('idempotency_conflict', 'actionId was already used with different executor arguments.');
      return { fresh: false, receipt: existing };
    }
    if (fs.readdirSync(this.directory).filter(name => name.endsWith('.json')).length >= this.maxActions) {
      throw new CommandError('executor_receipt_capacity', 'Close this session and open a new one; retained action receipts are full.');
    }
    const receipt = { schemaVersion: 'aab.executor-receipt/v1', identity: this.identity, actionId, requestDigest: digest,
      phase: 'started', preparedAtMs: Date.now(), settled: false, dispatched: null };
    atomicJson(path.join(this.directory, `${hash(actionId)}.json`), receipt);
    return { fresh: true, receipt };
  }

  finish(receipt, result) {
    const completed = { ...receipt, phase: 'completed', completedAtMs: Date.now(), settled: true,
      dispatched: result.dispatched === true, result };
    atomicJson(path.join(this.directory, `${hash(receipt.actionId)}.json`), completed);
    return completed;
  }
}

module.exports = { ReceiptJournal, canonical };
