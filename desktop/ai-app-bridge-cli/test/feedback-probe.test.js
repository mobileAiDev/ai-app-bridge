const assert = require('assert/strict');
const test = require('node:test');

const { runWithFeedbackProbe } = require('../bin/feedback-probe');

for (const command of ['launch-app', 'launch-activity']) {
  test(`full ${command} feedback observes the system only after launch without assuming an active App SDK`, async () => {
    const calls = [];
    const result = { ok: true, dispatched: true, settled: true,
      foreground: { ok: true, packageName: 'example.app', activity: 'example.app.MainActivity' },
      executionReceipt: { kind: 'android-shell', actionId: 'original-launch' } };
    const output = await runWithFeedbackProbe({ command, args: { feedback: 'full', serial: 'phone', packageName: 'example.app' },
      sleep: async () => {}, runner: async operation => {
        calls.push(operation);
        if (operation === command) return result;
        if (operation === 'uia-tree') return { ok: true, nodeCount: 8 };
        if (operation === 'screenshot') return { ok: true, path: '/tmp/launch.png' };
        throw new Error('No running App SDK exists before launch');
      } });
    assert.deepEqual(calls, [command, 'uia-tree', 'screenshot']);
    assert.equal(output.result, result);
    assert.equal(output.observation.basis, 'post-launch-system-snapshot');
    assert.equal(output.observation.semanticChanged, false);
    assert.equal(output.observation.inconclusive, true);
    assert.deepEqual(output.observation.current.foreground, result.foreground);
    assert.equal(output.observation.current.tree.nodeCount, 8);
    assert.deepEqual(output.evidence.map(item => item.command), ['uia-tree', 'screenshot']);
  });
}

test('failed launch retains its original result without extra full-feedback device reads', async () => {
  const calls = [];
  const result = { ok: false, error: 'activity_not_found', dispatched: false };
  const output = await runWithFeedbackProbe({ command: 'launch-activity', args: { feedback: 'full' },
    sleep: async () => {}, runner: async command => { calls.push(command); return result; } });
  assert.equal(output.result, result);
  assert.deepEqual(calls, ['launch-activity']);
  assert.deepEqual(output.evidence, []);
});

test('post-launch capture failure remains inconclusive without retrying the launch or substituting an App SDK', async () => {
  const calls = [];
  const result = { ok: true, dispatched: true, settled: true };
  const output = await runWithFeedbackProbe({ command: 'launch-app',
    args: { feedback: 'full', feedbackScreenshot: false, serial: 'phone', packageName: 'example.app' },
    runner: async (command, args) => {
      calls.push(command);
      if (command === 'launch-app') return result;
      assert.equal(args.serial, 'phone');
      assert.equal(args.compact, true);
      throw Object.assign(new Error('UIA unavailable'), { code: 'uia_runtime_unreachable' });
    } });
  assert.deepEqual(calls, ['launch-app', 'uia-tree']);
  assert.equal(output.result, result);
  assert.equal(output.observation.inconclusive, true);
  assert.equal(output.observation.current.tree.error, 'uia_runtime_unreachable');
  assert.equal(output.evidence[0].result.ok, false);
});

test('auto feedback keeps the fast path to one command call', async () => {
  const calls = [];
  const output = await runWithFeedbackProbe({
    command: 'tap',
    args: { feedback: 'auto' },
    runner: async (command) => { calls.push(command); return { ok: true }; },
  });
  assert.deepEqual(calls, ['tap']);
  assert.equal(output.observation, null);
});

