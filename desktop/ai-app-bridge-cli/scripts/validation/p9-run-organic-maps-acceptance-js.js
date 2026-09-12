'use strict';

// Run only with a newly observed freeze, a prepared app, and a new output path:
// node scripts/validation/p9-run-organic-maps-acceptance-js.js <freeze.json> <new-report.json>
const fs = require('node:fs');
const path = require('node:path');
const { handle } = require('../../bin/script/script-entry');
const { runBridgeChecked } = require('../../bin/mcp-server');
const { applyP9Freeze } = require('../../bin/script/p9-scenario-freeze');
const { runP9Scenario } = require('../../bin/script/p9-scenario-runner');
const { scoreOrganicMapsStep } = require('../../test/support/p9-acceptance-scorer');

async function main(freezePath, outputPath) {
  if (!freezePath || !outputPath) throw new Error('freeze_and_new_output_paths_required');
  if (fs.existsSync(outputPath)) throw new Error('output_already_exists');
  const freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8'));
  const app = freeze.apps?.['organic-maps-android'];
  if (!freeze.serial || !app?.packageName || !app.labels?.routePreview) throw new Error('current_target_and_route_preview_freeze_required');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../test/fixtures/p9-scenario-manifests.json'), 'utf8'));
  const frozen = applyP9Freeze(manifest, { version: app.version, language: freeze.language, labels: app.labels, fixtureHash: freeze.fixtureHash, initialState: app.initialState });
  if (!frozen.ok) throw new Error(frozen.error);
  const actions = async (command, args) => {
    const response = await runBridgeChecked(command, { ...args, serial: freeze.serial, packageName: app.packageName });
    const text = response?.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error('provider_response_text_missing');
    if (command === 'uia-tree' && text.includes('<hierarchy')) return { ok: true, result: text };
    return JSON.parse(text);
  };
  const startedAt = Date.now();
  const started = await handle({ operation: 'start', actions, script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(__dirname, '../../test/fixtures/p9-organic-maps-acceptance.js'),
    target: { platform: 'android', serial: freeze.serial, packageName: app.packageName }, inputs: { labels: app.labels },
  } });
  if (!started.ok) throw new Error(started.error);
  let current = started;
  while (['starting', 'running'].includes(current.status)) {
    current = await handle({ operation: 'wait', operationId: started.operationId, waitMs: 2000, afterSequence: current.eventSequence || 0, actions });
    if (Date.now() - startedAt > 600000) {
      await handle({ operation: 'cancel', operationId: started.operationId, actions });
      throw new Error('acceptance_deadline');
    }
  }
  const done = await handle({ operation: 'status', operationId: started.operationId, afterSequence: 0, actions });
  const scenario = runP9Scenario(frozen.manifest, 'organic-maps-acceptance-v1', {
    labels: app.labels, observedNotFrozen: app.observedNotFrozen,
    step: (step) => scoreOrganicMapsStep(done, step),
  });
  const report = { scope: 'current-ui-postconditions', freeze, startedAt, wallMs: Date.now() - startedAt, done, scenario };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return report;
}

if (require.main === module) main(process.argv[2], process.argv[3]).then((report) => {
  process.exitCode = report.scenario.ok ? 0 : 1;
}).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { main };
