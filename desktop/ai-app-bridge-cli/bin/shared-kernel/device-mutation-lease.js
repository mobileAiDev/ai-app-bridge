'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { createOwnershipStore, schemaVersion } = require('./device-ownership-store');
const acknowledgements = require('./device-acknowledgements');

const context = new AsyncLocalStorage();
const effectContext = new AsyncLocalStorage();

function rejection(error, serial, ownership) {
  return { ok: false, error, serial, active: 1, dispatched: false, ambiguous: false,
    message: error === 'target_busy' ? 'Another Host operation owns this physical device.'
      : 'A previous device action has no confirmed completion. Reconcile device ownership before another mutation.',
    ...(ownership ? { ownership: structuredClone(ownership) } : {}) };
}

function knownOutcome(value) {
  if (value?.settled === true) return true;
  if (value?.settled === false || value?.ambiguous === true || value?.dispatched === null) return false;
  if (value?.dispatched === false && value?.ambiguous === false) return true;
  // A protocol error without dispatch metadata is not proof that the remote
  // operation stopped. In particular, an H5 timeout can leave a queued write.
  return value?.ok !== false && value?.error == null;
}

function createDeviceMutationLease({ directory } = {}) {
  const store = createOwnershipStore(directory);
  const held = new Map();
  function acquire(serial) {
    if (typeof serial !== 'string' || !serial) return { ok: false, error: 'serial_required', dispatched: false, ambiguous: false };
    const parent = context.getStore();
    if (parent?.serial === serial && parent.directory === store.directory && !parent.closed) {
      if (parent.state.phase === 'unresolved') return rejection('device_ownership_unresolved', serial, parent.state);
      return { ok: true, serial, run: action => {
        if (parent.closed) throw new CommandError('device_ownership_lost', 'The owning device operation has already closed.');
        return action();
      }, release() {} };
    }
    if (held.has(serial)) return rejection('target_busy', serial, held.get(serial).state);
    const lock = store.lock(serial);
    if (!lock) return rejection('target_busy', serial);
    try {
      const previous = store.read(serial);
      if (previous?.pending || previous?.reservations.length) { lock.close(); return rejection('device_ownership_unresolved', serial, previous); }
      const state = { schemaVersion, serial, phase: 'owned', owner: { id: randomUUID(), pid: process.pid, acquiredAtMs: Date.now() },
        pending: null, reservations: [], lastSettlement: previous?.lastSettlement ?? null,
        pendingAcknowledgements: previous?.pendingAcknowledgements ?? [] };
      store.write(serial, state);
      const owner = { serial, directory: store.directory, state, closed: false,
        commit() { if (owner.closed) throw new CommandError('device_ownership_lost', 'The owning device operation has already closed.'); store.write(serial, state); } };
      held.set(serial, owner);
      return {
        ok: true, serial,
        retain(descriptor) {
          if (owner.closed || state.phase === 'unresolved') throw new CommandError('device_ownership_lost', 'Cannot start work after the owner has stopped.');
          const reservation = { ...descriptor, id: randomUUID(), preparedAtMs: Date.now() };
          state.reservations.push(reservation); owner.commit();
          let done = false;
          return { settle(proof) {
            if (done) return;
            if (owner.closed) throw new CommandError('device_ownership_lost', 'The device owner has closed.');
            if (proof?.settled !== true) return;
            state.reservations = state.reservations.filter(item => item !== reservation);
            state.lastSettlement = { pendingId: reservation.id, settledAtMs: Date.now(), proof };
            owner.commit(); done = true;
          } };
        },
        async run(action) {
          if (owner.closed) throw new CommandError('device_ownership_lost', 'The owning device operation has already closed.');
          if (state.phase === 'unresolved' || state.pending) return rejection('device_ownership_unresolved', serial, state);
          // Only an actual transport effect or installation reservation can
          // outlive this Host. Observation/preparation does not dispatch work.
          const receipts = [];
          owner.receipts = receipts;
          try {
            return await context.run(owner, action);
          } catch (error) {
            if (receipts.length && !state.pending) {
              error.settled = true;
              if (receipts.some(proof => proof.dispatched === true)) error.dispatched = true;
              if (receipts.length === 1) error.executionReceipt = receipts[0];
              else error.executionReceipts = receipts;
            }
            throw error;
          } finally {
            if (state.pending) { state.phase = 'unresolved'; owner.commit(); }
          }
        },
        release() {
          if (owner.closed) return;
          try { state.phase = state.pending || state.reservations.length ? 'unresolved' : 'idle'; owner.commit(); }
          finally { owner.closed = true; held.delete(serial); lock.close(); }
        },
      };
    } catch (error) { lock.close(); throw error; }
  }
  async function run(serial, action) {
    const token = acquire(serial);
    if (!token.ok) return token;
    try { return await token.run(action); } finally { token.release(); }
  }
  function status(serial) {
    if (typeof serial !== 'string' || !serial) return { ok: false, error: 'serial_required' };
    const lock = held.has(serial) ? null : store.lock(serial);
    try {
      const state = store.read(serial);
      const unresolved = state?.pending || state?.reservations.length;
      return { ok: true, serial, active: !lock || unresolved ? 1 : 0, maxActive: 1,
        phase: !lock ? 'owned' : unresolved ? 'unresolved' : 'idle', ownership: state ? structuredClone(state) : null };
    } finally { lock?.close(); }
  }
  async function reconcile(serial, verify) {
    const lock = held.has(serial) ? null : store.lock(serial);
    if (!lock) return rejection('target_busy', serial);
    try {
      const state = store.read(serial);
      if (!state?.pending && !state?.reservations.length) return { ok: true, serial, phase: 'idle', recovered: false };
      for (const pending of [state.pending, ...state.reservations].filter(Boolean)) {
        const proof = await verify(structuredClone(pending));
        if (proof?.settled !== true) return { ...rejection('device_ownership_unresolved', serial, state), recovery: proof };
        acknowledgements.append(state, pending, proof);
        state.lastSettlement = { pendingId: pending.id, settledAtMs: Date.now(), proof };
        if (state.pending === pending) state.pending = null;
        else state.reservations = state.reservations.filter(item => item !== pending);
        store.write(serial, state);
      }
      state.phase = 'idle'; store.write(serial, state);
      return { ok: true, serial, phase: 'idle', recovered: true, settlement: state.lastSettlement,
        executionReceipt: state.lastSettlement.proof };
    } finally { lock.close(); }
  }
  async function drainAcknowledgements(serial, acknowledge) {
    const lock = held.has(serial) ? null : store.lock(serial);
    if (!lock) return rejection('target_busy', serial);
    try {
      const state = store.read(serial), errors = [], retired = [];
      if (!state) return { ok: true, remaining: 0, errors, retired };
      for (const entry of [...state.pendingAcknowledgements]) {
        try {
          const result = await retireAcknowledgement(state, entry, () => store.write(serial, state), acknowledge);
          retired.push({ actionId: entry.pending.actionId, disposition: result.disposition, history: result.history });
        }
        catch (error) { errors.push({ actionId: entry.pending.actionId, error: error.code || 'uia_acknowledgement_failed' }); }
      }
      return { ok: true, remaining: state.pendingAcknowledgements.length, errors, retired };
    } finally { lock.close(); }
  }
  return { acquire, run, status, reconcile, drainAcknowledgements, directory: store.directory };
}

