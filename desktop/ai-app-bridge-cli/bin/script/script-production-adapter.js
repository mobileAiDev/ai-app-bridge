'use strict';

const { androidAppTargetKey, getProcessTargetLease } = require('../shared-kernel/target-lease-protocol');

function createProductionScriptDeviceAdapter({
  lease = getProcessTargetLease(),
  ports = null,
  adb = process.env.ADB || 'adb',
} = {}) {
  const impl = ports || require('../ai-app-bridge');
  let currentActive = 0;
  let maxActive = 0;
  const calls = [];

  async function withDevice(serial, packageName, name, fn) {
    const waitStarted = Date.now();
    const held = lease.acquire(androidAppTargetKey(serial, packageName));
    if (!held.ok) {
      return {
        ...held,
        serial,
        packageName,
        targetLeaseWaitMs: Date.now() - waitStarted,
      };
    }
    currentActive += 1;
    maxActive = Math.max(maxActive, currentActive);
    calls.push({ name, serial, packageName, atMs: Date.now() });
    try {
      const result = await fn();
      return {
        ...result,
        adbTimings: [],
        targetLeaseWaitMs: Date.now() - waitStarted,
      };
    } finally {
      currentActive -= 1;
      held.release();
    }
  }

  function context(target) {
    return impl.createBridgeContext({
      serial: target.serial,
      packageName: target.packageName,
      port: target.port,
      adb: target.adb || adb,
    });
  }

  return {
    calls,
    adbTimings: [],
    get maxActive() { return maxActive; },
    get callCount() { return calls.length; },
    async observe({ serial, packageName, provider, rawTreeId, port }) {
      return withDevice(serial, packageName, `observe:${provider}`, async () => {
        const ctx = context({ serial, packageName, port });
        try {
          let rawTree;
          if (provider === 'uia') rawTree = await impl.uiaTreeOnce(ctx);
          else if (provider === 'flutter') rawTree = await impl.flutterNodes(ctx);
          else rawTree = await impl.bridgeTree(ctx);
          return {
            ok: true,
            provider,
            rawTreeId,
            rawTree,
            foregroundTarget: packageName,
          };
        } catch (error) {
          return { ok: false, error: error.message || String(error) };
        }
      });
    },
    async action({ serial, spec, packageName, port, rawTree }) {
      const targetPackageName = packageName || spec.packageName;
      return withDevice(serial, targetPackageName, 'action', async () => {
        const ctx = context({ serial, packageName: targetPackageName, port });
        try {
          if (spec.action === 'back' && spec.provider === 'flutter') {
            const result = await impl.flutterAction(ctx, { action: 'back' });
            if (result?.handled === false) {
              return {
                ok: false,
                mechanicalStatus: 'failed',
                providerResult: result,
                ambiguous: false,
                error: 'back_not_handled',
              };
            }
            return shapeAction(result);
          }
          if (spec.action === 'input' && spec.text) {
            return shapeAction(await inputHost(adb, ctx, spec.text));
          }
          if (spec.action === 'back' || spec.action === 'keyevent') {
            return shapeAction(await impl.keyevent(ctx, spec.keyCode != null ? spec.keyCode : 4));
          }
          if (spec.action === 'scroll' || spec.action === 'scrollBy') {
            if (spec.provider === 'flutter') {
              return shapeAction(await impl.flutterAction(ctx, {
                action: 'scrollBy',
                delta: spec.delta != null ? spec.delta : 420,
              }));
            }
            return shapeAction(await scrollHost(impl, ctx, spec, rawTree));
          }
          if (spec.provider === 'flutter' && spec.action === 'tap' && spec.text) {
            return shapeAction(await tapFromFlutterObservedTree(impl, ctx, spec, rawTree));
          }
          if (spec.provider === 'uia' && spec.text) {
            return shapeAction(await tapFromUiaObservedTree(impl, ctx, spec, rawTree));
          }
          return shapeAction(await tapFromNativeObservedTree(impl, ctx, spec, rawTree));
        } catch (error) {
          return {
            ok: false,
            mechanicalStatus: 'failed',
            providerResult: null,
            ambiguous: false,
            error: error.message || String(error),
          };
        }
      });
    },
    async launch({ serial, packageName, kind, port }) {
      return withDevice(serial, packageName, `launch:${kind || 'app'}`, async () => {
        const ctx = context({ serial, packageName, port });
        if (kind === 'flutter') return impl.launchFlutter(ctx, '');
        if (kind === 'native-test') return impl.launchNativeTest(ctx);
        return impl.launchApp(ctx);
      });
    },
  };
}

