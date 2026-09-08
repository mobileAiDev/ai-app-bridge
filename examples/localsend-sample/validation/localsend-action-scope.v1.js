'use strict';

// Root-authored focused regression for the Flutter action scope. The separately
// authored localsend-flow.v1.js remains frozen and has a different coverage claim.
const PACKAGE = 'org.localsend.localsend_app.bridge_sample';
const BASELINE = { 'flutter.ls_theme': 'system', 'flutter.ls_color': 'system' };

async function main(ctx) {
  const target = { serial: ctx.inputs.serial, packageName: PACKAGE };
  const assertions = [], routes = [], oracles = [];
  const pause = () => new Promise(resolve => setTimeout(resolve, 180));
  const texts = read => read.result.nodes.filter(node => ['Text', 'NavigationDestination'].includes(node.widgetType));
  const named = (read, name) => texts(read).filter(node => node.text === name);
  const has = (read, name) => named(read, name).length > 0;
  const geometry = read => JSON.stringify(texts(read).map(node => [node.text, node.bounds]));
  async function call(command, args = {}) {
    const r = await ctx.call(command, { ...target, ...args });
    if (!r.ok) throw new Error(`${command}: ${r.error}`);
    return r;
  }
  async function check(name, condition, read, kind = 'tree') {
    const verdict = await ctx.assert({ name, predicateSummary: name, condition,
      requiredEvidence: [kind], evidence: read.evidence, requireCoverage: 'complete' });
    assertions.push(verdict);
    if (verdict.verdict !== 'passed') throw new Error(`${name}: ${verdict.verdict}`);
  }
  async function observe(name, predicate) {
    let previous;
    const deadline = Date.now() + 12000;
    do {
      const r = await call('flutter-nodes');
      if (r.result.ok !== true || r.result.truncated !== false) throw new Error('incomplete tree');
      if (previous && r.result.updatedAtMs > previous.result.updatedAtMs &&
          geometry(previous) === geometry(r) && predicate(previous) && predicate(r)) {
        await check(name, true, r);
        return r;
      }
      previous = r;
      await pause();
    } while (Date.now() < deadline);
    throw new Error(`${name}: no matching advancing stable snapshots`);
  }
  function one(nodes) {
    if (nodes.length !== 1) throw new Error(`selector count ${nodes.length}`);
    return nodes[0];
  }
  function themeValue(read, value) {
    const label = one(named(read, '主题'));
    return one(named(read, value).filter(node => Math.abs(node.bounds.top - label.bounds.top) < 5 &&
      node.bounds.left > label.bounds.right));
  }
  async function tap(name, read, node, routeAction = null) {
    const boundary = routeAction ? await call('events', { sinceMs: Date.now() - 1000, limit: 200 }) : null;
    if (boundary) {
      const c = boundary.evidence.capture, coverage = boundary.evidence.coverage;
      if (coverage.status !== 'complete' || coverage.gap || !coverage.committed || c.hasMore ||
          !c.watermarkCursor || !c.runtimeEpoch || c.targetKey !== PACKAGE) throw new Error('incomplete capture boundary');
    }
    const b = node.bounds, v = read.result.viewport;
    await check(`${name}: fresh visible target`, !!node.tap && b.left >= 0 && b.top >= 0 &&
      b.right <= v.logicalWidth && b.bottom <= v.logicalHeight, read);
    const action = await call('tap-flutter', { tapX: (b.left + b.right) / 2, tapY: (b.top + b.bottom) / 2 });
    const actionId = action.execution.actionId;
    if (!actionId || action.result.request.actionId !== actionId) throw new Error('host action ID missing');
    if (boundary) {
      const c = boundary.evidence.capture;
      const after = await call('events', { factCursor: c.watermarkCursor, runtimeEpoch: c.runtimeEpoch,
        afterActionId: actionId, limit: 200 });
      const matching = after.result.items.filter(item => item.actionId === actionId &&
        item.name === 'ui.route.changed' && item.data?.semanticChanged === true && item.data.action === routeAction);
      await check(`${name}: real route ${routeAction} belongs to dispatched action`,
        matching.length === 1 && after.evidence.window.afterActionId === actionId &&
        after.result.items.every(item => item.actionId === actionId), after, 'events');
      routes.push({ name, actionId, route: matching[0], evidence: after.evidence });
    }
  }
  async function oracle(checkpoint, expected) {
    const reply = await ctx.askAgent({ question: 'Read the allowlisted preferences using the external controller.',
      context: { kind: 'localsend.action-scope-oracle/v1', checkpoint, expectedSettings: expected } });
    if (reply.verdict !== 'passed' || Object.keys(reply.observedSettings || {}).length !== Object.keys(expected).length ||
        !Object.entries(expected).every(([key, value]) => reply.observedSettings?.[key] === value)) {
      throw new Error(`${checkpoint}: independent preference mismatch`);
    }
    oracles.push(reply);
  }
  try {
    let read = await observe('initial Receive', r => has(r, '通过链接接收'));
    await check('expected device name', has(read, ctx.inputs.wrongExpectation ? 'deliberately wrong device' : '好的椰子'), read);
    if (ctx.inputs.cancelBeforeMutation) {
      await ctx.askAgent({ question: 'Controller cancellation checkpoint before any mutation.',
        context: { kind: 'localsend.action-scope-cancel/v1' } });
      throw new Error('cancel checkpoint must not be resumed');
    }
    await tap('settings', read, one(named(read, '设置')));
    read = await observe('settings System', r => has(r, '主题') && has(r, '跟随系统'));
    await tap('open System theme menu', read, themeValue(read, '跟随系统'), 'push');
    read = await observe('theme menu', r => has(r, '浅色') && has(r, '深色'));
    await tap('select Dark', read, one(named(read, '深色')), 'pop');
    read = await observe('settings Dark', r => has(r, '主题') && has(r, '深色'));
    await oracle('dark', { ...BASELINE, 'flutter.ls_theme': 'dark' });
    await tap('open Dark theme menu', read, themeValue(read, '深色'), 'push');
    read = await observe('restore theme menu', r => has(r, '浅色') && has(r, '跟随系统'));
    await tap('restore System', read, one(named(read, '跟随系统')), 'pop');
    read = await observe('settings restored', r => has(r, '主题') && has(r, '跟随系统') && !has(r, '深色'));
    await oracle('restored', BASELINE);
    const receive = named(read, '接收').filter(node => node.bounds.top > read.result.viewport.logicalHeight - 100);
    await tap('Receive', read, one(receive));
    await observe('final Receive', r => has(r, '通过链接接收'));
    return { gate: 'passed', assertions, routes, oracles, fullAppAcceptance: 'inconclusive' };
  } catch (error) {
    return { gate: 'failed', error: error.message, assertions, routes, oracles, fullAppAcceptance: 'inconclusive' };
  }
}

module.exports = { main };
