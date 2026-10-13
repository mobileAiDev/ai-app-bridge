'use strict';
module.exports.main = async ctx => {
  const path = require('node:path');
  const lab = require(ctx.inputs.helperPath)(ctx);
  const { call, check, tapNative: tap } = lab;
  const wait = text => lab.wait('native', text);
  const input = (key, text) => call('input-text', { selector: { contentDescription: key }, text });
  const tapText = text => call('tap-native', { selector: { text } });
  const screenshot = name => call('screenshot', { outFile: path.join(ctx.inputs.outDir, `${name}.png`) });
  const payable = ctx.inputs.config.stalePriceOnce ? 4300 : 4100;
  const payableText = `¥${(payable / 100).toFixed(2)}`;
  let error;
  try {
    await call('launch-activity', { activity: '.NativeCommerceActivity', clearTask: true, extra: [`lab_base_url=${ctx.inputs.deviceBase}`, `lab_run=${ctx.inputs.runId}`] });
    await wait('原生账号登录');
    lab.phase('native-login');
    await input('city_account', 'bridge@example.test');
    await input('city_password', 'fixture-password');
    await tap('city_agreement');
    await tap('city_login');
    await wait('门店 48 家 · 第 1 页');
    await screenshot('market');
    lab.phase('native-webview-campaign');
    await tap('city_campaign');
    await call('h5-wait', { selector: { text: '领取 CITY5', tag: 'button' }, timeoutMs: 10000, intervalMs: 50 });
    await screenshot('campaign');
    await call('h5-click', { selector: { text: '领取 CITY5', tag: 'button' } });
    await call('h5-click', { selector: { ariaLabel: '同意活动规则' } });
    await call('h5-click', { selector: { text: '确认领取', tag: 'button' } });
    await call('h5-wait', { selector: { text: '已领取 CITY5', tag: 'button' }, timeoutMs: 10000, intervalMs: 50 });
    await call('h5-click', { selector: { text: '返回商城', tag: 'button' } });
    await wait('门店 48 家 · 第 1 页');
    lab.phase('merchant-and-product-search');
    await input('city_search', 'S001');
    await tap('city_search_submit');
    await wait('门店 1 家 · 第 1 页');
    await tap('city_shop_S001');
    await wait('店内商品 144 件 · 第 1 页');
    await screenshot('store');
    await tap('city_sku_P001');
    await wait('标准款 ¥25.00');
    await screenshot('sku');
    await tapText('标准款 ¥25.00');
    await tapText('加入购物车');
    await wait('已加入购物车');
    await tap('city_cart');
    await wait('购物车 1 项');
    await tap('city_plus_V1-0');
    await wait('V1-0 数量 2 · ¥50.00');
    await tap('city_checkout');
    lab.phase('native-checkout');
    for (const [key, text] of Object.entries({ recipient: '测试员', phone: '13800000000', street: '科技园测试路 100 号', coupon: 'SAVE10', platformCoupon: 'CITY5' })) {
      await input(`city_${key}`, text);
    }
    await tap('city_quote');
    if (ctx.inputs.config.expireSessionOnceAt === '/api/shop/quote') {
      lab.phase('native-expired-session');
      await wait('登录已失效，请重新登录；结算草稿和服务端记录已保留');
      await screenshot('expired-session');
      await input('city_account', 'bridge@example.test');
      await input('city_password', 'fixture-password');
      await tap('city_agreement');
      await tap('city_login');
      await wait('原生订单结算');
      await call('wait-text', { provider: 'native', timeoutMs: 10000,
        requireText: ['测试员', '13800000000', '科技园测试路 100 号', 'SAVE10', 'CITY5'] });
      await screenshot('retained-checkout-draft');
      await tap('city_quote');
    }
    await wait('应付 ¥41.00');
    await screenshot('checkout');
    await tap('city_submit');
    await tapText('确认操作');
    if (ctx.inputs.config.stalePriceOnce) {
      await wait('请求失败 409：price_changed，可修正后重试');
      await tap('city_quote');
      await wait(`应付 ${payableText}`);
      await tap('city_submit');
      await tapText('确认操作');
    }
    await wait('订单状态：待支付');
    lab.phase('payment-and-refund');
    await tap('city_pay');
    await tapText('确认操作');
    if (ctx.inputs.config.paymentResponseLostOnce) {
      // A committed payment whose HTTP response is lost is queried, never replayed.
      await wait('结果未确认：IOException。订单和支付请先查询结果。');
      await tap('city_query');
    }
    await wait('订单状态：已支付');
    await tap('city_refund');
    await input('city_refund_reason', '纯原生复杂流程验收');
    await tap('city_refund_submit');
    await tapText('确认操作');
    await wait('订单状态：已退款');
    await screenshot('refund');
    await tap('city_home');
    await wait('门店 48 家 · 第 1 页');
    await tap('city_orders');
    await wait(`BUY1 · refunded · ${payableText}`);
    await tap('city_order_BUY1');
    await wait('订单状态：已退款');
    const state = await (await fetch(`${ctx.inputs.hostBase}/__state?run=${encodeURIComponent(ctx.inputs.runId)}`)).json();
    await check('Native session and H5 coupon persisted', state.sessions === (ctx.inputs.config.expireSessionOnceAt ? 2 : 1) && state.commerce.claimedCoupons.includes('CITY5'));
    await check('Two discounts applied to one native order', Object.keys(state.commerce.orders).length === 1 && state.commerce.orders.BUY1.payable === payable && state.commerce.orders.BUY1.platformDiscount === 500);
    await check('Payment and refund committed exactly once', state.commerce.paymentAttempts === 1 && JSON.stringify(state.commerce.ledger.map(entry => [entry.type, entry.amount])) === JSON.stringify([['payment', payable], ['refund', payable]]));
    await check('Only a rejected stale quote was resubmitted', state.commerce.orderAttempts === (ctx.inputs.config.stalePriceOnce ? 2 : 1));
    await check('Native refund restored inventory', state.commerce.products[0].variants[0].stock === 12 && state.commerce.cart.length === 0);
    if (ctx.inputs.config.expireSessionOnceAt) {
      await check('Native expired session recovered exactly once', state.sessionExpiredOnce === true && state.sessions === 2);
      const address = state.commerce.orders.BUY1.address;
      await check('Native checkout fields survive reauthentication without refilling', address.recipient === '测试员' && address.phone === '13800000000' && address.street === '科技园测试路 100 号');
    }
  } catch (e) { error = e; }
  return lab.report(error);
};
