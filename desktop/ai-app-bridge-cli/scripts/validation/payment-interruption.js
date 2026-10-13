'use strict';

// Crash after the payment tap reaches the device but before the program can
// commit its next checkpoint. Reentry must query the existing order, not pay.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const outDir = ctx.inputs.outDir;
  let confirmations = 0;
  const recovery = ctx.resume();
  const bound = { ...ctx, call: async (command, args = {}) => {
    const payment = !recovery && command === 'tap-flutter-text'
      && args.targetText === '确认操作' && ++confirmations === 2;
    if (payment) await ctx.checkpoint('before-payment', { phase: 'query-payment', runId: ctx.inputs.runId });
    const began = Date.now(), reply = await ctx.call(command, args);
    fs.appendFileSync(path.join(outDir, 'command-observations.jsonl'), JSON.stringify({ command, args,
      elapsedMs: Date.now() - began, ok: reply.ok, dispatched: reply.dispatched, ambiguous: reply.ambiguous,
      actionId: reply.execution?.actionId }) + '\n');
    if (payment && reply.ok && reply.dispatched === true && !reply.ambiguous) {
      fs.writeFileSync(path.join(outDir, 'interrupted-payment-receipt.json'), JSON.stringify(reply, null, 2));
      process.exit(31);
    }
    return reply;
  } };
  if (!recovery) return require(path.join(path.dirname(ctx.inputs.helperPath), 'city-flow.js')).main(bound);
  if (recovery.phase !== 'query-payment' || recovery.runId !== ctx.inputs.runId) throw new Error('Unexpected recovery state');
  const lab = require(ctx.inputs.helperPath)(bound);
  const { call, wait, tapFlutter: tap, flutterInput: input, check } = lab;
  lab.phase('query-interrupted-payment');
  let error;
  try {
    await call('screenshot', { outFile: path.join(outDir, 'before-reconciliation.png') });
    await tap('查询订单结果');
    await wait('flutter', '订单状态：已支付');
    await ctx.checkpoint('payment-confirmed-by-query', { phase: 'refund', runId: ctx.inputs.runId });
    await tap('申请退款');
    await input('退款原因', 'Script 中断后查询原支付并退款');
    await tap('提交退款申请');
    await tap('确认操作');
    await wait('flutter', '订单状态：已退款');
    await call('screenshot', { outFile: path.join(outDir, 'recovered-refund.png') });
    const state = await (await fetch(`${ctx.inputs.hostBase}/__state?run=${encodeURIComponent(ctx.inputs.runId)}`)).json();
    await check('One original order, no replayed checkout', Object.keys(state.commerce.orders).length === 1 && state.commerce.orderAttempts === 1);
    await check('One payment despite worker death and lost response', state.commerce.paymentAttempts === 1 && state.commerce.faults.includes('payment_response_lost'));
    await check('Exact original payment and one refund', JSON.stringify(state.commerce.ledger.map(e => [e.type, e.amount])) === JSON.stringify([['payment', 4100], ['refund', 4100]]));
    await check('Same order completed and stock restored', state.commerce.orders.BUY1.status === 'refunded' && state.commerce.products[0].variants[0].stock === 12);
  } catch (failure) { error = failure; }
  return lab.report(error);
};
