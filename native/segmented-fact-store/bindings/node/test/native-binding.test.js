'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const binding = require('../../../index');

function openStore(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfs-node-binding-')));
  const segmentSize = options.segmentSize || 4_096;
  const handle = binding.open({
    directory,
    segmentSize,
    partitionQuotas: options.partitionQuotas || Array(8).fill(segmentSize * 4),
  });
  t.after(() => {
    binding.close(handle);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, handle, segmentSize };
}

test('Node-API binding appends and globally scans binary payloads across partitions', (t) => {
  const { handle } = openStore(t);
  const first = binding.append(handle, 0, Buffer.from([0x61, 0x00, 0x62]), false);
  const second = binding.append(handle, 1, Buffer.from('network-record'), true);

  assert.equal(first.sequence, 1n);
  assert.equal(first.partitionId, 0);
  assert.equal(first.payloadLength, 3);
  assert.equal(second.sequence, 2n);
  assert.equal(second.partitionId, 1);
  assert.ok(first.frameOffset >= 64n);

  let cursor = {};
  const scannedFirst = binding.scan(handle, cursor);
  cursor = scannedFirst.cursor;
  const scannedSecond = binding.scan(handle, cursor);
  cursor = scannedSecond.cursor;
  const end = binding.scan(handle, cursor);

  assert.equal(scannedFirst.done, false);
  assert.deepEqual(scannedFirst.payload, Buffer.from([0x61, 0x00, 0x62]));
  assert.equal(scannedFirst.record.sequence, 1n);
  assert.equal(scannedSecond.payload.toString(), 'network-record');
  assert.equal(scannedSecond.record.sequence, 2n);
  assert.equal(end.done, true);

  const status = binding.status(handle);
  assert.equal(status.formatVersion, 1);
  assert.equal(status.recordCount, 2n);
  assert.equal(status.nextSequence, 3n);
  assert.equal(status.partitions[0].recordCount, 1n);
  assert.equal(status.partitions[1].recordCount, 1n);
});

test('Node-API binding seeks a partition by sequence without scanning other partitions', (t) => {
  const { handle } = openStore(t);
  binding.append(handle, 0, Buffer.from('one'), true);
  binding.append(handle, 1, Buffer.from('unrelated'), true);
  binding.append(handle, 0, Buffer.from('three'), true);
  for (const afterSequence of [1n, 2n, 0n, 1n]) {
    const page = binding.scan(handle, { partitionId: 0, afterSequence });
    assert.equal(page.record.sequence, afterSequence === 0n ? 1n : 3n);
    assert.equal(page.record.partitionId, 0);
    assert.equal(page.payload.toString(), afterSequence === 0n ? 'one' : 'three');
  }
  assert.equal(binding.scan(handle, { partitionId: 0, afterSequence: 3n }).done, true);
});

test('Node-API binding supports direct partition cursors and durable reopen', (t) => {
  const { directory, handle, segmentSize } = openStore(t);
  binding.append(handle, 0, Buffer.from('ui-one'), true);
  binding.append(handle, 1, Buffer.from('network-one'), true);
  binding.append(handle, 0, Buffer.from('ui-two'), true);
  binding.flush(handle);
  binding.close(handle);

  const reopened = binding.open({
    directory,
    segmentSize,
    partitionQuotas: Array(8).fill(segmentSize * 4),
  });
  const firstUi = binding.scan(reopened, { partitionId: 0 });
  const secondUi = binding.scan(reopened, firstUi.cursor);
  const end = binding.scan(reopened, secondUi.cursor);
  assert.equal(firstUi.payload.toString(), 'ui-one');
  assert.equal(secondUi.payload.toString(), 'ui-two');
  assert.equal(end.done, true);
  assert.equal(binding.status(reopened).recordCount, 3n);
  binding.close(reopened);
});

test('Node-API binding reopens a sealed segment with a short zero tail', (t) => {
  const { directory, handle, segmentSize } = openStore(t, { segmentSize: 256 });
  const almostFull = Buffer.alloc(144, 0x5a);

  binding.append(handle, 0, almostFull, true);
  binding.append(handle, 0, Buffer.from([0x7a]), true);
  assert.equal(binding.status(handle).partitions[0].segmentCount, 2n);
  binding.close(handle);

  const reopened = binding.open({
    directory,
    segmentSize,
    partitionQuotas: Array(8).fill(segmentSize * 4),
  });
  assert.equal(binding.status(reopened).recordCount, 2n);
  assert.deepEqual(binding.scan(reopened, {}).payload, almostFull);
  binding.close(reopened);
});

test('Node-API binding rejects invalid partitions and concurrent writers explicitly', (t) => {
  const { directory, handle, segmentSize } = openStore(t);
  assert.throws(
    () => binding.append(handle, 8, Buffer.from('invalid'), false),
    /partitionId must be between 0 and 7/,
  );
  assert.throws(
    () => binding.open({
      directory,
      segmentSize,
      partitionQuotas: Array(8).fill(segmentSize * 4),
    }),
    /writer|busy|lock/i,
  );
});
