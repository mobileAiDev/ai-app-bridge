#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const executeFile = promisify(execFile);

const PACKAGE = 'org.localsend.localsend_app.debug';
const MODES = ['plain-js', 'script'];
const EXPECTATION = Object.freeze({
  openLabel: '在浏览器中打开其中一个链接：',
  homeLabels: ['通过链接接收', '接收', '发送', '设置'],
});
const NEGATIVE_EXPECTATION = Object.freeze({ ...EXPECTATION, openLabel: '故意错误的页面期望-AAB-NOT-PRESENT-7B329A' });
const SERVER = path.resolve(__dirname, '../../bin/mcp-server.js');
const SCRIPT_SOURCE = `'use strict';
const fs = require('node:fs');
module.exports.main = async ctx => {
  const rows = [];
  for (const step of ctx.inputs.steps) {
    const started = Date.now();
    let response;
    try { response = await ctx.call(step.command, step.arguments); }
    catch (error) { response = { ok: false, error: error.message || String(error), result: null }; }
    rows.push({ id: step.id, command: step.command, ok: response.ok !== false, error: response.error || null, durationMs: Date.now() - started, result: response.result, hostEnvelope: response });
    fs.writeFileSync(ctx.inputs.rowsPath, JSON.stringify(rows, null, 2));
    if (response.ok === false) break;
  }
  return { rowsPath: ctx.inputs.rowsPath, completedSteps: rows.length };
};
`;

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function normal(text) { return String(text).replace(/[\s:：]/gu, ''); }
function textsOf(nodes) {
  if (!nodes || !Array.isArray(nodes.nodes)) return null;
  return nodes.nodes.map((node) => node.text).filter((text) => typeof text === 'string');
}
function includesLabel(texts, label) { return texts.some((text) => normal(text).includes(normal(label))); }
function hasHomeLabel(texts, label, source, expectation) {
  if (texts.some((text) => normal(text) === normal(label))) return true;
  // OCR can group the bottom navigation into a single line; require the entire line.
  return source === 'screenshot-ocr' && expectation.homeLabels.slice(1).includes(label)
    && texts.some((text) => normal(text) === normal(expectation.homeLabels.slice(1).join('')));
}

// This oracle is outside both execution modes and never reads Script's verdict.
function evaluateOracle(evidence, expectation = EXPECTATION) {
  const checks = [];
  for (const [phase, opened] of [['before', false], ['opened', true], ['returned', false]]) {
    const snapshot = evidence[phase];
    const nodeTexts = textsOf(snapshot?.nodes);
    const screenshot = snapshot?.screenshot;
    if (!nodeTexts || !screenshot?.validPng || !screenshot.sha256 || screenshot.foregroundPackageName !== PACKAGE) {
      checks.push({ phase, verdict: 'inconclusive', reason: 'missing_or_wrong_target_dual_evidence' });
      continue;
    }
    if (screenshot.ocr?.status !== 'ok' || !Array.isArray(screenshot.ocr.texts) || !screenshot.ocr.texts.length) {
      checks.push({ phase, verdict: 'inconclusive', reason: 'screenshot_ocr_unavailable' });
      continue;
    }
    for (const [source, texts] of [['flutter-nodes', nodeTexts], ['screenshot-ocr', screenshot.ocr.texts]]) {
      const missing = opened
        ? (includesLabel(texts, expectation.openLabel) ? [] : [expectation.openLabel])
        : expectation.homeLabels.filter((label) => !hasHomeLabel(texts, label, source, expectation));
      const unexpected = !opened && includesLabel(texts, expectation.openLabel);
      checks.push({ phase, source, verdict: missing.length || unexpected ? 'failed' : 'passed', missing, unexpectedOpenLabel: unexpected });
    }
  }
  const verdict = checks.some((item) => item.verdict === 'failed') ? 'failed'
    : checks.some((item) => item.verdict === 'inconclusive') ? 'inconclusive' : 'passed';
  return { verdict, checks };
}

function buildSteps(target, directory) {
  const command = (id, name, args = {}) => ({ id, command: name, arguments: { ...target, feedback: 'off', ...args } });
  const homeWait = { targetText: EXPECTATION.homeLabels[0], requireText: ['接收', '发送', '设置'], absentText: [EXPECTATION.openLabel], provider: 'flutter', timeoutMs: 12000, intervalMs: 250 };
  return [
    command('before-wait', 'wait-text', homeWait),
    command('before-screenshot', 'screenshot', { outFile: path.join(directory, 'before.png') }),
    command('before-nodes', 'flutter-nodes'),
    command('open', 'tap-flutter-text', { targetText: '通过链接接收' }),
    command('opened-wait', 'wait-text', { targetText: EXPECTATION.openLabel, provider: 'flutter', timeoutMs: 12000, intervalMs: 250 }),
    command('opened-screenshot', 'screenshot', { outFile: path.join(directory, 'opened.png') }),
    command('opened-nodes', 'flutter-nodes'),
    command('back', 'tap-flutter-text', { targetText: '返回' }),
    command('returned-wait', 'wait-text', homeWait),
    command('returned-screenshot', 'screenshot', { outFile: path.join(directory, 'returned.png') }),
    command('returned-nodes', 'flutter-nodes'),
  ];
}

