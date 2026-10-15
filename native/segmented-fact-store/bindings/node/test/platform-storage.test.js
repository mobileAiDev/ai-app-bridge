'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const binding = require('../../../index');
const root = path.resolve(__dirname, '../../..');

function directory(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfs-platform-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
function options(directory, segmentSize = 512, segments = 4) {
  return { directory, segmentSize, partitionQuotas: Array(8).fill(segmentSize * segments) };
}
function records(handle, cursor = {}) {
  const result = [];
  for (;;) {
    const item = binding.scan(handle, cursor);
    if (item.done) return result;
    result.push(item);
    cursor = item.cursor;
  }
}
function segment(directory, partition = 0, id = 1) {
  return path.join(directory, `partition-${partition}`, `segment-${String(id).padStart(20, '0')}.sfs`);
}
function writeAt(file, bytes, position) {
  const fd = fs.openSync(file, 'r+');
  try { fs.writeSync(fd, bytes, 0, bytes.length, position); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function syncWrite(file, text) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

test('UTF-8, spaces and long paths preserve data across rotation and reopen', t => {
  const base = directory(t);
  const storePath = path.join(base, '资料 空间 🧪', ...Array(8).fill('long-path-component-资料123456'));
  assert.ok(storePath.length > 260);
  fs.mkdirSync(storePath, { recursive: true });
  const config = options(storePath, 512, 64);
  let handle = binding.open(config);
  const expected = [];
  try {
    for (let index = 0; index < 240; index++) {
      const payload = Buffer.from(JSON.stringify({ index, text: '测试 / 日本語 / café / 🧪', content: 'x'.repeat(80) }));
      const receipt = binding.append(handle, index % 8, payload, true);
      expected.push({ sequence: BigInt(index + 1), partition: index % 8, payload });
      assert.equal(receipt.sequence, BigInt(index + 1));
    }
    binding.close(handle);
    handle = binding.open(config);
    const actual = records(handle);
    assert.equal(actual.length, expected.length);
    actual.forEach((item, i) => {
      assert.equal(item.record.sequence, expected[i].sequence);
      assert.equal(item.record.partitionId, expected[i].partition);
      assert.deepEqual(item.payload, expected[i].payload);
    });
    assert.ok(binding.status(handle).segmentCount > 8n);
  } finally { binding.close(handle); }
});

test('C v1 golden store reads without translating format or payload bytes', t => {
  const storePath = directory(t);
  const golden = path.join(root, 'tests/golden/v1');
  fs.cpSync(golden, storePath, { recursive: true });
  const expected = JSON.parse(fs.readFileSync(path.join(golden, 'expected.json')));
  const config = { directory: storePath, segmentSize: expected.segmentSize,
    partitionQuotas: Array.from({ length: 8 }, (_, p) => expected.partitions[p]?.quotaBytes || 0) };
  const handle = binding.open(config);
  try {
    assert.deepEqual(records(handle).map(item => Number(item.record.sequence)), expected.globalSequenceOrder);
    for (const [partition, value] of Object.entries(expected.partitions)) {
      const actual = records(handle, { partitionId: Number(partition) });
      assert.equal(actual.length, value.records.length);
      actual.forEach((item, i) => {
        const record = value.records[i];
        assert.equal(item.record.sequence, BigInt(record.sequence));
        assert.equal(item.record.segmentId, BigInt(record.segmentId));
        assert.equal(item.record.frameOffset, BigInt(record.frameOffset));
        assert.equal(item.payload.toString('hex'), record.payloadHex);
      });
    }
  } finally { binding.close(handle); }
});

test('a second process cannot acquire an existing writer lock', t => {
  const config = options(directory(t));
  const handle = binding.open(config);
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const b = require(${JSON.stringify(root)});
      try { const h = b.open(${JSON.stringify(config)}); b.close(h); process.exitCode = 2; }
      catch (e) { if (e.code !== 'sfs_busy') throw e; console.log(e.code); }
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'sfs_busy');
  } finally { binding.close(handle); }
});

test('terminating a writer releases its lock and preserves completed SYNC receipts', async t => {
  const base = directory(t);
  const storePath = path.join(base, 'store');
  const config = options(storePath);
  const childFile = path.join(base, 'writer.cjs');
  fs.writeFileSync(childFile, `
    const b = require(${JSON.stringify(root)});
    const h = b.open(${JSON.stringify(config)});
    const receipt = b.append(h, 0, Buffer.from('committed-before-process-termination'), true);
    process.send({ sequence: String(receipt.sequence) });
    setInterval(() => {}, 1000);
  `);
  const child = fork(childFile, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const message = await Promise.race([
    once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(([code]) => { throw new Error(`writer exited ${code}: ${stderr}`); }),
  ]);
  assert.equal(message.sequence, '1');
  assert.throws(() => binding.open(config), { code: 'sfs_busy' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const handle = binding.open(config);
  try {
    assert.deepEqual(records(handle).map(item => item.payload.toString()), ['committed-before-process-termination']);
    assert.equal(binding.append(handle, 0, Buffer.from('next'), true).sequence, 2n);
  } finally { binding.close(handle); }
});

test('a truncated active tail recovers without reusing a previously allocated sequence', t => {
  const config = options(directory(t));
  let handle = binding.open(config);
  binding.append(handle, 0, Buffer.from('first'), true);
  const second = binding.append(handle, 0, Buffer.from('second'), true);
  binding.close(handle);
  fs.truncateSync(segment(config.directory), Number(second.frameOffset) + 25);
  handle = binding.open(config);
  try {
    assert.deepEqual(records(handle).map(item => item.payload.toString()), ['first']);
    assert.equal(binding.status(handle).flags & 1, 1);
    assert.equal(binding.append(handle, 0, Buffer.from('after-recovery'), true).sequence, 3n);
    assert.equal(fs.statSync(segment(config.directory)).size, 512);
  } finally { binding.close(handle); }
});

test('committed corruption and a torn sealed segment remain hard errors', t => {
  const base = directory(t);
  for (const kind of ['committed-payload', 'sealed-tail']) {
    const config = options(path.join(base, kind), 256);
    const handle = binding.open(config);
    const first = binding.append(handle, 0, Buffer.alloc(144, 0x41), true);
    if (kind === 'sealed-tail') binding.append(handle, 0, Buffer.from('next-segment'), true);
    binding.close(handle);
    writeAt(segment(config.directory), Buffer.from([0x5a]),
      kind === 'committed-payload' ? Number(first.frameOffset) + 24 : 255);
    assert.throws(() => binding.open(config), { code: 'sfs_corrupt' });
  }
});

test('interrupted creation is discarded and an older committed manifest slot remains usable', t => {
  const config = options(directory(t));
  let handle = binding.open(config);
  binding.append(handle, 0, Buffer.from('retained'), true);
  binding.close(handle);
  const temporary = path.join(config.directory, 'partition-0', '.segment-00000000000000000002.creating');
  syncWrite(temporary, 'partial segment');
  const manifest = path.join(config.directory, '.sfs-manifest');
  const bytes = fs.readFileSync(manifest);
  const newest = bytes.readBigUInt64LE(16) > bytes.readBigUInt64LE(528) ? 0 : 512;
  writeAt(manifest, Buffer.alloc(8), newest + 504);
  handle = binding.open(config);
  try {
    assert.equal(fs.existsSync(temporary), false);
    assert.deepEqual(records(handle).map(item => item.payload.toString()), ['retained']);
    assert.equal(binding.append(handle, 0, Buffer.from('next'), true).sequence, 2n);
  } finally { binding.close(handle); }
});

test('durableRename publishes exact flushed bytes and preserves explicit collision semantics', t => {
  const base = directory(t);
  const source = path.join(base, '临时 🧪');
  const destination = path.join(base, '最终 文件');
  syncWrite(source, 'v1');
  binding.durableRename(source, destination, false);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'v1');
  syncWrite(source, 'v2');
  assert.throws(() => binding.durableRename(source, destination, false),
    error => error.code === 'EEXIST' && Number.isInteger(error.systemCode));
  assert.equal(fs.readFileSync(source, 'utf8'), 'v2');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'v1');
  binding.durableRename(source, destination);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'v2');
  assert.throws(() => binding.durableRename(source, destination),
    error => error.code === 'ENOENT' && Number.isInteger(error.systemCode));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'v2');
});

test('publication failures and invalid path strings do not silently choose another destination', t => {
  const base = directory(t);
  const source = path.join(base, 'source');
  const existingDirectory = path.join(base, 'directory');
  fs.mkdirSync(existingDirectory);
  syncWrite(source, 'exact bytes');
  assert.throws(() => binding.durableRename(source, existingDirectory),
    error => error.code === 'native_durable_rename_failed' && Number.isInteger(error.systemCode));
  assert.equal(fs.readFileSync(source, 'utf8'), 'exact bytes');
  assert.equal(fs.statSync(existingDirectory).isDirectory(), true);
  assert.throws(() => binding.durableRename(source, source + '\0different'), /NUL/);
  assert.throws(() => binding.open(options(base + '\0different')), /NUL/);
  assert.throws(() => binding.durableRename(source, path.join(base, 'new'), 'true'), /boolean/);
});
