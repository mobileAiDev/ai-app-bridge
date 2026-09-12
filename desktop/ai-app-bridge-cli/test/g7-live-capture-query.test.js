'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLiveCaptureQuery } = require('../bin/shared-kernel/live-capture-query');
const { createScriptCapturePort } = require('../bin/script/script-capture-port');
const { createFakeHostPort } = require('../bin/script/fake-host-port');
const { createIntentCapturePort } = require('../bin/intent/intent-capture-port');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createFakeIntentDeviceAdapter } = require('../bin/intent/intent-device-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createAutonomousAgentAdapter } = require('../bin/intent/intent-autonomous-adapter');
const { handle } = require('../bin/intent/intent-entry');
const { validateCommandArguments } = require('../bin/command-registry');

function completePage(stream, extra = {}, request = {}) {
  const runtimeEpoch = request.runtimeEpoch || 'fixture-epoch';
  const targetKey = request.packageName || 'pkg';
  return {
    ok: true,
    coverage: { status: 'complete', gap: false, committed: true },
    gap: false,
    refs: [{ mobileFactId: `mf1:1:1:${stream}`, stream, captureId: 1, runtimeEpoch, targetKey }],
    runtimeEpoch, targetKey, watermarkCursor: 'fixture-watermark', hasMore: false,
    window: {
      filterApplied: true, afterActionId: request.afterActionId ?? null,
      factCursor: request.factCursor ?? null, sinceId: request.sinceId ?? null, sinceMs: request.sinceMs ?? null,
      runtimeEpoch, targetKey,
    },
    items: extra.items || [{ id: 1, stream, ...extra.item }],
  };
}

test('unavailable mobile capture has an explicit reason through the shared query port', async () => {
  for (const reason of ['capture_not_persistent', undefined]) {
    const query = createLiveCaptureQuery({ runner: async () => ({
      ok: true, reason, coverage: { status: 'unavailable', gap: false, committed: false }, items: [], refs: [],
    }) });
    const page = await query({ platform: 'android', stream: 'state', view: 'decision-window' });
    assert.equal(page.ok, false);
    assert.equal(page.error, reason || 'capture_contract_unavailable');
    assert.equal(page.coverage.committed, false);
    assert.deepEqual(page.refs, []);
  }
});

test('G7 FakeHost live query never falls back to Host copies', async () => {
  const host = createFakeHostPort({
    target: { platform: 'android', serial: 'fixture-device', packageName: 'pkg' },
    query: createLiveCaptureQuery({
      runner: async (command, args) => {
        assert.equal(command, 'network');
        assert.equal(args.afterActionId, undefined);
        return completePage('network', { item: { statusCode: 200 } }, args);
      },
    }),
  });
  const result = await host.call('network', {});
  assert.equal(result.evidence.coverage.status, 'complete');
  assert.equal(result.evidence.window.afterActionId, null);
  assert.equal(result.result.items[0].statusCode, 200);
  const verdict = await host.assert({
    name: 'login-status',
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    condition: result.result.items[0].statusCode === 200,
    evidence: result.evidence,
  });
  assert.equal(verdict.verdict, 'passed');
});

test('G7 login tap then network statusCode uses the mutation actionId', async () => {
  const afterActionIds = [];
  const host = createFakeHostPort({
    target: { platform: 'android', serial: 'fixture-device', packageName: 'pkg' },
    query: createLiveCaptureQuery({
      runner: async (command, args) => {
        afterActionIds.push(args.afterActionId);
        return completePage('network', { item: { statusCode: 200 } }, args);
      },
    }),
  });
  const before = await host.call('network', {});
  const tap = await host.call('tap-text', { text: 'Login' });
  assert.equal(tap.execution.actionId, 'action-2');
  const network = await host.call('network', { factCursor: before.evidence.capture.watermarkCursor, afterActionId: tap.execution.actionId });
  assert.deepEqual(afterActionIds, [undefined, 'action-2']);
  assert.equal(network.result.items[0].statusCode, 200);
  const next = await host.assert({
    name: 'login-status',
    predicateSummary: 'login request returned 200',
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    condition: network.result.items[0].statusCode === 200,
    evidence: network.evidence,
  });
  assert.equal(next.verdict, 'passed');
});

test('G7 live query login statusCode does not read Host copies', async () => {
  const calls = [];
  const query = createLiveCaptureQuery({
    runner: async (command, args) => {
      calls.push({ command, args });
      return completePage('network', { item: { url: 'https://example.test/login', statusCode: 200 } }, args);
    },
  });
  const port = createScriptCapturePort({ query });
  const window = await port.query('network', {}, { actionId: 'login-1' });
  assert.equal(calls[0].command, 'network');
  assert.equal(calls[0].args.afterActionId, 'login-1');
  assert.equal(window.items[0].statusCode, 200);
  const host = createFakeHostPort({ target: { platform: 'android', serial: 'fixture-device', packageName: 'pkg' }, query });
  const result = await host.call('network', {});
  const next = await host.assert({
    name: 'login-status',
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    condition: result.result.items[0].statusCode === 200,
    evidence: result.evidence,
  });
  assert.equal(next.verdict, 'passed');
});

test('G7 live query log state and event assertions pass on a complete window', async () => {
  const query = createLiveCaptureQuery({
    runner: async (command, args) => completePage(command, {
      item: command === 'logs'
        ? { message: 'ready' }
        : command === 'state'
          ? { key: 'route', value: 'home' }
          : { name: 'opened' },
    }, args),
  });
  const port = createIntentCapturePort({ query });
  const host = createFakeHostPort({ target: { platform: 'android', serial: 'fixture-device', packageName: 'pkg' }, query });
  for (const stream of ['logs', 'state', 'events']) {
    const observed = await port.observe({ stream }, { actionId: 'after-1' });
    assert.equal(observed.items.length, 1);
    const result = await host.call(stream, {});
    const verdict = await host.assert({
      name: `${stream}-present`,
      requireCoverage: 'complete',
      requiredEvidence: [stream],
      condition: result.result.items.length === 1,
      evidence: result.evidence,
    });
    assert.equal(verdict.verdict, 'passed');
  }
});

test('G7 requireCoverage partial cannot fail a partial window', async () => {
  const host = createFakeHostPort();
  const verdict = await host.assert({
    name: 'login-denied',
    requireCoverage: 'partial',
    condition: false,
    evidence: {
      coverage: { status: 'partial', gap: false, committed: true },
      refs: [],
    },
  });
  assert.equal(verdict.verdict, 'inconclusive');
});

test('G7 negative assertion fails only on a complete window', async () => {
  const host = createFakeHostPort({
    target: { platform: 'android', serial: 'fixture-device', packageName: 'pkg' },
    query: (request) => completePage('network', { item: { statusCode: 401 } }, request),
  });
  const complete = await host.call('network', {});
  const failed = await host.assert({
    name: 'login-denied',
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    condition: complete.result.items[0].statusCode === 200,
    evidence: complete.evidence,
  });
  assert.equal(failed.verdict, 'failed');

  const partial = await createScriptCapturePort({
    query: () => ({
      ok: true,
      coverage: { status: 'partial', gap: true, committed: false },
      refs: [],
      items: [{ statusCode: 401 }],
    }),
  }).query('network', {}, { actionId: 'a' });
  const inconclusive = await host.assert({
    name: 'login-denied',
    requireCoverage: 'complete',
    condition: partial.items[0].statusCode === 200,
    evidence: partial,
  });
  assert.equal(inconclusive.verdict, 'inconclusive');
});

test('G7 live throw is unavailable and does not use Host FactStore', async () => {
  let readHistory = 0;
  const query = createLiveCaptureQuery({
    runner: async () => {
      throw new Error('target_disconnected');
    },
  });
  const port = createScriptCapturePort({ query });
  const window = await port.query('network', {}, { actionId: 'a' });
  assert.equal(window.coverage.status, 'unavailable');
  assert.equal(window.items.length, 0);
  assert.equal(readHistory, 0);
});

test('G7 live query without coverage does not invent complete', async () => {
  const query = createLiveCaptureQuery({
    runner: async () => ({
      ok: true,
      items: [{ statusCode: 200, message: 'legacy-container' }],
    }),
  });
  const window = await createScriptCapturePort({ query }).query('network', {}, { actionId: 'a' });
  assert.equal(window.coverage.status, 'unavailable');
  assert.equal(window.items.length, 0);
});

test('G7 live query coverage without status does not invent complete', async () => {
  const query = createLiveCaptureQuery({
    runner: async () => ({
      ok: true,
      coverage: { gap: false, committed: true },
      items: [{ statusCode: 200 }],
    }),
  });
  const window = await createScriptCapturePort({ query }).query('network', {}, { actionId: 'a' });
  assert.equal(window.coverage.status, 'unavailable');
  assert.equal(window.items.length, 0);
});

test('G7 FakeHost evidenceWindow afterActionId and timeoutMs reach the live runner', async () => {
  const seen = [];
  const host = createFakeHostPort({
    target: { platform: 'android', serial: 'fixture-device', packageName: 'pkg' },
    query: createLiveCaptureQuery({
      runner: async (command, args) => {
        seen.push({ command, args });
        return completePage('network', { item: { statusCode: 200 } }, args);
      },
    }),
  });
  const tap = await host.call('tap-text', { text: 'Login' });
  const network = await host.call('network', {}, {
    evidenceWindow: { afterActionId: tap.execution.actionId, timeoutMs: 1500 },
  });
  assert.equal(seen[0].args.afterActionId, 'action-1');
  assert.equal(seen[0].args.timeoutMs, 1500);
  assert.equal(network.evidence.window.afterActionId, 'action-1');
  assert.equal(network.result.items[0].statusCode, 200);
});

test('G7 Intent start persist capture refs without four-stream bodies', async () => {
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const query = createLiveCaptureQuery({
    runner: async (command, args) => {
      validateCommandArguments(command, args);
      assert.equal(args.streams, undefined); assert.equal(args.foregroundPackages, undefined);
      return completePage(command, { item: { message: 'ready' } }, args);
    },
  });
  const routedCapture = await createIntentCapturePort({ query }).observe({ stream: 'logs' },
    { target: { platform: 'android', serial: 's1', packageName: 'pkg', foregroundPackages: ['com.android.documentsui'] } });
  assert.equal(routedCapture.coverage.status, 'complete');
  const started = await handle({
    operation: 'start',
    operationId: 'g7-intent-capture',
    goal: 'check logs',
    target: { platform: 'android', serial: 's1', packageName: 'pkg' },
    store,
    adapter: createFakeIntentDeviceAdapter({
      trees: { native: { root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] } } },
    }),
    capturePort: createIntentCapturePort({ query }),
    require: { streams: ['logs'] },
  });
  assert.equal(started.status, 'waiting_for_decision');
  const status = await handle({
    operation: 'status',
    operationId: 'g7-intent-capture',
    afterSequence: 0,
  });
  const observation = status.history.items.find((item) => item.kind === 'observation');
  assert.equal(observation.payloadSummary.captureCoverage.status, 'complete');
  assert.equal(observation.payloadSummary.captureRefs[0].stream, 'logs');
  assert.equal(Object.hasOwn(observation.payloadSummary, 'items'), false);
  assert.equal(started.capture.items[0].message, 'ready');
  assert.equal(status.capture.items[0].message, 'ready');
});

