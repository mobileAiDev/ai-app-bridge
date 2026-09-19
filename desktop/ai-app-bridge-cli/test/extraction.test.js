'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const host = require('../bin/execution-host');
const { createResponseStore } = require('../bin/response-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { publicReply, boundedReply, finishReply, exitCodeFor, DEFAULT_OUTPUT_BYTES } = require('../bin/public-reply');
const { prepareExtraction } = require('../bin/extraction/prepare');
const { inRequestDirectory } = require('../bin/shared-kernel/request-context');
const { createMcpClient } = require('../scripts/validation/mcp-jsonrpc-client');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-extraction-test-'));
test.after(async () => { await host.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const js = source => ({ mode: 'script', language: 'javascript', source });
const py = source => ({ mode: 'script', language: 'python', source });
function fixture(value = { ok: true, text: 'response', dispatched: true, ambiguous: false }) {
  const adapter = createMemoryEvidenceAdapter();
  const store = createResponseStore({ adapter });
  let calls = 0;
  const dependencies = { responseStore: store, factRecorder: null, observationCollector: null,
    rawRunner: async () => { calls++; return typeof value === 'function' ? value() : value; } };
  const run = async (extract, output) => (await host.run({ command: 'tap-text', extract,
    arguments: { serial: 'extraction-fixture', packageName: 'example.app', targetText: 'Save', feedback: 'off' },
    ...(output ? { output } : {}) }, dependencies)).value;
  const read = async (ref, extract, output) => (await host.run({ command: 'response', extract,
    arguments: { operation: 'read', ref }, ...(output ? { output } : {}) }, dependencies)).value;
  return { run, read, store, adapter, calls: () => calls };
}

test('semantic preflight rejects invalid source/regex before dispatch and never runs top-level source', async () => {
  const f = fixture();
  const invalid = [
    { mode: 'regex', pattern: '.', inputPath: '', flags: 'ii' },
    { mode: 'regex', pattern: '[', inputPath: '' }, { mode: 'regex', pattern: '.', inputPath: '/bad~2key' },
    { mode: 'regex', pattern: '.', inputPath: 'text' }, js('module.exports.main = }'), py('def main(:'),
    js('中'.repeat(30000)), { mode: 'script', language: 'javascript', sourcePath: 'missing-extract-source.js' },
    { ...js('module.exports.main=()=>true'), sourcePath: 'both.js' },
  ];
  for (const extract of invalid) {
    const result = await f.run(extract);
    assert.equal(result.failureStage, 'validation', JSON.stringify(result));
    assert.equal(result.execution.dispatched, false);
  }
  const marker = path.join(directory, 'top-level-must-not-run');
  prepareExtraction(js(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); module.exports.main=()=>0;`));
  prepareExtraction(py(`open(${JSON.stringify(marker)}, 'w').write('bad')\ndef main(ctx):\n return 0`));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(f.calls(), 0);
  assert.equal(f.adapter.list().length, 0);
});

test('sourcePath is relative to the caller and frozen before a provider can change it', async () => {
  const sourcePath = path.join(directory, 'frozen.js');
  fs.writeFileSync(sourcePath, 'module.exports.main=()=>"before"');
  const f = fixture(() => { fs.writeFileSync(sourcePath, 'module.exports.main=()=>"after"'); return { ok: true }; });
  const result = await inRequestDirectory(directory, () => f.run({ mode: 'script', language: 'javascript', sourcePath: 'frozen.js' }));
  assert.equal(result.value, 'before');
  assert.equal(f.calls(), 1);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'module.exports.main=()=>"after"');
});

test('both languages preserve strict JSON results and reject unsafe integers and unsupported values before serialization', async () => {
  const f = fixture();
  for (const [javascript, python, expected] of [
    ['null', 'None', null], ['false', 'False', false], ['0', '0', 0], ['"中文"', '"中文"', '中文'],
    ['[true,{x:9007199254740991,y:-9007199254740991}]', '[True,{"x":9007199254740991,"y":-9007199254740991}]', [true, { x: 9007199254740991, y: -9007199254740991 }]],
    ['"9007199254740993"', 'str(9007199254740993)', '9007199254740993'],
  ]) {
    for (const extract of [js(`module.exports.main=()=>(${javascript})`), py(`def main(ctx):\n return ${python}`)]) {
      const reply = await f.run(extract);
      assert.equal(reply.extraction.status, 'succeeded', JSON.stringify(reply));
      assert.deepEqual(reply.value, expected);
      assert.equal(exitCodeFor(reply), 0);
    }
  }
  const invalid = [
    ...['9007199254740992', '9007199254740993', '-9007199254740992', '-9007199254740993', 'NaN', 'Infinity',
      'undefined', '()=>1', '1n', 'new Date()', 'new Set()', '{ x: undefined }', 'Array(2)']
      .map(value => js(`module.exports.main=()=>(${value})`)),
    js('module.exports.main=()=>{const x={};x.self=x;return x}'),
    ...['9007199254740992', '9007199254740993', '-9007199254740992', '-9007199254740993', '10**1000',
      'float("nan")', 'float("inf")', '{1: "bad"}', '(1,2)', '{"x": [9007199254740993]}']
      .map(value => py(`def main(ctx):\n return ${value}`)),
    py('def main(ctx):\n x=[]\n x.append(x)\n return x'),
  ];
  for (const extract of invalid) {
    const reply = await f.run(extract);
    assert.equal(reply.extraction.error, 'extraction_type_error', JSON.stringify(reply));
    assert.equal(reply.execution.ok, true);
    assert.equal(exitCodeFor(reply), 2);
    assert.equal(Object.hasOwn(reply, 'value'), false);
    assert.equal(reply.control.source.persisted, true);
  }
});

test('regex handles JSON Pointer escapes, absent captures, Unicode empty matches and complete-match limits', async () => {
  const f = fixture({ ok: true, 'a/b': { '~text': 'a b' }, text: '😀' });
  const match = await f.run({ mode: 'regex', pattern: '(?<a>a)?(b)?', inputPath: '/a~1b/~0text' });
  assert.equal(match.extraction.status, 'succeeded');
  assert.deepEqual(match.value[0], { match: 'a', groups: ['a', null], namedGroups: { a: 'a' } });
  assert.deepEqual(match.value.at(-2), { match: 'b', groups: [null, 'b'], namedGroups: { a: null } });
  const empty = await f.run({ mode: 'regex', pattern: '(?:)', inputPath: '/text', flags: 'u' });
  assert.equal(empty.value.length, 2, 'advance over the astral code point, then the end');
  assert.deepEqual((await f.run({ mode: 'regex', pattern: 'missing', inputPath: '/text' })).value, []);
  for (const [inputPath, code] of [['/missing', 'extraction_path_not_found'], ['/ok', 'extraction_input_type']]) {
    const reply = await f.run({ mode: 'regex', pattern: '.', inputPath });
    assert.equal(reply.extraction.error, code);
    assert.equal(reply.control.source.persisted, true);
  }
  const many = fixture({ ok: true, text: 'x'.repeat(1001) });
  const reply = await many.run({ mode: 'regex', pattern: 'x', inputPath: '/text' });
  assert.equal(reply.extraction.error, 'extraction_match_limit');
  assert.equal(Object.hasOwn(reply, 'value'), false);
});

test('immediate and ref extraction use the identical original four fields, even after an original failure', async () => {
  const f = fixture({ ok: false, error: 'device_failed', dispatched: true, ambiguous: true,
    password: 'fixture-unchanged', _feedback: { evidence: 'final' } });
  const first = await f.run(js('module.exports.main=ctx=>ctx.inputs'));
  assert.equal(first.failureStage, 'execution');
  assert.equal(first.extraction.status, 'succeeded');
  assert.equal(first.value.response.password, 'fixture-unchanged');
  for (const extract of [js('module.exports.main=ctx=>ctx.inputs'), py('def main(ctx):\n return ctx.inputs')]) {
    const read = await f.read(first.control.source.ref, extract);
    assert.equal(read.execution.ok, true);
    assert.deepEqual(read.value, first.value);
    assert.equal(read.control.origin.execution.ambiguous, true);
  }
  const forged = await f.read(first.control.source.ref, js('module.exports.main=ctx=>{ctx.inputs.execution.ok=true;return {ok:true}}'));
  assert.equal(forged.control.origin.execution.ok, false);
  assert.equal(f.calls(), 1);
  assert.equal(f.adapter.list().length, 1);
});

test('worker throw, timeout, crash, malformed stdout and oversized output preserve action facts and allow ref-only recovery', async () => {
  const initialDirectories = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('aab-extract-')));
  const cases = [
    [js('module.exports.main=()=>{console.log("diagnostic");throw new TypeError("broken")}'), 'extraction_failed'],
    [{ ...js('module.exports.main=()=>{while(true){}}'), timeoutMs: 60 }, 'extraction_timeout'],
    [js('module.exports.main=()=>process.exit(5)'), 'extraction_worker_exited'],
    [js('module.exports.main=()=>{process.stdout.write("not-json\\n");return 1}'), 'extraction_malformed_frame'],
    [js('module.exports.main=()=>"x".repeat(300000)'), 'extraction_output_too_large'],
    [js('module.exports.main=()=>{process.stderr.write("d".repeat(200000));throw new Error("failed")}'), 'extraction_failed'],
    [py('def main(ctx):\n print("python-diagnostic")\n raise ValueError("broken")'), 'extraction_failed'],
  ];
  for (const [extract, code] of cases) {
    const f = fixture();
    const failed = await f.run(extract);
    assert.equal(failed.extraction.error, code, JSON.stringify(failed));
    assert.equal(failed.execution.ok, true);
    assert.equal(failed.execution.dispatched, true);
    assert.equal(failed.delivery.status, 'reference');
    assert.equal(failed.value, undefined);
    if (failed.extraction.diagnostics) assert(Buffer.byteLength(failed.extraction.diagnostics.stderr) <= 8192);
    const read = await f.read(failed.control.source.ref, js('module.exports.main=ctx=>ctx.inputs.response.text'));
    assert.equal(read.value, 'response');
    assert.equal(f.calls(), 1);
  }
  const f = fixture({ ok: true, text: 'x'.repeat(20000) + '!' });
  const regex = await f.run({ mode: 'regex', pattern: '(x+)+$', inputPath: '/text', timeoutMs: 60 });
  assert.equal(regex.extraction.error, 'extraction_timeout');
  assert.equal(f.calls(), 1);
  assert.deepEqual(new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('aab-extract-'))), initialDirectories);
});

test('budgets count final UTF-8 replies, preserve refs and stop incomplete control consumption', async () => {
  const f = fixture({ ok: true, text: '中'.repeat(50000), dispatched: true, ambiguous: false });
  const large = await f.run(null);
  assert.equal(large.delivery.reason, 'output_budget_exceeded');
  assert.equal(large.delivery.status, 'reference');
  assert(Buffer.byteLength(JSON.stringify(large)) <= DEFAULT_OUTPUT_BYTES);
  const small = await f.read(large.control.source.ref, js('module.exports.main=ctx=>ctx.inputs.response.text.length'), { maxBytes: 16384 });
  assert.equal(small.value, 50000);
  assert.equal(f.calls(), 1);
  const identity = await f.read(large.control.source.ref, js('module.exports.main=ctx=>ctx.inputs.response'));
  assert.equal(identity.extraction.status, 'succeeded');
  assert.equal(identity.failureStage, 'delivery');
  assert.equal(identity.value, undefined);
  const expanded = await f.read(large.control.source.ref, null, { maxBytes: 262144 });
  assert.equal(expanded.value.text.length, 50000);
  const minimal = fixture({ ok: true, executionReceipt: { large: 'x'.repeat(20000) }, dispatched: true, ambiguous: false });
  const over = await minimal.run(null, { maxBytes: 16384 });
  assert.equal(over.delivery.reason, 'control_over_budget');
  assert.equal(over.control.controlComplete, false);
  assert.equal(over.execution.dispatched, true);
  assert.equal(over.execution.ambiguous, false);
  assert(over.control.source.ref);
  assert(Buffer.byteLength(JSON.stringify(over)) <= 16384);
  const body = publicReply({ command: 'tree', reply: { value: { ok: true, text: '' } } });
  body.delivery.limitBytes = 16384;
  const overhead = Buffer.byteLength(JSON.stringify(body));
  body.value.text = 'x'.repeat(16384 - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(boundedReply(body, 16384))), 16384);
  body.value.text += 'x';
  assert.equal(boundedReply(body, 16384).delivery.status, 'unavailable');
});

test('cleanup failures preserve extraction success or the original failure without replay', async t => {
  const remove = fs.rmSync;
  const retained = new Set();
  const mock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (path.basename(file).startsWith('aab-extract-')) {
      retained.add(file);
      throw Object.assign(new Error('Injected extraction cleanup failure'), { code: 'EACCES' });
    }
    return remove(file, options);
  });
  try {
    for (const [extract, status, error] of [
      [js('module.exports.main=ctx=>ctx.inputs.response.text'), 'succeeded', undefined],
      [js('module.exports.main=()=>{throw new Error("original failure")}'), 'failed', 'extraction_failed'],
    ]) {
      const f = fixture();
      const reply = await f.run(extract);
      assert.equal(reply.extraction.status, status);
      assert.equal(reply.extraction.error, error);
      assert.equal(reply.extraction.cleanupError, 'EACCES');
      assert.equal(reply.execution.ok, true);
      assert.equal(f.calls(), 1);
      if (status === 'succeeded') {
        assert.equal(reply.value, 'response');
        assert.equal(exitCodeFor(reply), 0);
      } else {
        assert.match(reply.extraction.message, /original failure/);
        assert.equal(reply.failureStage, 'extraction');
      }
    }
  } finally {
    mock.mock.restore();
    for (const file of retained) remove(file, { recursive: true, force: true });
  }
  const next = await fixture().run(js('module.exports.main=()=>42'));
  assert.equal(next.value, 42, 'cleanup failure must release the extraction worker slot');
  assert.equal(next.extraction.cleanupError, undefined);
});

test('storage failure is independent from small extraction success and offline local extraction does not start a Runtime', async () => {
  const body = publicReply({ command: 'tree', reply: { value: { ok: true, data: 'x'.repeat(180000) } } });
  const result = await finishReply({ body, extract: prepareExtraction(js('module.exports.main=()=>null')),
    getStore: () => createResponseStore({ adapter: createMemoryEvidenceAdapter({ fault: 'enospc' }) }) });
  assert.equal(result.value, null);
  assert.equal(result.control.source.persisted, false);
  assert.equal(result.control.source.error, 'ENOSPC');
  assert.equal(result.control.source.ref, undefined);
  assert.equal(exitCodeFor(result), 0);
  const runtimeHome = path.join(directory, 'offline-runtime');
  const stdout = execFileSync(process.execPath, [path.resolve(__dirname, '../bin/ai-app-bridge.js'), 'runtime', '--operation', 'status',
    '--extract', JSON.stringify(js('module.exports.main=ctx=>ctx.inputs.response.status'))], { encoding: 'utf8',
    env: { ...process.env, AI_APP_BRIDGE_RUNTIME_HOME: runtimeHome, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'offline-facts') } });
  const reply = JSON.parse(stdout);
  assert.equal(reply.value, 'stopped');
  assert.equal(reply.control.source.reason, 'offline');
  assert.equal(fs.existsSync(path.join(runtimeHome, 'endpoint.json')), false);
});

test('serialization errors and unsupported binary extraction preserve known execution and never replay', async () => {
  const cycle = { ok: true, dispatched: true, ambiguous: false }; cycle.self = cycle;
  for (const value of [cycle, { ok: true, dispatched: true, data: 1n }]) {
    const f = fixture(value);
    const reply = await f.run(null);
    assert.equal(reply.failureStage, 'delivery');
    assert.equal(reply.delivery.reason, 'response_serialization_failed');
    assert.equal(reply.execution.ok, true);
    assert.equal(reply.execution.dispatched, true);
    assert.equal(f.calls(), 1);
    assert.doesNotThrow(() => JSON.stringify(reply));
  }
  const binary = fixture(Buffer.from([0, 255]));
  const result = await binary.run(js('module.exports.main=()=>1'));
  assert.equal(result.extraction.error, 'extraction_binary_unsupported');
  assert.equal(result.execution.ok, true);
  assert.equal(result.control.source.ref, undefined);
});

test('real MCP concurrent extraction admits two workers, returns busy for the third and recovers by ref', { timeout: 20000 }, async () => {
  const release = path.join(directory, 'release');
  const env = { ...process.env, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'mcp-facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'mcp-runtime') };
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'), env,
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'mcp.stderr') });
  const request = async (command, args, extract) => JSON.parse((await client.request('tools/call', {
    name: 'run', arguments: { command, arguments: args, extract },
  })).result.content[0].text);
  try {
    await client.initialize();
    const markers = [1, 2].map(i => path.join(directory, `active-${i}`));
    const pending = markers.map(marker => request('script', { operation: 'runtime-status' }, {
      ...js(`module.exports.main=async ctx=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ready');
        while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));return true}`), timeoutMs: 10000,
    }));
    const deadline = Date.now() + 6000;
    while (!markers.every(marker => fs.existsSync(marker)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(markers.every(marker => fs.existsSync(marker)), 'both workers must actually be active');
    const busy = await request('script', { operation: 'runtime-status' }, js('module.exports.main=()=>3'));
    assert.equal(busy.extraction.error, 'extraction_busy', JSON.stringify(busy));
    assert.equal(busy.execution.ok, true);
    assert.equal(busy.control.source.persisted, true);
    fs.writeFileSync(release, 'done');
    const first = await Promise.all(pending);
    assert(first.every(reply => reply.value === true));
    const read = await request('response', { operation: 'read', ref: busy.control.source.ref }, js('module.exports.main=()=>3'));
    assert.equal(read.value, 3);
    assert.equal(read.control.source.ref.evidenceId, busy.control.source.ref.evidenceId);
  } finally { fs.writeFileSync(release, 'done'); await client.close(); }
});

test('a descendant holding inherited pipes cannot extend worker completion or timeout', { timeout: 7000 }, async () => {
  const { runExtraction } = require('../bin/extraction/runner');
  for (const finish of ['return true', 'while(true){}']) {
    const pidPath = path.join(directory, `descendant-${finish.length}.pid`);
    const source = `module.exports.main=()=>{const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'inherit'});
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); ${finish}}`;
    const started = Date.now();
    try {
      const result = await runExtraction(prepareExtraction({ ...js(source), timeoutMs: 200 }), { kind: 'json', response: {}, execution: {}, control: {} });
      assert(Date.now() - started < 2000, 'worker lifecycle must not await descendant pipe EOF');
      assert.equal(result.ok, finish.startsWith('return'));
      if (!result.ok) assert.equal(result.error, 'extraction_timeout');
    } finally {
      if (fs.existsSync(pidPath)) { try { process.kill(Number(fs.readFileSync(pidPath)), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
  }
});
