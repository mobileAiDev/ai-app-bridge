'use strict';

// Deliberate live Agent intervention. Ordinary city runs do not pause here.
module.exports = async (ctx, lab) => {
  const fs = require('node:fs'), path = require('node:path');
  const permission = 'android.permission.ACCESS_COARSE_LOCATION';
  const before = await lab.call('permission-state', { permission });
  await lab.check('permission starts denied', before.granted === false);
  const decisions = [];
  for (const outcome of ['deny', 'allow']) {
    await lab.call('tap-native', { selector: { contentDescription: '使用当前位置' } });
    const deadline = Date.now() + 5000;
    let buttons;
    do {
      const tree = await lab.call('uia-tree', { compact: true, maxNodes: 1000 });
      buttons = tree.nodes.filter(n => n.packageName?.includes('permissioncontroller') && n.effectiveVisible !== false && n.enabled && n.clickable && (n.text || n.contentDescription))
        .map(n => ({ text: n.text, description: n.contentDescription, resourceName: n.resourceId, className: n.className, packageName: n.packageName }));
      if (buttons.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    await lab.check(`visible system permission controls for ${outcome}`, buttons.length > 0);
    const controllers = [...new Set(buttons.map(n => n.packageName))];
    await lab.check('one visible permission controller', controllers.length === 1);
    const controller = controllers[0];
    await lab.call('screenshot', { outFile: path.join(ctx.inputs.outDir, `permission-${outcome}-dialog.png`) });
    const began = Date.now();
    const answer = await ctx.askAgent({ question: `Select the currently observed Android permission button to ${outcome} location access. Return {selector:{resourceName:...}}.`,
      desiredOutcome: outcome, packageName: controller, buttons });
    const agentWaitMs = Date.now() - began;
    const decision = { outcome, agentWaitMs, selector: answer.selector };
    decisions.push(decision);
    const save = () => fs.writeFileSync(path.join(ctx.inputs.outDir, 'permission-evidence.json'), JSON.stringify({ before: { granted: before.granted, flags: before.flags }, decisions }, null, 2));
    save();
    await lab.call('tap-uia', { packageName: controller, selector: answer.selector });
    await lab.wait('native', outcome === 'deny' ? '未授权定位，可继续手工填写地址' : '位置权限已允许，请确认配送地址');
    const observed = await lab.call('permission-state', { permission });
    await lab.check(`OS permission is ${outcome}`, observed.granted === (outcome === 'allow'));
    decision.granted = observed.granted; save();
  }
  const tree = await lab.call('tree', { compact: true, maxNodes: 150 });
  await lab.check('address draft survived both permission windows',
    [['收件人', '测试员'], ['联系电话', '13800000000'], ['详细地址', '科技园测试路 100 号']]
      .every(([label, text]) => tree.nodes.some(n => n.contentDescription === label && n.text === text)));
  fs.writeFileSync(path.join(ctx.inputs.outDir, 'permission-evidence.json'), JSON.stringify({ before: { granted: before.granted, flags: before.flags }, decisions }, null, 2));
};
