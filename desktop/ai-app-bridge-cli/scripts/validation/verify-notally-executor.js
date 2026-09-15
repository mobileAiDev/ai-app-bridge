'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { runCli } = require('../../test-support/cli-client');

async function main() {
  const [serial, outputDir, language] = process.argv.slice(2);
  assert(serial && outputDir && ['javascript', 'python'].includes(language),
    'Usage: node scripts/validation/verify-notally-executor.js SERIAL NEW_OUTPUT_DIRECTORY javascript|python');
  const directory = path.resolve(outputDir);
  fs.mkdirSync(directory); // Preserve previous results.
  const env = { AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtime'),
    AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts') };
  const call = async (command, args) => {
    const reply = await runCli(command, args, { env });
    assert.equal(reply.value.ok, true, JSON.stringify(reply.value));
    return reply.value;
  };
  const target = { serial, packageName: 'io.github.mobileaidev.notallyx.sample' };
  const runId = language + '-' + Date.now();
  try {
    let state = await call('script', { operation: 'start', recordingDir: path.join(directory, 'receipts'),
      script: { schemaVersion: 'aab.code-script/v1', name: 'NotallyX existing application regression', language,
        sourcePath: path.join(__dirname, 'notally', language === 'python' ? 'regression.py' : 'regression.js'),
        target: { platform: 'android', ...target }, permissions: ['app.test'],
        inputs: { target, plan: require('./notally/plan.json'), runId, output: path.join(directory, 'steps.json') },
        policy: { timeoutMs: 240000, restartPolicy: 'none' } } });
    const operationId = state.operationId;
    while (!['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(state.status)) {
      state = await call('script', { operation: 'wait', operationId, afterSequence: state.eventSequence || 0, waitMs: 1000 });
    }
    const result = await runCli('script', { operation: 'result', operationId }, { env });
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result.value, null, 2));
    assert.equal(state.status, 'completed', JSON.stringify(state));
    assert.equal(result.value.persisted, true);
    assert.equal(result.value.result.ok, true, JSON.stringify(result.value.result));
    const outcome = result.value.result;
    console.log(JSON.stringify({ ok: true, operationId, language, steps: outcome.steps.length,
      actions: outcome.actions, assertions: outcome.assertions, flowElapsedMs: outcome.flowElapsedMs, directory }));
  } finally {
    await call('runtime', { operation: 'stop' });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
