'use strict';

// Continue the already-open address draft after a previous harness failure.
module.exports.main = async ctx => {
  const path = require('node:path');
  const lab = require(ctx.inputs.helperPath)(ctx);
  let error;
  try {
    lab.phase('resume-existing-address-draft');
    await lab.wait('native', '管理收货地址');
    if (ctx.inputs.permissionAlreadyAnswered) {
      const state = await lab.call('permission-state', { permission: 'android.permission.ACCESS_COARSE_LOCATION' });
      await lab.check('previously allowed permission is independently confirmed', state.granted === true);
      const tree = await lab.call('tree', { compact: true, maxNodes: 150 });
      await lab.check('existing address draft is intact',
        [['收件人', '测试员'], ['联系电话', '13800000000'], ['详细地址', '科技园测试路 100 号']]
          .every(([label, text]) => tree.nodes.some(n => n.contentDescription === label && n.text === text)));
    } else {
      await require(path.join(path.dirname(ctx.inputs.helperPath), 'permission-probe.js'))(ctx, lab);
    }
    await lab.call('tap-native', { selector: { contentDescription: '保存并使用' } });
    await lab.wait('flutter', '原生地址已保存并带回结算页');
    const state = await (await fetch(`${ctx.inputs.hostBase}/__state?run=${encodeURIComponent(ctx.inputs.runId)}`)).json();
    await lab.check('resumed address committed once', state.commerce.addresses.length === 1 && state.commerce.addresses[0].street === '科技园测试路 100 号');
    await lab.call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'returned-checkout.png') });
  } catch (e) { error = e; }
  return lab.report(error);
};
