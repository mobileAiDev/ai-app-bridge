'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSegmentedFactStore } = require('../bin/fact-store');

const TIERS = [
  { name: 'low', count: 200 },
  { name: 'medium', count: 2_000 },
  { name: 'high', count: 10_000 },
];

function logFact(sequence) {
  return {
    partition: 'app-log',
    targetKey: 'android:device:io.github.mobileaidev.aiappbridge.sample',
    app: { platform: 'android', packageName: 'io.github.mobileaidev.aiappbridge.sample' },
    runtimeEpoch: 'runtime-stress',
    actionId: null,
    timestamps: { occurredAtMs: 1_000 + sequence, observedAtMs: 1_010 + sequence },
    payload: {
      kind: 'evidence',
      stream: 'logs',
      record: {
        type: 'log',
        source: 'logcat',
        level: 'debug',
        tag: 'StressTag',
        message: `aab-log-stress-${sequence}`,
      },
    },
  };
}

function directoryBytes(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const next = path.join(root, entry.name);
    total += entry.isDirectory() ? directoryBytes(next) : fs.statSync(next).size;
  }
  return total;
}

test('host store measures cpu memory and disk at low medium high log load', () => {
  const rows = [];
  for (const tier of TIERS) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aab-log-load-${tier.name}-`)));
    const segmentSize = 256 * 1024;
    const store = createSegmentedFactStore({
      directory,
      profile: '64mb',
      budgetBytes: segmentSize * 48,
      segmentSize,
      partitionQuotas: [
        segmentSize,
        segmentSize,
        32 * segmentSize,
        2 * segmentSize,
        segmentSize,
        segmentSize,
        segmentSize,
        segmentSize,
      ],
    });
    const cpuBefore = process.cpuUsage();
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    for (let sequence = 0; sequence < tier.count; sequence += 1) {
      const result = store.record(logFact(sequence));
      assert.equal(result.ok, true);
      assert.equal(result.receipt.stored, true);
    }
    const elapsedNs = Number(process.hrtime.bigint() - startedAt);
    const cpu = process.cpuUsage(cpuBefore);
    const status = store.status();
    const diskBytes = directoryBytes(directory);
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    const written = Number(
      status.quota?.partitions?.['app-log']?.recordCount
        ?? status.engine?.recordCount
        ?? status.index?.count
        ?? 0,
    );
    assert.equal(written, tier.count);
    const elapsedMs = elapsedNs / 1_000_000;
    const cpuMs = (cpu.user + cpu.system) / 1000;
    rows.push({
      tier: tier.name,
      offered: tier.count,
      written,
      elapsedMs,
      factsPerSec: elapsedMs === 0 ? 0 : tier.count / (elapsedMs / 1000),
      cpuMs,
      cpuPercent: elapsedMs === 0 ? 0 : cpuMs / elapsedMs * 100,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      diskDeltaBytes: diskBytes,
    });
  }
  console.error(`AAB_LOG_LOAD host ${JSON.stringify(rows)}`);
  assert.ok(rows[0].diskDeltaBytes < rows[1].diskDeltaBytes);
  assert.ok(rows[1].diskDeltaBytes < rows[2].diskDeltaBytes);
});
