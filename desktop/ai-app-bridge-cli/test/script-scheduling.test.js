'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createScriptSessionChannel } = require('../bin/script/script-session-channel');
const { createNodeRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { createPythonRuntimeAdapter } = require('../bin/script/python-runtime-adapter');

function run(runtime, source, overrides = {}) {
  return runtime.start({
    spec: { source, inputs: {}, entrypoint: 'main', policy: { timeoutMs: 10000, maxOutputBytes: 131072, maxProgressBytes: 4096 } },
    host: { call: async () => ({ ok: true }), assert: async () => ({ verdict: 'passed' }) },
    agent: { askAgent: async () => ({ decision: true }) },
    emit() {}, control: () => ({ status: 'running' }), ...overrides,
  });
}

test('IPC backpressure drains a burst and EOF without losing ordered frames', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const channel = createScriptSessionChannel(child, { maxFrameBytes: 128 });
  const frames = Array.from({ length: 1000 }, (_, i) => ({ type: 'progress', event: i }));
  frames.push({ type: 'return', result: 'complete' });
  child.stdout.end(frames.map(frame => JSON.stringify(frame) + '\n').join(''));
  assert.equal(child.stdout.isPaused(), true);
  for (const frame of frames) assert.deepEqual(await channel.nextMessage(), frame);
  assert.equal((await channel.nextMessage()).error, 'channel_closed');
  channel.stop();
});

test('256 concurrent reads queue beyond the IPC window and actually overlap without replay', async () => {
  let active = 0, maximum = 0, firstBatch;
  const barrier = new Promise(resolve => { firstBatch = resolve; });
  const seen = [];
  const result = await run(createNodeRuntimeAdapter(), `module.exports.main = ctx => Promise.all(
    Array.from({ length: 256 }, (_, i) => ctx.call('status', { i })));`, {
    host: { call: async (_, { i }) => {
      seen.push(i); maximum = Math.max(maximum, ++active);
      if (active === 32) firstBatch();
      await barrier;
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { ok: true, i };
    } },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(maximum, 32);
  assert.deepEqual(seen, Array.from({ length: 256 }, (_, i) => i));
  assert.deepEqual(result.result.map(item => item.i), seen);
});

test('writes and checkpoints preserve boundaries around parallel reads', async () => {
  const events = [], reads = new Set();
  let bothStarted;
  const barrier = new Promise(resolve => { bothStarted = resolve; });
  const result = await run(createNodeRuntimeAdapter(), `module.exports.main = async ctx => {
    const calls = [ctx.call('status', {i:0}), ctx.call('status', {i:1}),
      ctx.call('tap-native', {i:2}), ctx.call('status', {i:3}), ctx.checkpoint('saved', {i:4}),
      ctx.call('tap-native', {i:5}), ctx.assert({name:'end'})];
    await Promise.all(calls); return 'done';
  };`, {
    host: {
      call: async (command, { i }) => {
        events.push(`start-${i}`);
        if (i < 2) { reads.add(i); if (reads.size === 2) bothStarted(); await barrier; }
        else if (command === 'tap-native') assert.equal(reads.size, 0);
        reads.delete(i); events.push(`end-${i}`); return { ok: true };
      },
      assert: async () => { events.push('assert'); return { verdict: 'passed' }; },
    },
    emit(type) { if (type === 'checkpoint') { events.push('checkpoint'); return { ok: true, persisted: true }; } },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(events.slice(0, 2), ['start-0', 'start-1']);
  assert.deepEqual(events.slice(4), ['start-2', 'end-2', 'start-3', 'end-3', 'checkpoint', 'start-5', 'end-5', 'assert']);
});

test('unawaited queued calls and progress settle before a successful Script return', async () => {
  const calls = [], progress = [];
  const result = await run(createNodeRuntimeAdapter(), `module.exports.main = ctx => {
    for (let i = 0; i < 200; i++) { ctx.call('status', {i}); ctx.progress({i}); }
    return 'accepted';
  };`, {
    host: { call: async (_, { i }) => { calls.push(i); return { ok: true }; } },
    emit(type, value) { if (type === 'progress') progress.push(value.i); },
  });
  assert.deepEqual(result, { ok: true, result: 'accepted' });
  assert.equal(calls.length, 200); assert.equal(progress.length, 200);
  assert.deepEqual(calls, progress);
});

test('a caller can handle an unserializable request and continue without an unhandled SDK rejection', async () => {
  let calls = 0;
  const result = await run(createNodeRuntimeAdapter(), `module.exports.main = async ctx => {
    let caught = false;
    try { await ctx.call('status', {bad:1n}); } catch { caught = true; }
    const next = await ctx.call('status', {}); return {caught, next};
  };`, { host: { call: async () => { calls++; return { ok: true }; } } });
  assert.deepEqual(result, { ok: true, result: { caught: true, next: { ok: true } } });
  assert.equal(calls, 1);
});

test('repeated paused replies do not spin the child event loop or lose queued work', async () => {
  const adapter = createNodeRuntimeAdapter();
  let state = { status: 'running' }, release, entered = 0;
  const held = new Promise(resolve => { release = resolve; });
  const result = await run(adapter, `module.exports.main = ctx => Promise.all(
    Array.from({length:64}, (_,i) => ctx.call('status', {i})));`, {
    control: () => state,
    host: { call: async (_, { i }) => {
      if (++entered === 32) {
        state = { status: 'paused_manual' }; adapter.setControl(state); release();
        setTimeout(() => { adapter.setControl(state); }, 20);
        setTimeout(() => {
          assert.equal(entered, 32); state = { status: 'running' }; adapter.setControl(state);
        }, 50);
      }
      await held; return { ok: true, i };
    } },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(entered, 64); assert.equal(result.result.length, 64);
});

for (const [language, runtime, source] of [
  ['javascript', createNodeRuntimeAdapter, `module.exports.main = async ctx => {
    await ctx.call('status', {i:0}); await ctx.call('tap-native', {i:1});
    await ctx.progress({done:true}); return 'done'; };`],
  ['python', createPythonRuntimeAdapter, `def main(ctx):
    ctx.call('status', {'i':0})
    ctx.call('tap-native', {'i':1})
    ctx.progress({'done':True})
    return 'done'
`],
]) test(`${language} holds the next command while paused and resumes without replay`, async () => {
  const adapter = runtime(), calls = [];
  let state = { status: 'running' }, resume;
  const resumed = new Promise(resolve => { resume = resolve; });
  const result = await run(adapter, source, {
    control: () => state,
    host: { call: async (_, { i }) => {
      calls.push(i);
      if (i === 0) {
        state = { status: 'paused_manual' }; adapter.setControl(state);
        setTimeout(() => {
          assert.deepEqual(calls, [0]);
          state = { status: 'running' }; adapter.setControl(state); resume();
        }, 40);
      } else await resumed;
      return { ok: true };
    } },
  });
  assert.deepEqual(result, { ok: true, result: 'done' });
  assert.deepEqual(calls, [0, 1]);
});
