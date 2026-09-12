'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeHostPort } = require('../bin/script/fake-host-port');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');

const nativeTree = {
  root: {
    id: 'root',
    className: 'FrameLayout',
    children: [
      { id: 'about', className: 'Button', text: 'About', clickable: true },
      { id: 'license', className: 'TextView', text: 'License Notices' },
    ],
  },
};

const JS_SOURCE = fs.readFileSync(path.join(__dirname, 'fixtures/p7-g4a.js'), 'utf8');
const PY_SOURCE = fs.readFileSync(path.join(__dirname, 'fixtures/p7-g4a.py'), 'utf8');

function spec(language, source) {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p7-g4a',
    language,
    source,
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
  };
}

function host() {
  return createFakeHostPort({
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    handlers: {
      tree: async () => ({
        ok: true,
        result: nativeTree,
        refs: [{ stream: 'tree', rawTreeId: 'g4a' }],
      }),
    },
  });
}

async function waitDone(supervisor, operationId, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  let afterSequence = 0;
  while (Date.now() < deadline) {
    const snapshot = await supervisor.handle({
      operation: 'wait',
      operationId,
      waitMs: Math.max(1, Math.min(200, deadline - Date.now())),
      afterSequence,
    });
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    afterSequence = snapshot.eventSequence;
  }
  return supervisor.handle({ operation: 'status', operationId, afterSequence: 0 });
}

test('P7 G4-A observe-tap-assert fixture completes on JavaScript', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec('javascript', JS_SOURCE),
    host: host(),
  });
  assert.equal(started.ok, true);
  await waitDone(supervisor, started.operationId);
  const status = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  assert.equal(status.status, 'completed');
  assert.equal(status.history.items.some((item) => item.kind === 'call_started'), true);
  assert.equal(status.history.items.some((item) => item.kind === 'action_receipt'), true);
  assert.equal(status.history.items.some((item) => item.kind === 'assertion_passed'), true);
  assert.equal(status.history.items.some((item) => item.kind === 'checkpoint'), true);
  assert.equal(status.pauseReason, null);
});

test('P7 G4-A observe-tap-assert fixture completes on Python', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec('python', PY_SOURCE),
    host: host(),
  });
  if (started.error === 'runtime_unavailable') {
    assert.equal(started.error, 'runtime_unavailable');
    return;
  }
  assert.equal(started.ok, true);
  await waitDone(supervisor, started.operationId);
  const status = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  assert.equal(status.status, 'completed');
  assert.equal(status.history.items.some((item) => item.kind === 'assertion_passed'), true);
});

test('P7 S17 history pages afterSequence on the code runtime', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec('javascript', JS_SOURCE),
    host: host(),
  });
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'completed');
  const first = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
    limit: 2,
  });
  assert.equal(first.history.items.length <= 2, true);
  const next = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: first.history.lastSequence,
  });
  assert.equal(next.history.items.every((item) => item.sequence > first.history.lastSequence), true);
});

test('P7 S17 pause is accepted on a live code script', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec('javascript', `
async function main(ctx) {
  await ctx.call('tree', {});
  await new Promise(() => {});
}
module.exports = { main };
`),
    host: host(),
  });
  const paused = await supervisor.handle({
    operation: 'pause',
    operationId: started.operationId,
  });
  assert.equal(paused.ok, true);
  const cancelled = await supervisor.handle({
    operation: 'cancel',
    operationId: started.operationId,
  });
  assert.equal(cancelled.ok, true);
});

test('P7 G4-A ambiguous host action is not retried', async () => {
  let taps = 0;
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec('javascript', JS_SOURCE),
    host: createFakeHostPort({
      target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
      handlers: {
        tree: async () => ({ ok: true, result: nativeTree }),
        'tap-text': async () => {
          taps += 1;
          return { ok: false, ambiguous: true, error: 'ambiguous' };
        },
      },
    }),
  });
  await waitDone(supervisor, started.operationId);
  const status = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  assert.equal(taps, 1);
  assert.equal(status.history.items.filter((item) => item.kind === 'action_receipt').length, 1);
});

test('P7 capabilities catalog teaches JavaScript and Python', () => {
  const { catalogPayload } = require('../bin/script/script-catalog');
  const catalog = catalogPayload();
  assert.equal(catalog.schemaVersion, 'aab.code-script/v1');
  assert.deepEqual(catalog.languages, ['javascript', 'python']);
  assert.equal(catalog.entrypoint, 'main');
  const { isolatedCommandDefinitions } = require('../bin/command-router');
  const script = isolatedCommandDefinitions.find((item) => item.command === 'script');
  assert.match(script.summary, /JavaScript or Python/);
});

test('P7 G4-A code modules stay off Intent Legacy and MCP', () => {
  for (const file of [
    'script-supervisor.js',
    'script-spec.js',
    'node-runtime-adapter.js',
    'python-runtime-adapter.js',
    'fake-host-port.js',
    'script-sdk.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/script', file), 'utf8');
    assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false, file);
  }
});

test('P7 G4-A finished fixture makes no later host calls', async () => {
  const fake = host();
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec('javascript', JS_SOURCE),
    host: fake,
  });
  await waitDone(supervisor, started.operationId);
  const calls = fake.callCount;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.callCount, calls);
});

test('P7 G4-A child crash leaves a later Script and Intent start usable', async () => {
  const { handle: intentHandle } = require('./helpers/intent-entry');
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const crashed = await supervisor.handle({
    operation: 'start',
    script: spec('javascript', `
function main() {
  throw new Error('boom');
}
module.exports = { main };
`),
    host: host(),
  });
  const failed = await waitDone(supervisor, crashed.operationId);
  assert.equal(failed.status, 'failed');
  const next = await supervisor.handle({
    operation: 'start',
    script: spec('javascript', JS_SOURCE),
    host: host(),
  });
  assert.equal(next.ok, true);
  await waitDone(supervisor, next.operationId);
  const intent = await intentHandle({ operation: 'status' });
  assert.equal(intent.command, 'intent');
});