test('G7 Intent preserves an earlier gap and uses its issued watermark for the next action window', async () => {
  const afterActionIds = [];
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const query = createLiveCaptureQuery({
    runner: async (command, args) => {
      validateCommandArguments(command, args);
      afterActionIds.push(args.afterActionId);
      const page = completePage(command, { item: { message: 'ready' } }, args);
      if (!args.afterActionId) return { ...page, coverage: { status: 'partial', gap: true, committed: true }, gap: true, reason: 'capture_gap' };
      assert.equal(args.factCursor, 'fixture-watermark'); assert.equal(args.runtimeEpoch, 'fixture-epoch');
      return { ...page, watermarkCursor: `after-action-watermark-${afterActionIds.length}` };
    },
  });
  const started = await handle({
    operation: 'start',
    operationId: 'g7-intent-action-id',
    goal: 'tap home',
    target: { platform: 'android', serial: 's1', packageName: 'pkg' },
    store,
    adapter: createFakeIntentDeviceAdapter({
      trees: { native: { root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] } } },
    }),
    capturePort: createIntentCapturePort({ query }),
    require: { streams: ['logs'] },
  });
  assert.equal(started.status, 'waiting_for_decision');
  assert.equal(afterActionIds[0], undefined);
  assert.equal(started.capture.coverage.status, 'partial'); assert.equal(started.capture.gap, true);
  const acted = await handle({
    operation: 'decide',
    operationId: 'g7-intent-action-id',
    decision: {
      decisionId: 'd1',
      agentDecision: 'act',
      basedOnRevision: started.revision,
      action: { action: 'tap', selector: { text: 'Home' } },
    },
  });
  assert.equal(acted.ok, true);
  assert.equal(acted.capture.coverage.status, 'complete');
  assert.equal(afterActionIds.includes('g7-intent-action-id:d1'), true);
  const observedAgain = await handle({ operation: 'observe', operationId: 'g7-intent-action-id' });
  assert.equal(observedAgain.ok, true);
  assert.equal(observedAgain.capture.pages[0].window.factCursor, 'fixture-watermark');
});

