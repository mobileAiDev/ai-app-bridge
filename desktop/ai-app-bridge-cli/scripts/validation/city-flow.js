'use strict';
module.exports.main = async ctx => {
  const path = require('node:path');
  const lab = require(ctx.inputs.helperPath)(ctx);
  const { call, check, wait, tapFlutter: tap, flutterInput: input, scrollFlutter: scroll } = lab;
  const screenshot = name => call('screenshot', { outFile: path.join(ctx.inputs.outDir, `${name}.png`) });
  let error;
  try {
    const uri = `bridge-workflow-lab://city?base=${encodeURIComponent(ctx.inputs.deviceBase)}&run=${encodeURIComponent(ctx.inputs.runId)}`;
    await call('launch-activity', { activity: '.MainActivity', action: 'android.intent.action.VIEW', data: uri });
    await wait('flutter', '账号登录');
    lab.phase('login');
    await input('登录账号', 'bridge@example.test');
    await input('登录密码', 'fixture-password');
    await tap('同意用户协议');
    await tap('登录并继续');
    await wait('flutter', '附近门店');
    await screenshot('market');
    lab.phase('h5-campaign');
    await tap('活动');
    await call('h5-wait', { selector: { text: '领取 CITY5', tag: 'button' }, timeoutMs: 10000, intervalMs: 50 });
    await screenshot('campaign');
    await call('h5-click', { selector: { text: '领取 CITY5', tag: 'button' } });
    await call('h5-click', { selector: { ariaLabel: '同意活动规则' } });
    await call('h5-click', { selector: { text: '确认领取', tag: 'button' } });
    await call('h5-wait', { selector: { text: '已领取 CITY5', tag: 'button' }, timeoutMs: 10000, intervalMs: 50 });
    await call('h5-click', { selector: { text: '返回商城', tag: 'button' } });
    await wait('flutter', '附近门店');
    lab.phase('merchant-search-and-sku');
    await input('搜索门店或商品', 'S001');
    await tap('搜索');
    await wait('flutter', '1 家可配送');
    await scroll('门店 S001 · 0.5km · 起送 ¥20');
    await tap('门店 S001 · 0.5km · 起送 ¥20');
    await wait('flutter', '店内商品');
    await screenshot('store');
    await tap('选规格 P001');
    await wait('flutter', '选择规格');
    await screenshot('sku');
    await tap('标准款 ¥25.00');
    await tap('选好了，加入购物车');
    await wait('flutter', '已加入购物车');
    await tap('查看购物车');
    await wait('flutter', '购物车，共 1 项');
    await tap('增加 V1-0');
    await wait('flutter', 'V1-0 数量 2，小计 ¥50.00');
    await tap('填写地址并结算');
    lab.phase('native-address');
    await tap('管理收货地址');
    await wait('native', '管理收货地址');
    await screenshot('native-address');
    for (const [label, text] of [['收件人', '测试员'], ['联系电话', '13800000000'], ['详细地址', '科技园测试路 100 号']]) {
      await call('input-text', { selector: { contentDescription: label }, text });
    }
    if (ctx.inputs.config.permissionProbe) {
      lab.phase('system-permission-and-agent-intervention');
      await require(path.join(path.dirname(ctx.inputs.helperPath), 'permission-probe.js'))(ctx, lab);
    }
    await call('tap-native', { selector: { contentDescription: '保存并使用' } });
    await wait('flutter', '原生地址已保存并带回结算页');
    lab.phase('stacked-discounts-and-checkout');
    await input('平台优惠码', 'CITY5');
    await scroll('优惠码');
    await input('优惠码', 'SAVE10');
    await scroll('核算金额');
    await tap('核算金额');
    if (ctx.inputs.config.expireSessionOnceAt === '/api/shop/quote') {
      lab.phase('expired-session-and-retained-draft');
      await wait('flutter', '登录已失效，重新登录后继续，草稿已保留');
      await screenshot('expired-session');
      await tap('登录并继续');
      await wait('flutter', '收货地址与结算');
      await screenshot('retained-checkout-draft');
      await scroll('核算金额');
      await tap('核算金额');
    }
    await wait('flutter', '应付 ¥41.00');
    await screenshot('checkout');
    await scroll('提交订单');
    await tap('提交订单');
    await tap('确认操作');
    await wait('flutter', '订单状态：待支付');
    await tap('支付测试订单');
    await tap('确认操作');
    if (ctx.inputs.config.paymentResponseLostOnce) {
      lab.phase('payment-response-loss-and-query');
      const deadline = Date.now() + 10000;
      let observedLoss = false;
      do {
        const tree = await call('flutter-nodes');
        observedLoss = tree.nodes.some(n => n.text?.startsWith('连接中断或响应超时：'));
        if (!observedLoss) await new Promise(resolve => setTimeout(resolve, 50));
      } while (!observedLoss && Date.now() < deadline);
      await check('Committed payment response loss is visible before querying', observedLoss);
      await screenshot('payment-response-lost');
      await tap('查询订单结果');
    }
    await wait('flutter', '订单状态：已支付');
    lab.phase('refund-and-oracle');
    await tap('申请退款');
    await input('退款原因', '混合页面完整链路验收');
    await tap('提交退款申请');
    await tap('确认操作');
    await wait('flutter', '订单状态：已退款');
    await screenshot('refund');
    const state = await (await fetch(`${ctx.inputs.hostBase}/__state?run=${encodeURIComponent(ctx.inputs.runId)}`)).json();
    await check('H5 coupon and native address persisted', state.commerce.claimedCoupons.includes('CITY5') && state.commerce.addresses.length === 1 && state.commerce.addresses[0].street === '科技园测试路 100 号');
    await check('Two coupon types applied to one order', Object.keys(state.commerce.orders).length === 1 && state.commerce.orders.BUY1.payable === 4100 && state.commerce.orders.BUY1.platformDiscount === 500);
    await check('Payment and refund each committed once', state.commerce.paymentAttempts === 1 && JSON.stringify(state.commerce.ledger.map(entry => [entry.type, entry.amount])) === JSON.stringify([['payment', 4100], ['refund', 4100]]));
    await check('Inventory restored after refund', state.commerce.products[0].variants[0].stock === 12 && state.commerce.cart.length === 0);
    if (ctx.inputs.config.paymentResponseLostOnce) {
      await check('Lost payment response reconciled without another payment request',
        state.commerce.faults.includes('payment_response_lost') && state.commerce.paymentAttempts === 1);
    }
    if (ctx.inputs.config.expireSessionOnceAt) {
      await check('Expired session recovered exactly once', state.sessionExpiredOnce === true && state.sessions === 2);
      const address = state.commerce.orders.BUY1.address;
      await check('Checkout fields survive reauthentication without refilling', address.recipient === '测试员' && address.phone === '13800000000' && address.street === '科技园测试路 100 号');
    }
  } catch (e) { error = e; }
  return lab.report(error);
};
