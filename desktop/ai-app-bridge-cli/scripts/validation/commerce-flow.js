'use strict';
module.exports.main = async ctx => {
  const lab = require(ctx.inputs.helperPath)(ctx);
  const { call, check, wait, tapFlutter: tap, flutterInput: input, scrollFlutter: scroll } = lab;
  let error;
  try {
    const uri = `bridge-workflow-lab://commerce?base=${encodeURIComponent(ctx.inputs.deviceBase)}&run=${encodeURIComponent(ctx.inputs.runId)}`;
    await call('launch-activity', { activity: '.MainActivity', action: 'android.intent.action.VIEW', data: uri });
    await wait('flutter', '账号登录');
    lab.phase('login');
    await input('登录账号', 'bridge@example.test');
    await input('登录密码', 'fixture-password');
    await tap('同意用户协议');
    await tap('登录并继续');
    await wait('flutter', '商品目录');
    lab.phase('search-and-variant');
    await input('搜索商品', 'P001');
    await tap('搜索');
    await wait('flutter', '共 1 件，第 1 页');
    await tap('随行保温杯 · P001');
    await tap('加入购物车');
    await wait('flutter', '请先选择规格');
    await tap('标准款 ¥25.00');
    await tap('加入购物车');
    await wait('flutter', '已加入购物车');
    await tap('查看购物车');
    await wait('flutter', '购物车，共 1 项');
    lab.phase('cart-and-address');
    await tap('增加 V1-0');
    await wait('flutter', 'V1-0 数量 2，小计 ¥50.00');
    await tap('填写地址并结算');
    await input('收件人', '测试员');
    await input('联系电话', '123');
    await input('详细地址', '测试路 100 号');
    await input('优惠码', 'SAVE10');
    await tap('核算金额');
    await wait('flutter', 'address_invalid (HTTP 422)');
    await input('联系电话', '13800000000');
    await tap('核算金额');
    await wait('flutter', '应付 ¥46.00');
    lab.phase('checkout-and-payment');
    await tap('提交订单');
    await tap('返回修改');
    await tap('提交订单');
    await tap('确认操作');
    await wait('flutter', '订单状态：待支付');
    await tap('支付测试订单');
    await tap('确认操作');
    if (ctx.inputs.config.paymentResponseLostOnce) {
      // A dispatched payment with no response is reconciled by GET, never
      // automatically submitted a second time by the script.
      await call('wait-text', { provider: 'flutter', targetText: '已提交的订单或支付请先查询结果。', timeoutMs: 10000, intervalMs: 50 });
      await tap('查询订单结果');
    }
    await wait('flutter', '订单状态：已支付');
    lab.phase('refund-and-history');
    await tap('申请退款');
    await input('退款原因', '端到端验收完成，恢复测试库存');
    await tap('提交退款申请');
    await tap('确认操作');
    await wait('flutter', '订单状态：已退款');
    await tap('返回商城');
    await wait('flutter', '商品目录');
    await scroll('我的订单');
    await tap('我的订单');
    await wait('flutter', '订单 BUY1');
    await tap('订单 BUY1');
    await wait('flutter', '订单状态：已退款');
    lab.phase('independent-verification');
    const state = await (await fetch(`${ctx.inputs.hostBase}/__state?run=${encodeURIComponent(ctx.inputs.runId)}`)).json();
    await check('Exactly one order with independently calculated total', Object.keys(state.commerce.orders).length === 1 && state.commerce.orders.BUY1.payable === 4600);
    await check('One payment and matching refund', JSON.stringify(state.commerce.ledger.map(entry => [entry.type, entry.amount])) === JSON.stringify([['payment', 4600], ['refund', 4600]]));
    await check('Payment submitted once, including response-loss variant', state.commerce.paymentAttempts === 1);
    await check('Inventory restored and cart empty', state.commerce.products[0].variants[0].stock === 12 && state.commerce.cart.length === 0);
  } catch (e) { error = e; }
  return lab.report(error);
};
