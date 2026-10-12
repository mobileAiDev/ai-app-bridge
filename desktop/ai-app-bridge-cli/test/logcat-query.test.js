'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { filterLogcat, queryLogcat } = require('../bin/shared-kernel/logcat-query');
const { validateCommandArguments } = require('../bin/command-registry');
const { publicReply } = require('../bin/public-reply');
const { executeProviderCommand } = require('../bin/device-provider');

const lines = [
  '10-12 09:00:00.001  123  123 I Print: Receipt rendered',
  '10-12 09:00:00.002  456  456 E Upload: Receipt ignored from other process',
  '10-12 09:00:00.003  123  123 E Upload: Request failed',
  '  java.io.IOException: TimeoutException',
  '    at Upload.send(Upload.java:42)',
  '10-12 09:00:00.004  123  123 D Debug: unrelated',
];

test('literal grep remains literal; explicit regex combines with PID, tag and level filters', async () => {
  assert.equal(filterLogcat(lines.join('\n'), { grep: 'Receipt|Request' }), '');
  const result = await queryLogcat(lines.join('\n'), { grep: 'receipt|request', grepMode: 'regex', pid: '123', tag: 'Print,Upload', level: 'I' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, [lines[0], ...lines.slice(2, 5)].join('\n'));
  assert.equal((await queryLogcat(lines[0], { grep: 'receipt', grepMode: 'regex', grepCaseSensitive: true })).text, '');
});

test('raw text is filterable and a stack-trace match includes its header without leaking another PID', async () => {
  assert.equal(filterLogcat('Receipt A\nRequest B\nUnrelated\n', { format: 'raw', grep: 'Request' }), 'Request B');
  assert.equal(filterLogcat('Receipt A\nRequest B\n', { format: 'raw' }), 'Receipt A\nRequest B');
  assert.equal(filterLogcat(lines.join('\n'), { grep: 'TimeoutException', pid: '123' }), lines.slice(2, 5).join('\n'));
  assert.equal(filterLogcat(lines.join('\n'), { grep: 'TimeoutException', pid: '456' }), '');
  const unsupported = await queryLogcat('Receipt A', { format: 'raw', tag: 'Print' });
  assert.equal(unsupported.error, 'logcat_format_not_filterable');
  assert.equal(unsupported.text, 'Receipt A'); assert.equal(unsupported.filterApplied, false);
  assert.equal((await queryLogcat(lines.join('\n'), { appPid: true, pid: '' })).error, 'logcat_app_pid_unavailable');
});

test('a pathological regex times out off the Host event loop and retains the captured text', async () => {
  const raw = 'a'.repeat(100) + '!'; let ticked = false;
  const tick = setTimeout(() => { ticked = true; }, 40);
  const result = await queryLogcat(raw, { format: 'raw', grepMode: 'regex', grep: '^(a+)+$' });
  clearTimeout(tick);
  assert.equal(ticked, true); assert.equal(result.error, 'logcat_filter_failed');
  assert.equal(result.cause, 'extraction_timeout'); assert.equal(result.text, raw); assert.equal(result.filterApplied, false);
});

test('empty literal expression and format errors get executable read-only hints, ordinary empties do not', () => {
  const args = { serial: 'fake-logcat', grep: 'Print|Upload', clear: true, requestId: 'original-clear' };
  const reply = publicReply({ command: 'logcat', args, reply: { value: { ok: true, text: '', dispatched: true } } });
  const next = reply.control.guidance.nextActions[0];
  assert.equal(next.arguments.grepMode, 'regex'); assert.equal(next.arguments.clear, false);
  assert.equal(next.arguments.requestId, undefined); validateCommandArguments(next.command, next.arguments);
  assert.equal(reply.execution.dispatched, true);
  assert.equal(publicReply({ command: 'logcat', args: { grep: 'ordinary' }, reply: { value: '' }, completed: true }).control.guidance, undefined);
  const format = publicReply({ command: 'logcat', args: { tag: 'Print', format: 'raw' },
    reply: { value: { ok: false, error: 'logcat_format_not_filterable', text: 'kept', message: 'Use threadtime.' } } });
  assert.equal(format.control.guidance.nextActions[0].arguments.format, 'threadtime');
});

test('invalid regex fails before ADB or log clearing; valid regex performs exactly one read', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-logcat-query-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = path.join(directory, 'calls.jsonl'), adb = path.join(directory, 'adb');
  fs.writeFileSync(adb, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.stdout.write(${JSON.stringify(lines.join('\n'))});\n`, { mode: 0o700 });
  const args = { serial: 'fake-logcat', adb, grepMode: 'regex', grep: '[' };
  assert.throws(() => validateCommandArguments('logcat', { ...args, clear: true }), { code: 'invalid_argument', field: 'grep' });
  await assert.rejects(executeProviderCommand('logcat', { ...args, clear: true }), { code: 'invalid_argument' });
  assert.equal(fs.existsSync(calls), false);
  const result = await executeProviderCommand('logcat', { ...args, grep: 'receipt|request', pid: 123 });
  assert.equal(result, [lines[0], ...lines.slice(2, 5)].join('\n'));
  const requests = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.length, 1); assert.equal(requests[0].includes('-c'), false);
});