function inputHost(adbBin, ctx, text) {
  return new Promise((resolve) => {
    const child = spawn(adbBin, ['-s', ctx.serial, 'shell', 'input', 'text', String(text)], { windowsHide: true });
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message || String(error) });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: 'input_failed' });
        return;
      }
      resolve({ ok: true, transport: 'adb', text });
    });
  });
}

async function tapFromUiaObservedTree(impl, ctx, spec, rawTree) {
  if (!rawTree) return { ok: false, error: 'observed_tree_required' };
  const node = impl.findUiaNodeByAny(rawTree, {
    texts: [spec.text],
    exact: spec.exact === true,
    requireClickable: spec.requireClickable === true,
  });
  if (!node) return { ok: false, error: 'text_not_found' };
  const x = Math.round((node.left + node.right) / 2);
  const y = Math.round((node.top + node.bottom) / 2);
  return impl.tap(ctx, x, y);
}

async function tapFromNativeObservedTree(impl, ctx, spec, rawTree) {
  if (!rawTree) return { ok: false, error: 'observed_tree_required' };
  const match = impl.findTappableNodeByText(rawTree, spec.text);
  const node = match && match.node;
  if (!node || !node.bounds) return { ok: false, error: 'text_not_found' };
  const x = Math.round((node.bounds.left + node.bounds.right) / 2);
  const y = Math.round((node.bounds.top + node.bounds.bottom) / 2);
  return impl.tap(ctx, x, y);
}

async function scrollHost(impl, ctx, spec, rawTree) {
  const xml = rawTree;
  if (!xml) return { ok: false, error: 'observed_tree_required' };
  const viewport = impl.parseUiaViewport(xml);
  if (!viewport || !viewport.width || !viewport.height) {
    return { ok: false, error: 'viewport_unavailable' };
  }
  const startX = Math.round(viewport.left + viewport.width / 2);
  const startY = Math.round(viewport.top + viewport.height * 0.76);
  const endY = Math.round(viewport.top + viewport.height * 0.22);
  return impl.swipe(ctx, startX, startY, startX, endY, spec.durationMs != null ? spec.durationMs : 400);
}

async function tapFromFlutterObservedTree(impl, ctx, spec, rawTree) {
  if (!rawTree) return { ok: false, error: 'observed_tree_required' };
  const nodes = Array.isArray(rawTree.nodes) ? rawTree.nodes : [];
  const node = nodes.find((item) => item.text === spec.text && item.tap?.bounds)
    || nodes.find((item) => item.text === spec.text && item.bounds);
  if (!node) return { ok: false, error: 'text_not_found' };
  const bounds = node.tap?.bounds || node.bounds;
  const dpr = Number(rawTree.viewport?.devicePixelRatio || 0);
  if (bounds && dpr) {
    const x = Math.round(Number(bounds.centerX != null ? bounds.centerX : (bounds.left + bounds.right) / 2) * dpr);
    const y = Math.round(Number(bounds.centerY != null ? bounds.centerY : (bounds.top + bounds.bottom) / 2) * dpr);
    return impl.tap(ctx, x, y);
  }
  return impl.flutterAction(ctx, { action: 'tapText', text: spec.text });
}

function shapeAction(result) {
  return {
    ok: result?.ok !== false,
    mechanicalStatus: result?.ok === false ? 'failed' : 'ok',
    providerResult: result,
    ambiguous: false,
    error: result?.error || null,
  };
}

module.exports = {
  createProductionScriptDeviceAdapter,
};
