'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSegmentedFactStore } = require('../bin/fact-store');

function createTemporarySegmentedStore(t, {
  prefix = 'ai-app-bridge-segmented-test-',
  budgetBytes = 12 * 1024 * 1024,
} = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const segmentSize = 512 * 1024;
  const minimumBudgetBytes = segmentSize * 24;
  const store = createSegmentedFactStore({
    directory,
    profile: '64mb',
    budgetBytes: Math.max(Number(budgetBytes) || 0, minimumBudgetBytes),
    segmentSize,
    partitionQuotas: Array(8).fill(segmentSize * 2),
    projectionBudgetBytes: 16 * 1024 * 1024,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

module.exports = { createTemporarySegmentedStore };
