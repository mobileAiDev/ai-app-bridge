'use strict';

// One real JavaScript Script, normal relative import, repeated complete Memos
// journeys with independent markers. No artificial sleep between journeys.
exports.main = async ctx => {
  const { main } = require('./memos-flow');
  const started = Date.now(), cases = [], timings = [];
  for (let i = 0; i < ctx.inputs.count; i++) {
    const marker = `${ctx.inputs.marker}-${i + 1}`, tag = marker.toLowerCase();
    const sample = { marker, tag, credentialsPath: ctx.inputs.credentialsPath,
      content: `${marker}\n\n买菜与发版计划。\n- [ ] 牛奶 2 瓶\n- [ ] 验证富文本编辑器\n#${tag}`,
      editedContent: `${marker}\n\n买菜与发版计划。\n- [x] 牛奶 2 瓶\n- [ ] 验证富文本编辑器与保存结果\n#${tag}\n编辑完成：Script edit verified.` };
    const began = Date.now();
    const result = await main({ ...ctx, inputs: sample });
    cases.push({ ...sample, assertionCount: result.assertionCount });
    timings.push(Date.now() - began);
  }
  return { ok: true, cases, timings, elapsedMs: Date.now() - started };
};
