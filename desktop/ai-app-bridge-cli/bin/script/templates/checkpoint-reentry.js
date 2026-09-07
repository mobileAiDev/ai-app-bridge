'use strict';

async function main(ctx) {
  const prior = ctx.resume();
  if (prior && prior.step >= 1) {
    return { passed: true, resumed: true, step: prior.step };
  }
  await ctx.call('status', {});
  await ctx.checkpoint('after-status', { step: 1 });
  return { passed: true, resumed: false, step: 1 };
}

module.exports = { main };