test('P7 code start persists a script checkpoint when a store is provided', async () => {
  const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
  const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
  const adapter = createMemoryEvidenceAdapter();
  const store = createScriptEvidenceStore({ adapter });
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    operationId: 'p7-persist',
    script: spec('javascript', 'function main() { return { persisted: true }; }\nmodule.exports = { main };'),
    host: host(),
    store,
  });
  assert.equal(started.ok, true);
  const checkpoint = store.latest('p7-persist', 'checkpoint');
  assert.equal(checkpoint.namespace, 'script');
  assert.equal(checkpoint.kind, 'checkpoint');
  assert.equal(checkpoint.stepId, 'start');
  assert.equal(Object.hasOwn(checkpoint, 'source'), false);
  await waitDone(supervisor, started.operationId);
});

test('P7 G8 start then cancel ten hanging JavaScript scripts', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const hanging = spec('javascript', `
async function main(ctx) {
  await ctx.call('tree', {});
  await new Promise(() => {});
}
module.exports = { main };
`);
  for (let i = 0; i < 10; i += 1) {
    const started = await supervisor.handle({
      operation: 'start',
      script: hanging,
      host: host(),
    });
    assert.equal(started.ok, true);
    const cancelled = await supervisor.handle({
      operation: 'cancel',
      operationId: started.operationId,
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.status, 'cancelled');
  }
});

test('P7 G8 start then cancel one hundred hanging JavaScript scripts', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const hanging = spec('javascript', `
async function main(ctx) {
  await ctx.call('tree', {});
  await new Promise(() => {});
}
module.exports = { main };
`);
  for (let i = 0; i < 100; i += 1) {
    const started = await supervisor.handle({
      operation: 'start',
      script: hanging,
      host: host(),
    });
    assert.equal(started.ok, true);
    const cancelled = await supervisor.handle({
      operation: 'cancel',
      operationId: started.operationId,
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.status, 'cancelled');
  }
});

test('P7 S17 checkpoint resume continues the G4-A observe-tap-assert fixture', async () => {
  const source = `
async function main(ctx) {
  const prior = ctx.resume();
  if (prior && prior.afterTree) {
    await ctx.call('tap-text', { text: 'About' });
    const after = await ctx.call('tree', {});
    const verdict = await ctx.assert({
      name: 'license-visible',
      predicateSummary: 'License Notices is on the tree',
      condition: collectTexts(after.result).includes('License Notices'),
      requiredEvidence: [],
      requireCoverage: 'complete',
      evidence: after.evidence,
    });
    return { passed: verdict.verdict === 'passed', resumed: true };
  }
  await ctx.call('tree', {});
  await ctx.checkpoint('after-tree', { afterTree: true });
  process.exit(31);
}
function collectTexts(tree) {
  const found = [];
  walk(tree && tree.root, found);
  return found;
}
function walk(node, found) {
  if (!node) return;
  if (typeof node.text === 'string') found.push(node.text);
  for (const child of node.children || []) walk(child, found);
}
module.exports = { main };
`;
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: {
      ...spec('javascript', source),
      policy: { restartPolicy: 'checkpoint' },
    },
    host: host(),
  });
  await waitDone(supervisor, started.operationId);
  const first = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  assert.equal(first.status, 'failed');
  assert.equal(first.error, 'child_crashed');
  assert.equal(first.history.items.some((item) => item.kind === 'checkpoint'), true);
  const resumed = await supervisor.handle({
    operation: 'resume',
    operationId: started.operationId,
  });
  assert.equal(resumed.ok, true);
  await waitDone(supervisor, started.operationId);
  const second = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.history.items.some((item) => item.kind === 'assertion_passed'), true);
});

test('P7 G8 LocalSend fixtures stay on catalog flutter commands', () => {
  const js = fs.readFileSync(path.join(__dirname, 'fixtures/p7-g8-localsend.js'), 'utf8');
  const py = fs.readFileSync(path.join(__dirname, 'fixtures/p7-g8-localsend.py'), 'utf8');
  for (const source of [js, py]) {
    assert.equal(/clear-app-data|install-apk|h5-eval|adb /.test(source), false);
    assert.equal(/flutter-tree/.test(source), true);
    assert.equal(/tap-flutter-text/.test(source), true);
  }
});

test('P7 command-router starts a code script without loading Intent or Legacy', async () => {
  const { createCommandRouter } = require('../bin/command-router');
  const { handle } = require('../bin/script/script-entry');
  const router = createCommandRouter({
    loadScript: () => ({ handle }),
    loadIntent: () => ({ handle: async () => ({ ok: true, command: 'intent' }) }),
    dispatchCommon: async command => ({ value: { ok: true, command } }),
  });
  function payloadOf(result) {
    return result.value;
  }
  const started = payloadOf(await router.route('script', {
    operation: 'start',
    script: spec('javascript', JS_SOURCE),
    host: host(),
  }));
  assert.equal(started.ok, true);
  assert.equal(router.loads.script, 1);
  const legacy = payloadOf(await router.route('status', { packageName: 'com.example.app' }));
  assert.equal(legacy.command, 'status');
  assert.equal(router.loads.intent, 0);
  await waitDone({ handle }, started.operationId);
  const status = payloadOf(await router.route('script', {
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  }));
  assert.equal(status.status, 'completed');
  assert.equal(status.history.items.some((item) => item.kind === 'assertion_passed'), true);
});