// Ordinary transport calls inherit a managed provider's effect scope. Its
// cancellation request must not replace the identity of the original action.
async function runDeviceEffect(descriptor, action, settled = knownOutcome, { allowNested = false } = {}) {
  const owner = context.getStore();
  if (!owner) return action();
  if (owner.closed) throw new CommandError('device_ownership_lost', 'The device owner has closed.');
  if (effectContext.getStore() === owner) return action();
  const state = owner.state;
  if (state.phase === 'unresolved' || state.pending && state.pending.allowNested !== true) {
    throw new CommandError('device_ownership_unresolved', 'The preceding device action is still unresolved.');
  }
  acknowledgements.checkCapacity(state, descriptor);
  const pending = { ...descriptor, ...(allowNested ? { allowNested: true } : {}), id: randomUUID(), preparedAtMs: Date.now() };
  state.pending = pending; owner.commit();
  const finish = proof => {
    if (owner.closed || state.pending !== pending) throw new CommandError('device_ownership_lost', 'A different device operation owns the settlement.');
    acknowledgements.append(state, pending, proof);
    state.lastSettlement = { pendingId: pending.id, settledAtMs: Date.now(), proof };
    state.pending = null; owner.commit();
    owner.receipts?.push(proof);
  };
  try {
    const result = await (allowNested ? action() : effectContext.run(owner, action));
    // The adapter's actual transport has taken responsibility for settlement.
    // Do not restore a generic marker after its specific receipt is durable.
    if (allowNested && state.pending !== pending) return result;
    const proof = settled(result);
    if (proof) finish(proof === true ? { kind: descriptor.kind, actionId: descriptor.actionId ?? null,
      runtimeEpoch: descriptor.runtimeEpoch ?? null, settled: true, dispatched: result?.dispatched ?? null } : proof);
    else { state.phase = 'unresolved'; owner.commit(); }
    return result;
  } catch (error) {
    if (allowNested && state.pending !== pending) throw error;
    if (error?.dispatched === false && error?.ambiguous !== true) finish({ kind: descriptor.kind, settled: true, dispatched: false });
    else { state.phase = 'unresolved'; owner.commit(); }
    throw error;
  }
}

let processLease;
function getProcessDeviceMutationLease() { return processLease ||= createDeviceMutationLease(); }

function isDeviceSettlementDurable(proof) {
  const owner = context.getStore();
  return Boolean(owner && !owner.closed && JSON.stringify(owner.state.lastSettlement?.proof) === JSON.stringify(proof));
}

async function retireAcknowledgement(state, entry, commit, acknowledge) {
  const history = require('./device-completion-history').persistCompletion(entry);
  const result = await acknowledge(structuredClone(entry));
  if (!acknowledgements.accepted(result))
    throw new CommandError(result?.error || 'uia_acknowledgement_failed', 'The original receipt acknowledgement remains pending.');
  const previous = state.pendingAcknowledgements;
  state.pendingAcknowledgements = previous.filter(item => item !== entry);
  try { commit(); } catch (error) { state.pendingAcknowledgements = previous; throw error; }
  return { ...result, history };
}

async function completeDeviceAcknowledgement(proof, acknowledge) {
  const owner = context.getStore();
  if (!owner || owner.closed) throw new CommandError('device_ownership_lost', 'Acknowledgement requires the original device owner.');
  const entry = owner.state.pendingAcknowledgements.find(item => JSON.stringify(item.proof) === JSON.stringify(proof));
  if (!entry) throw new CommandError('device_acknowledgement_invalid', 'No durable acknowledgement matches this completion receipt.');
  return retireAcknowledgement(owner.state, entry, () => owner.commit(), acknowledge);
}

module.exports = { createDeviceMutationLease, getProcessDeviceMutationLease, runDeviceEffect, isDeviceSettlementDurable, completeDeviceAcknowledgement };
