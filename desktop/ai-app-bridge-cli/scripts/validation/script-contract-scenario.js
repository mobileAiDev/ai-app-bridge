'use strict';

// Real child programs for script-contract.js. All device I/O goes through ctx.call.
// Only launch-app changes device state; no sample-specific selectors or data writes.
const fs = require('node:fs');
const path = require('node:path');

module.exports.main = async function main(ctx) {
  const { scenario, out, foreignEvidence } = ctx.inputs;
  const save = (name, value) => {
    fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    return value;
  };
  const call = async (name, command, args = {}) => {
    const result = save(name, await ctx.call(command, args));
    if (!result.ok) throw new Error(`${command}:${result.error}`);
    return result;
  };
  const tree = (name) => call(name, 'tree', { compact: true, visibleOnly: true, maxNodes: 100 });
  const judge = async (name, condition, evidence, requiredEvidence = ['tree']) =>
    save(name, await ctx.assert({ name, condition, evidence, requiredEvidence }));
  const visible = (read) => Array.isArray(read.result.nodes) && read.result.nodes.some(node => node.visible === true);

  if (scenario === 'seed' || scenario === 'after-cancel') {
    await call('launch', 'launch-app');
    const read = await tree('tree');
    await call('screenshot', 'screenshot', { outFile: path.join(out, 'screen.png') });
    return { verdict: await judge('fresh-tree', visible(read), read.evidence), evidence: read.evidence };
  }

  if (scenario === 'evidence') {
    const read = await tree('before');
    const verdicts = {};
    verdicts.fresh = await judge('fresh', visible(read), read.evidence);
    verdicts.falsePredicate = await judge('false-predicate', read.result.nodes.length === 0, read.evidence);
    verdicts.missing = await judge('missing', true, undefined);
    verdicts.wrongStream = await judge('wrong-stream', true, read.evidence, ['network']);
    const changed = structuredClone(read.evidence);
    changed.source.payloadSha256 = '0'.repeat(64);
    verdicts.tampered = await judge('tampered', true, changed);
    verdicts.foreign = await judge('foreign', true, foreignEvidence);
    verdicts.code = save('code', await ctx.assert({ scope: 'code', name: 'code-only', condition: 6 * 7 === 42 }));
    await call('launch', 'launch-app');
    verdicts.stale = await judge('stale', visible(read), read.evidence);
    const after = await tree('after');
    verdicts.refreshed = await judge('refreshed', visible(after), after.evidence);
    return { verdicts };
  }

  if (scenario === 'cancel') {
    await tree('before-cancel');
    await ctx.askAgent({ question: 'Contract fixture: controller cancels this operation.' });
    await call('after-cancel-mutation', 'launch-app');
    throw new Error('cancelled_child_continued');
  }

  if (scenario === 'child-crash' || scenario === 'host-restart' || scenario === 'no-restart') {
    const resumed = ctx.resume();
    if (!resumed) {
      await call('launch-once', 'launch-app');
      const read = await tree('before-restart');
      await ctx.checkpoint('observed-before-restart', { evidence: read.evidence });
      if (scenario === 'child-crash') process.exit(31);
      await ctx.askAgent({ question: 'Contract fixture: controller restarts the MCP process.' });
      throw new Error('interrupted_child_continued');
    }
    const old = await judge('old-observation-after-restart', true, resumed.evidence);
    const status = await call('resumed-status', 'status');
    const read = await tree('after-restart');
    return { old, fresh: await judge('fresh-after-restart', visible(read), read.evidence), app: status.result.app };
  }

  if (scenario === 'effect-after-checkpoint') {
    await ctx.checkpoint('before-effect', { stage: 'before-effect' });
    await call('effect', 'launch-app');
    process.exit(31);
  }
  throw new Error(`unknown_contract_scenario:${scenario}`);
};
