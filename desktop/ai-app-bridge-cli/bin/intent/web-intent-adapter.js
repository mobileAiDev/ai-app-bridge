'use strict';

const { selectWebNode, schema } = require('../shared-kernel/web-dom-target');

function createWebIntentDeviceAdapter({ provider } = {}) {
  if (!provider || typeof provider.run !== 'function') throw new TypeError('Web Intent requires the serving Web provider.');
  const bound = target => ({ sessionId: target.sessionId, runtimeEpoch: target.runtimeEpoch, targetId: target.targetId ?? 'main' });
  return {
    async observe(target) {
      const rawTree = await provider.run('web-dom', bound(target));
      if (rawTree.ok !== true) return rawTree;
      if (rawTree.webTargetSchema !== schema) return { ok: false, error: 'web_dom_target_schema_required' };
      return { ok: true, provider: 'h5', rawTreeId: target.rawTreeId, rawTree, foregroundTarget: rawTree.pageRef.url };
    },
    async action(target) {
      const { spec, rawTree } = target;
      const selected = selectWebNode(rawTree, spec.selector);
      if (!selected.ok) return selected;
      const commands = { tap: 'web-click', inputText: 'web-input', pressKey: 'web-key', scroll: 'web-scroll', scrollBy: 'web-scroll' };
      const result = await provider.run(commands[spec.action], { ...bound(target), runtimeActionId: target.actionId,
        selector: { elementId: selected.node.elementId }, expectedTarget: selected.targetRef,
        ...(spec.action === 'inputText' ? { value: spec.value } : {}),
        ...(spec.action === 'pressKey' ? { key: spec.key } : {}),
        ...(spec.action === 'scroll' ? { mode: 'into-view' } : {}),
        ...(spec.action === 'scrollBy' ? { mode: 'by', deltaX: spec.deltaX, deltaY: spec.deltaY } : {}) });
      return { ...result, mechanicalStatus: result.ok === true ? 'ok' : 'failed' };
    },
  };
}

module.exports = { createWebIntentDeviceAdapter };