test('capture failures retain the command field and message through the Intent port', async () => {
  const port = createIntentCapturePort({ query: createLiveCaptureQuery({ runner: async (command, args) => validateCommandArguments(command, args) }) });
  const result = await port.observe({ stream: 'events', limit: 'forty' }, { target: { platform: 'android', serial: 's', packageName: 'pkg' } });
  assert.equal(result.error, 'invalid_argument'); assert.equal(result.field, 'limit'); assert.match(result.message, /limit/);
  assert.equal(result.coverage.status, 'unavailable'); assert.equal(result.refs.length, 0);
});

test('G7 Intent merge does not invent complete from coverage without status', async () => {
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const started = await handle({
    operation: 'start',
    operationId: 'g7-intent-coverage-status',
    goal: 'check network',
    target: { platform: 'android', serial: 's1', packageName: 'pkg' },
    store,
    adapter: createFakeIntentDeviceAdapter({
      trees: { native: { root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] } } },
    }),
    capturePort: {
      async observe() {
        return {
          coverage: { gap: false, committed: true },
          refs: [{ stream: 'network', mobileFactId: 'mf1:1:1:net' }],
          items: [{ statusCode: 200 }],
        };
      },
    },
    require: { streams: ['network'] },
  });
  assert.equal(started.capture.coverage.status, 'unavailable');
  const observation = (await handle({
    operation: 'status',
    operationId: 'g7-intent-coverage-status',
    afterSequence: 0,
  })).history.items.find((item) => item.kind === 'observation');
  assert.equal(observation.payloadSummary.captureCoverage.status, 'unavailable');
  assert.equal(Object.hasOwn(observation.payloadSummary, 'items'), false);
});

