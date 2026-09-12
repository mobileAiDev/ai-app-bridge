'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getHostFactStore, closeHostFactStore, hostFactStoreTarget, withHostFactStore } = require('../bin/shared-kernel/host-fact-store');

test('receipt recovery reuses the same physical FactStore through a symlink instead of opening a second writer', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-store-alias-'));
  const previous = process.env.AI_APP_BRIDGE_FACT_STORE_DIR;
  t.after(() => {
    closeHostFactStore();
    if (previous === undefined) delete process.env.AI_APP_BRIDGE_FACT_STORE_DIR;
    else process.env.AI_APP_BRIDGE_FACT_STORE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, 'physical'));
  fs.symlinkSync(path.join(directory, 'physical'), path.join(directory, 'alias'), 'dir');
  process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'alias', 'facts');
  const identity = hostFactStoreTarget();
  const store = getHostFactStore();
  assert.equal(hostFactStoreTarget().directory, identity.directory, 'mkdir must not change the store identity');
  for (const parent of ['physical', 'alias']) {
    withHostFactStore({ ...identity, directory: path.join(directory, parent, 'facts') }, recovered => assert.equal(recovered, store));
  }
});
