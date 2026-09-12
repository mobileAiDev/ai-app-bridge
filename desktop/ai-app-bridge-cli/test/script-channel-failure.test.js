'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createScriptSessionChannel } = require('../bin/script/script-session-channel');
const { createNodeRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { createPythonRuntimeAdapter } = require('../bin/script/python-runtime-adapter');

test('a terminal frame failure remains available to late readers and discards queued calls', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const channel = createScriptSessionChannel(child, { maxFrameBytes: 100 });
  child.stdout.write('{"type":"call","command":"tap-native"}\n');
  channel.send({ type: 'result', value: 'x'.repeat(101) });
  child.stdout.end();
  assert.deepEqual(await channel.nextMessage(), { type: 'fail', error: 'frame_too_large' });
  assert.deepEqual(await channel.nextMessage(), { type: 'fail', error: 'frame_too_large' });
  assert.deepEqual(await channel.waitReply('late'), { type: 'fail', error: 'frame_too_large' });
  channel.stop();
});

for (const [language, makeRuntime, source] of [
  ['javascript', createNodeRuntimeAdapter, 'module.exports.main = async ctx => { await ctx.call("events", {}); await ctx.call("tap-native", {}); };'],
  ['python', createPythonRuntimeAdapter, 'def main(ctx):\n    ctx.call("events", {})\n    ctx.call("tap-native", {})\n'],
]) {
  test(`${language} reports an oversized Host result without replay or a false child-crash error`, async () => {
    const runtime = makeRuntime(), calls = [];
    const result = await runtime.start({
      spec: { source, inputs: {}, entrypoint: 'main', policy: { timeoutMs: 5000, maxOutputBytes: 65536, maxProgressBytes: 4096 } },
      host: { call: async command => { calls.push(command); return { ok: true, result: { items: [{ message: 'x'.repeat(2 * 1024 * 1024) }] } }; } },
      agent: { askAgent: async () => { throw Error('unexpected Agent request'); } },
      emit() {}, control: () => ({ status: 'running' }),
    });
    assert.deepEqual(result, { ok: false, error: 'frame_too_large' });
    assert.deepEqual(calls, ['events']);
  });
}