test('full feedback correlates post-action UI change events', async () => {
  const calls = [];
  let eventRead = 0;
  const output = await runWithFeedbackProbe({
    command: 'tap-text',
    args: { feedback: 'full', packageName: 'com.example.app' },
    sleep: async () => {},
    runner: async (command, args) => {
      calls.push({ command, args });
      if (command === 'events') {
        eventRead += 1;
        return eventRead === 1
          ? { ok: true, items: [{ id: 10, category: 'app', name: 'before' }] }
          : { ok: true, items: [{ id: 11, category: 'ui', name: 'ui.changed', data: { dialog: 'open' } }] };
      }
      return { ok: true, action: 'tap-text' };
    },
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.observation.changed, true);
  assert.equal(output.observation.events.length, 1);
  assert.equal(calls[2].args.sinceId, 10);
  assert.equal(calls.some((call) => call.command === 'screenshot'), false);
});

test('full feedback captures current tree and screenshot when no UI change arrives', async () => {
  const calls = [];
  const output = await runWithFeedbackProbe({
    command: 'tap',
    args: { feedback: 'full', packageName: 'com.example.app' },
    maxWaitMs: 100,
    intervalMs: 50,
    sleep: async () => {},
    runner: async (command) => {
      calls.push(command);
      if (command === 'events') return { ok: true, items: [] };
      if (command === 'tree') return { ok: true, activity: 'MainActivity', nodeCount: 12 };
      if (command === 'screenshot') return { ok: true, path: '/tmp/evidence.png' };
      return { ok: true };
    },
  });

  assert.equal(output.observation.changed, false);
  assert.equal(output.observation.inconclusive, true);
  assert.equal(output.observation.fallback.tree.nodeCount, 12);
  assert.equal(output.observation.fallback.screenshot.path, '/tmp/evidence.png');
  assert.equal(calls.includes('tree'), true);
  assert.equal(calls.includes('screenshot'), true);
});

test('full feedback does not mistake render-only or stable events for a semantic UI change', async () => {
  const calls = [];
  let eventRead = 0;
  const output = await runWithFeedbackProbe({
    command: 'tap',
    args: { feedback: 'full', packageName: 'com.example.app' },
    maxWaitMs: 100,
    intervalMs: 50,
    sleep: async () => {},
    runner: async (command) => {
      calls.push(command);
      if (command === 'events') {
        eventRead += 1;
        if (eventRead === 1) return { ok: true, items: [{ id: 10, category: 'app', name: 'before' }] };
        if (eventRead === 2) {
          return {
            ok: true,
            items: [{
              id: 11,
              category: 'ui',
              name: 'ui.changed',
              data: { renderOnly: true, updatedNodeCount: 0 },
            }],
          };
        }
        return {
          ok: true,
          items: [{ id: 12, category: 'ui', name: 'ui.stable', data: { stableForMs: 250 } }],
        };
      }
      if (command === 'tree') return { ok: true, activity: 'MainActivity', nodeCount: 9 };
      if (command === 'screenshot') return { ok: true, path: '/tmp/render-only.png' };
      return { ok: true };
    },
  });

  assert.equal(eventRead, 3);
  assert.equal(output.observation.changed, true);
  assert.equal(output.observation.renderChanged, true);
  assert.equal(output.observation.semanticChanged, false);
  assert.equal(output.observation.inconclusive, true);
  assert.equal(output.observation.events.length, 1);
  assert.equal(output.observation.events[0].data.renderOnly, true);
  assert.equal(output.observation.fallback.tree.nodeCount, 9);
  assert.equal(output.observation.fallback.screenshot.path, '/tmp/render-only.png');
  assert.equal(calls.includes('tree'), true);
  assert.equal(calls.includes('screenshot'), true);
});

test('full feedback treats Flutter animation-frame events as render evidence and keeps polling', async () => {
  let eventRead = 0;
  const output = await runWithFeedbackProbe({
    command: 'flutter-tap',
    args: { feedback: 'full', packageName: 'com.example.flutter', feedbackScreenshot: false },
    maxWaitMs: 100,
    intervalMs: 50,
    sleep: async () => {},
    runner: async (command) => {
      if (command === 'events') {
        eventRead += 1;
        if (eventRead === 1) return { ok: true, items: [] };
        if (eventRead === 2) {
          return {
            ok: true,
            items: [{
              id: 1,
              category: 'ui',
              name: 'ui.changed',
              data: { platform: 'flutter', frameCount: 3 },
            }],
          };
        }
        return {
          ok: true,
          items: [{ id: 2, category: 'ui', name: 'route.changed', data: { route: '/checkout' } }],
        };
      }
      if (command === 'tree') return { ok: true, nodeCount: 10 };
      return { ok: true };
    },
  });

  assert.equal(eventRead, 3);
  assert.equal(output.observation.changed, true);
  assert.equal(output.observation.renderChanged, true);
  assert.equal(output.observation.semanticChanged, true);
  assert.equal(output.observation.inconclusive, false);
  assert.equal(output.observation.events.length, 2);
});

test('full feedback reports input delivery separately when interaction has no UI outcome', async () => {
  let eventRead = 0;
  const output = await runWithFeedbackProbe({
    command: 'tap',
    args: { feedback: 'full', packageName: 'com.example.app', feedbackScreenshot: false },
    maxWaitMs: 50,
    intervalMs: 50,
    sleep: async () => {},
    runner: async (command) => {
      if (command === 'events') {
        eventRead += 1;
        return eventRead === 1
          ? { ok: true, items: [] }
          : { ok: true, items: [{ id: 1, category: 'ui', name: 'ui.interaction', data: { type: 'tap' } }] };
      }
      if (command === 'tree') return { ok: true, nodeCount: 3 };
      return { ok: true };
    },
  });

  assert.equal(output.observation.changed, false);
  assert.equal(output.observation.semanticChanged, false);
  assert.equal(output.observation.renderChanged, false);
  assert.equal(output.observation.interactionObserved, true);
  assert.equal(output.observation.inconclusive, true);
  assert.equal(output.observation.fallback.tree.nodeCount, 3);
});

test('full feedback recognizes a Web UI batch with a DOM mutation as semantic', async () => {
  let eventRead = 0;
  const output = await runWithFeedbackProbe({
    command: 'web-click',
    args: { feedback: 'full', sessionId: 'web-1' },
    maxWaitMs: 50,
    intervalMs: 50,
    sleep: async () => {},
    runner: async (command) => {
      if (command === 'web-events') {
        eventRead += 1;
        return eventRead === 1
          ? { ok: true, items: [] }
          : {
              ok: true,
              items: [{
                id: 1,
                category: 'ui',
                name: 'batch',
                data: { events: [{ type: 'interaction.click' }, { type: 'dom.mutation' }] },
              }],
            };
      }
      return { ok: true };
    },
  });

  assert.equal(output.observation.semanticChanged, true);
  assert.equal(output.observation.interactionObserved, true);
  assert.equal(output.observation.inconclusive, false);
});

test('full feedback trusts explicit semantic/render flags for transform-only changes', async () => {
  let eventRead = 0;
  const output = await runWithFeedbackProbe({
    command: 'tap',
    args: { feedback: 'full', packageName: 'com.example.app', feedbackScreenshot: false },
    maxWaitMs: 50,
    intervalMs: 50,
    sleep: async () => {},
    runner: async (command) => {
      if (command === 'events') {
        eventRead += 1;
        return eventRead === 1
          ? { ok: true, items: [] }
          : {
              ok: true,
              items: [{
                id: 7,
                category: 'ui',
                name: 'ui.changed',
                data: {
                  semanticChanged: false,
                  renderChanged: true,
                  renderOnly: false,
                  changes: [{ fields: ['alpha', 'translationX'] }],
                },
              }],
            };
      }
      if (command === 'tree') return { ok: true, nodeCount: 4 };
      return { ok: true };
    },
  });

  assert.equal(output.observation.semanticChanged, false);
  assert.equal(output.observation.renderChanged, true);
  assert.equal(output.observation.inconclusive, true);
  assert.equal(output.observation.fallback.tree.nodeCount, 4);
});
