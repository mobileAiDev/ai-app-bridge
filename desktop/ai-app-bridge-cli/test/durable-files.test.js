'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { durableCreate, durableRename, durableRemove, durableCreateDirectory } = require('../bin/shared-kernel/durable-files');
const { atomicJson } = require('../bin/executors/managed-runtime');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-durable-'));
  const root = path.join(directory, '中文 app & records');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return root;
}

test('durable JSON publication replaces the same Unicode path and preserves other records', t => {
  const directory = fixture(t), file = path.join(directory, '当前.json');
  const other = path.join(directory, 'other.json');
  durableCreate(other, 'other owner');
  atomicJson(file, { actionId: '原动作', phase: 'pending' });
  atomicJson(file, { actionId: '原动作', phase: 'settled' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { actionId: '原动作', phase: 'settled' });
  assert.equal(fs.readFileSync(other, 'utf8'), 'other owner');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['other.json', '当前.json']);
});

test('exclusive evidence publication cannot replace an existing claim', t => {
  const directory = fixture(t), file = path.join(directory, 'recording.json');
  durableCreate(file, 'first recording');
  assert.throws(() => durableCreate(file, 'replacement'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'first recording');
  assert.deepEqual(fs.readdirSync(directory), ['recording.json']);
});

test('archive rename and explicit deletion affect only the selected name', t => {
  const directory = fixture(t), archive = path.join(directory, '归档');
  durableCreateDirectory(archive);
  const original = path.join(directory, 'owner.json'), other = path.join(directory, 'other.json');
  durableCreate(original, 'original bytes'); durableCreate(other, 'different owner');
  const moved = path.join(archive, 'owner.json');
  durableRename(original, moved);
  assert.equal(fs.existsSync(original), false);
  assert.equal(fs.readFileSync(moved, 'utf8'), 'original bytes');
  durableRemove(moved);
  assert.equal(fs.existsSync(moved), false);
  assert.equal(fs.readFileSync(other, 'utf8'), 'different owner');
  assert.deepEqual(fs.readdirSync(archive), []);
  assert.throws(() => durableRemove(moved), { code: 'ENOENT' });
});

test('a missing rename source reports failure without changing the destination', t => {
  const directory = fixture(t), destination = path.join(directory, 'destination');
  durableCreate(destination, 'must survive');
  assert.throws(() => durableRename(path.join(directory, 'missing'), destination), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'must survive');
});

test('acknowledged publication survives writer process death and can be replaced by a new writer', { timeout: 15000 }, async t => {
  const directory = fixture(t), file = path.join(directory, 'owner.json');
  const worker = path.join(directory, 'writer.cjs');
  fs.writeFileSync(worker, `const { atomicJson } = require(${JSON.stringify(require.resolve('../bin/executors/managed-runtime'))});
atomicJson(process.argv[2], { actionId: 'never-replay', phase: 'pending' });
process.send('committed');
setInterval(() => {}, 1000);\n`);
  const child = fork(worker, [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.deepEqual(await once(child, 'message'), ['committed', undefined]);
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { actionId: 'never-replay', phase: 'pending' });
  atomicJson(file, { actionId: 'never-replay', phase: 'unknown' });
  assert.equal(JSON.parse(fs.readFileSync(file)).phase, 'unknown');
});
