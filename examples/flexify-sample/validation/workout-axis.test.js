'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { volumeAxisBracketsExpected } = require('./workout-flow');

// Labels projected from the real iPhone observations, not synthetic App data.
// Full payloads and their checks are retained in axis-observation-checks-38.json.
const cases = [
  { source: 'Intent 04', labels: ['Volume', 'Day', '11/9/26', '624.6', '624.9', '625', '625.1', '625.4'], value: 625 },
  { source: 'Script 02', labels: ['Volume', 'Day', '11/9/26', '1.2K', '1.3K'], value: 1250 },
  { source: 'Script 03', labels: ['Volume', 'Day', '11/9/26', '1.9K'], value: 1875 },
];
for (const { source, labels, value } of cases) {
  test(`${source}: actual rounded scale covers its total and rejects a different scale`, () => {
    const nodes = labels.map(text => ({ text }));
    assert.equal(volumeAxisBracketsExpected(nodes, value), true);
    assert.equal(volumeAxisBracketsExpected(nodes, 4000), false);
  });
}
test('missing labels and the next rounding interval cannot pass', () => {
  assert.equal(volumeAxisBracketsExpected([], 1875), false);
  assert.equal(volumeAxisBracketsExpected([{ text: '1.9K' }], 1950), false);
  // Nearby exact totals cannot be distinguished from rounded labels. The
  // independent SQLite oracle must still verify the exact number.
  assert.equal(volumeAxisBracketsExpected([{ text: '1.9K' }], 1876), true);
});
