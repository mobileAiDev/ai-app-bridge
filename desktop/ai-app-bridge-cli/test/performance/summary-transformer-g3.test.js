'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTree } = require('../../bin/shared-kernel/summary-transformer');
test('G3 5k and 10k node p95 stays under 20ms and output stays bounded', () => {
  const five = benchmark(5_000);
  const ten = benchmark(10_000);
  assert.equal(five.p95 < 20, true, `5k p95 ${five.p95}`);
  assert.equal(ten.p95 < 20, true, `10k p95 ${ten.p95}`);
  assert.equal(five.summary.ok, true);
  assert.equal(ten.summary.ok, true);
  assert.equal(Buffer.byteLength(JSON.stringify(five.summary), 'utf8') <= 64 * 1024, true);
  assert.equal(Buffer.byteLength(JSON.stringify(ten.summary), 'utf8') <= 64 * 1024, true);
});

function benchmark(count) {
  const rawTree = {
    operable: {
      nodes: Array.from({ length: count }, (_, index) => ({
        id: `n-${index}`,
        widgetType: index % 7 === 0 ? 'TextField' : 'ListTile',
        text: `Item ${index}`,
        actions: ['tap'],
        bounds: { left: 0, top: index, right: 100, bottom: index + 1 },
      })),
    },
  };
  const samples = [];
  let summary;
  for (let i = 0; i < 12; i += 1) {
    const started = process.hrtime.bigint();
    summary = summarizeTree({ provider: 'flutter', rawTree, rawTreeId: `bench-${count}` });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { p95: samples[Math.ceil(samples.length * 0.95) - 1], summary, samples };
}