function schedule(rounds) {
  return Array.from({ length: rounds }, (_, round) => MODES.map((_, offset) => ({ round: round + 1, mode: MODES[(round + offset) % MODES.length] }))).flat();
}
async function mcpRun(client, command, args, timeoutMs) {
  return payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }, timeoutMs));
}

async function prepareHome(client, target) {
  const nodes = await mcpRun(client, 'flutter-nodes', { ...target, feedback: 'off' });
  const texts = textsOf(nodes);
  if (!texts) return { ok: false, error: 'preparation_nodes_unavailable', nodes };
  const open = includesLabel(texts, EXPECTATION.openLabel);
  let back = null;
  if (open) {
    back = await mcpRun(client, 'tap-flutter-text', { ...target, feedback: 'off', targetText: '返回' });
    if (back.ok === false) return { ok: false, error: 'preparation_back_failed', nodes, back };
  } else if (!EXPECTATION.homeLabels.every((label) => includesLabel(texts, label))) {
    return { ok: false, error: 'unrecognized_starting_page', nodes };
  }
  const ready = await mcpRun(client, 'wait-text', {
    ...target, feedback: 'off', targetText: EXPECTATION.homeLabels[0],
    requireText: ['接收', '发送', '设置'], absentText: [EXPECTATION.openLabel], provider: 'flutter', timeoutMs: 12000, intervalMs: 250,
  });
  return { ok: ready.ok === true, nodes, back, ready, recoveryPerformed: open };
}

async function executeMode(client, mode, target, steps, directory) {
  const rowsPath = path.join(directory, 'rows.json');
  if (mode === 'plain-js') {
    const rows = [];
    for (const step of steps) {
      const started = performance.now();
      const result = await mcpRun(client, step.command, step.arguments);
      rows.push({ id: step.id, command: step.command, ok: result.ok !== false, error: result.error || null, durationMs: performance.now() - started, result });
      writeJson(rowsPath, rows);
      if (result.ok === false) break;
    }
    return { rows, executionStatus: rows.length === steps.length && rows.every((row) => row.ok) ? 'completed' : 'failed' };
  }
  const name = `localsend-compare-${crypto.randomUUID()}-${path.basename(directory)}`;
  const script = {
    schemaVersion: 'aab.code-script/v1', name, language: 'javascript', source: SCRIPT_SOURCE, target: { platform: 'android', ...target },
    inputs: { steps, rowsPath }, policy: { restartPolicy: 'none', timeoutMs: 90_000 },
  };
  writeJson(path.join(directory, 'script-input.json'), script);
  let state = await mcpRun(client, 'script', { operation: 'start', script });
  const operationId = state.operationId;
  writeJson(path.join(directory, 'script-start.json'), state);
  const snapshots = [state];
  const deadline = Date.now() + 110_000;
  while (state.ok && !['completed', 'failed', 'cancelled'].includes(state.status) && Date.now() < deadline) {
    state = await mcpRun(client, 'script', { operation: 'wait', operationId, waitMs: 1000, afterSequence: state.eventSequence || 0 }, 10_000);
    snapshots.push(state);
  }
  if (!['completed', 'failed', 'cancelled'].includes(state.status) && state.ok) {
    state = await mcpRun(client, 'script', { operation: 'cancel', operationId });
    snapshots.push(state);
  }
  writeJson(path.join(directory, 'script-snapshots.json'), snapshots);
  return { rows: fs.existsSync(rowsPath) ? JSON.parse(fs.readFileSync(rowsPath, 'utf8')) : [], executionStatus: state.status || 'failed', error: state.error };
}

