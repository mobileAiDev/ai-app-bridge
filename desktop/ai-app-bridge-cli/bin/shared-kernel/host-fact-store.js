'use strict';

const path = require('node:path');
const { createFactStore } = require('../fact-store');
const { defaultSegmentedFactStorePath } = require('../segmented-fact-store');
const { CommandError } = require('../command-errors');
const { canonicalPath } = require('./canonical-path');

let shared;
let exitInstalled = false;

function hostFactStoreTarget() {
  const explicit = process.env.AI_APP_BRIDGE_FACT_STORE_DIR, legacy = process.env.AI_APP_BRIDGE_FACT_CACHE_PATH;
  const profile = process.env.AI_APP_BRIDGE_FACT_CACHE_PROFILE || 'auto';
  if (!['auto', '64mb', '256mb', '512mb', '1gb'].includes(profile))
    throw new CommandError('invalid_fact_store_profile', 'FactStore profile must be auto, 64mb, 256mb, 512mb or 1gb.');
  return { directory: canonicalPath(explicit || (legacy ? path.join(path.dirname(path.resolve(legacy)), 'fact-store-v1') : defaultSegmentedFactStorePath())),
    profile };
}

function open(target) {
  try { return createFactStore(target); }
  catch (error) {
    if (error.code === 'sfs_busy') throw new CommandError('fact_store_writer_busy',
      'Another Host owns this FactStore. Reconcile from that Host, or close it before retrying. Original device acknowledgement remains pending.');
    throw error;
  }
}

function getHostFactStore() {
  if (!shared || shared.closed) shared = open(hostFactStoreTarget());
  if (!exitInstalled) {
    exitInstalled = true;
    process.once('exit', () => { try { shared?.close(); } catch { /* Process exit retains committed facts. */ } });
  }
  return shared;
}

function closeHostFactStore() { shared?.close(); shared = null; }

function withHostFactStore(target, action) {
  if (canonicalPath(target.directory) === hostFactStoreTarget().directory) return action(getHostFactStore());
  // Recovery follows the original journal's store destination, even when this
  // Host was opened with a different recording directory. Close this bounded handle.
  const store = open(target);
  try { return action(store); } finally { store.close(); }
}

module.exports = { hostFactStoreTarget, getHostFactStore, closeHostFactStore, withHostFactStore };