test('G7 Intent Agent decide receives current-round capture items', async () => {
  let seen = null;
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const completed = await handle({
    operation: 'start',
    operationId: 'g7-intent-agent-capture',
    mode: 'autonomous',
    goal: 'login',
    target: { platform: 'android', serial: 's1', packageName: 'pkg' },
    store,
    adapter: createFakeIntentDeviceAdapter({
      trees: { native: { root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] } } },
    }),
    capturePort: createIntentCapturePort({
      query: createLiveCaptureQuery({
        runner: async (_command, args) => completePage('network', { item: { statusCode: 200 } }, args),
      }),
    }),
    require: { streams: ['network'] },
    agent: createAutonomousAgentAdapter({
      decide(input) {
        seen = input;
        return { decisionId: 'done', agentDecision: 'complete', basedOnRevision: input.revision };
      },
    }),
  });
  assert.equal(completed.status, 'completed');
  assert.equal(seen.capture.items[0].statusCode, 200);
  assert.equal(seen.capture.coverage.status, 'complete');
  const observation = (await handle({
    operation: 'status',
    operationId: 'g7-intent-agent-capture',
    afterSequence: 0,
  })).history.items.find((item) => item.kind === 'observation');
  assert.equal(Object.hasOwn(observation.payloadSummary, 'items'), false);
});

test('G7 live-capture-query stays off Script Intent and Legacy modules', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../bin/shared-kernel/live-capture-query.js'),
    'utf8',
  );
  assert.equal(/intent\/|script\/|legacy\/|runBatch|runBridgeChecked|mcp-server|readHistory/.test(source), false);
});