async function compileOcr(directory) {
  const executable = path.join(directory, 'localsend-screenshot-ocr');
  const result = await executeFile('/usr/bin/xcrun', ['swiftc', '-O', path.join(__dirname, 'localsend-screenshot-ocr.swift'), '-o', executable], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(path.join(directory, 'ocr-build.log'), result.stdout + result.stderr);
  return executable;
}
async function readScreenshot(row, expectedPath, ocrExecutable) {
  if (!row?.ok || row.result?.ok !== true || path.resolve(row.result.path || '') !== expectedPath) return { validPng: false, error: 'screenshot_step_failed_or_wrong_path' };
  let data;
  try { data = fs.readFileSync(expectedPath); } catch (error) { return { validPng: false, error: error.message }; }
  const validPng = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!validPng) return { validPng: false, error: 'not_png' };
  let ocr;
  try {
    const result = await executeFile(ocrExecutable, [expectedPath], { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    ocr = JSON.parse(result.stdout);
  } catch (error) { ocr = { status: 'error', error: error.message, texts: [] }; }
  writeJson(`${expectedPath}.ocr.json`, ocr);
  return { validPng: true, path: expectedPath, width: data.readUInt32BE(16), height: data.readUInt32BE(20), sha256: crypto.createHash('sha256').update(data).digest('hex'), foregroundPackageName: row.result.foreground?.ok === true ? row.result.foreground.packageName : null, ocr };
}
async function collectEvidence(rows, directory, ocrExecutable) {
  const evidence = {};
  for (const phase of ['before', 'opened', 'returned']) {
    const nodes = rows.find((row) => row.id === `${phase}-nodes`);
    evidence[phase] = {
      nodes: nodes?.ok ? nodes.result : null,
      screenshot: await readScreenshot(rows.find((row) => row.id === `${phase}-screenshot`), path.join(directory, `${phase}.png`), ocrExecutable),
    };
  }
  return evidence;
}

function summaryOf(trials) {
  return Object.fromEntries(MODES.map((mode) => {
    const selected = trials.filter((trial) => trial.mode === mode);
    return [mode, {
      attempts: selected.length,
      passed: selected.filter((trial) => trial.verdict === 'passed').length,
      failed: selected.filter((trial) => trial.verdict === 'failed').length,
      inconclusive: selected.filter((trial) => trial.verdict === 'inconclusive').length,
      executions: selected.map((trial) => ({ round: trial.round, preparationMs: trial.preparationMs, executionWallMs: trial.executionWallMs, oracleMs: trial.oracleMs, preparationMcpRequests: trial.preparationMcpRequests, executionMcpRequests: trial.executionMcpRequests, error: trial.error || null })),
    }];
  }));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--plan-only' || key === '--negative-oracle') { args[key.slice(2)] = true; continue; }
    if (!['--serial', '--packageName', '--out', '--rounds', '--adb', '--port'].includes(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${key}`);
    args[key.slice(2)] = argv[++index];
  }
  if (!args.serial || args.packageName !== PACKAGE) throw new Error(`Explicit --serial and --packageName ${PACKAGE} are required`);
  const rounds = args.rounds == null ? 3 : Number(args.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
  const port = args.port == null ? undefined : Number(args.port);
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid --port');
  return { ...args, rounds, port, out: path.resolve(args.out || path.resolve(__dirname, '../../../../.tools', `localsend-route-comparison-${Date.now()}`)) };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const target = { serial: options.serial, packageName: options.packageName, ...(options.adb ? { adb: options.adb } : {}), ...(options.port ? { port: options.port } : {}) };
  const plan = schedule(options.rounds);
  if (options['plan-only']) {
    process.stdout.write(`${JSON.stringify({ target, plan, exampleSteps: buildSteps(target, options.out), expectation: EXPECTATION, negativeExpectation: NEGATIVE_EXPECTATION, deviceAccess: false }, null, 2)}\n`);
    return;
  }
  if (fs.existsSync(path.join(options.out, 'report.json'))) throw new Error('Output already contains a report; use a new --out directory');
  fs.mkdirSync(options.out, { recursive: true });
  const setupStart = performance.now();
  const ocr = await compileOcr(options.out);
  const hostFactStore = { directory: path.join(options.out, 'host-facts'), cacheProfile: '64mb' };
  const client = createMcpClient({
    serverPath: SERVER, transcriptPath: path.join(options.out, 'mcp-transcript.jsonl'), stderrPath: path.join(options.out, 'mcp-stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: hostFactStore.directory, AI_APP_BRIDGE_FACT_CACHE_PROFILE: hostFactStore.cacheProfile },
  });
  const report = {
    schemaVersion: 'aab.localsend-route-comparison/v1', target, startedAt: new Date().toISOString(),
    scope: 'Current-worktree comparison of plain JS calls and Script. Not a released-baseline benchmark; no model latency, token cost, or model turn savings are estimated.',
    measurement: 'Execution wall includes command transport, waits, device work, raw result persistence and Script status monitoring. Preparation and screenshot OCR/oracle time are reported separately. Both modes flush rows after each step.',
    expectedPackage: PACKAGE, expectation: EXPECTATION, negativeOracleRequested: Boolean(options['negative-oracle']), plan, trials: [],
    hostFactStore,
    scriptMonitoring: { waitMs: 1000, requestTimeoutMs: 10_000, returnsEarlyOnProgress: true, countedAs: 'MCP requests, not model calls' },
  };
  try {
    await client.initialize();
    report.setupMs = performance.now() - setupStart;
    report.setupMcpRequests = client.counts().requests;
    for (const [index, item] of plan.entries()) {
      const directory = path.join(options.out, `${String(index + 1).padStart(2, '0')}-r${item.round}-${item.mode}`);
      fs.mkdirSync(directory);
      const trial = { ...item, directory, verdict: 'inconclusive' };
      report.trials.push(trial);
      let countBefore = client.counts().requests;
      let started = performance.now();
      let stage = 'preparation';
      try {
        const ready = await prepareHome(client, target);
        const steps = buildSteps(target, directory);
        writeJson(path.join(directory, 'preparation.json'), ready);
        writeJson(path.join(directory, 'steps.json'), steps);
        trial.preparationMs = performance.now() - started;
        trial.preparationMcpRequests = client.counts().requests - countBefore;
        if (!ready.ok) throw new Error(ready.error || 'preparation_failed');
        countBefore = client.counts().requests;
        started = performance.now();
        stage = 'execution';
        const execution = await executeMode(client, item.mode, target, steps, directory);
        trial.executionWallMs = performance.now() - started;
        trial.executionMcpRequests = client.counts().requests - countBefore;
        trial.executionStatus = execution.executionStatus;
        trial.completedSteps = execution.rows.filter((row) => row.ok).length;
        trial.stepFailures = execution.rows.filter((row) => !row.ok && !row.skipped);
        trial.skippedSteps = execution.rows.filter((row) => row.skipped);
        stage = 'oracle';
        const oracleStarted = performance.now();
        const evidence = await collectEvidence(execution.rows, directory, ocr);
        writeJson(path.join(directory, 'oracle-evidence.json'), evidence);
        trial.oracle = evaluateOracle(evidence, options['negative-oracle'] ? NEGATIVE_EXPECTATION : EXPECTATION);
        trial.positiveOracle = evaluateOracle(evidence, EXPECTATION);
        trial.negativeOracle = evaluateOracle(evidence, NEGATIVE_EXPECTATION);
        trial.negativeControlPassed = trial.positiveOracle.verdict === 'passed' && trial.negativeOracle.verdict === 'failed';
        trial.oracleMs = performance.now() - oracleStarted;
        trial.verdict = execution.executionStatus !== 'completed' || trial.completedSteps !== steps.length || trial.stepFailures.length ? 'failed' : trial.oracle.verdict;
        trial.error = execution.error || (trial.verdict === 'passed' ? null : 'execution_or_external_oracle_not_passed');
      } catch (error) {
        trial.error = error.message;
        trial.verdict = 'inconclusive';
        if (stage === 'preparation') {
          trial.preparationMs ??= performance.now() - started;
          trial.preparationMcpRequests ??= client.counts().requests - countBefore;
        } else if (stage === 'execution') {
          trial.executionWallMs = performance.now() - started;
          trial.executionMcpRequests = client.counts().requests - countBefore;
        }
        // A transport timeout leaves execution state unknown. Do not run another mode over it.
        if (error.code === 'MCP_REQUEST_TIMEOUT') report.aborted = 'MCP request timed out; execution state requires inspection';
      }
      writeJson(path.join(directory, 'result.json'), trial);
      report.summary = summaryOf(report.trials);
      report.actualMcpRequests = client.counts().requests;
      writeJson(path.join(options.out, 'report.json'), report);
      process.stdout.write(`${JSON.stringify({ round: trial.round, mode: trial.mode, verdict: trial.verdict, executionWallMs: trial.executionWallMs, executionMcpRequests: trial.executionMcpRequests, error: trial.error })}\n`);
      if (report.aborted) break;
    }
    report.finishedAt = new Date().toISOString();
    report.completedPlannedTrials = report.trials.length === plan.length;
    report.ok = report.completedPlannedTrials && !report.aborted && report.trials.every((trial) => options['negative-oracle'] ? trial.negativeControlPassed : trial.verdict === 'passed');
    report.summary = summaryOf(report.trials);
    report.actualMcpRequests = client.counts().requests;
    writeJson(path.join(options.out, 'report.json'), report);
    process.stdout.write(`${JSON.stringify({ report: path.join(options.out, 'report.json'), ok: report.ok })}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } finally { await client.close(); }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { PACKAGE, MODES, EXPECTATION, NEGATIVE_EXPECTATION, SCRIPT_SOURCE, evaluateOracle, buildSteps, schedule, summaryOf, parseArgs, main };
