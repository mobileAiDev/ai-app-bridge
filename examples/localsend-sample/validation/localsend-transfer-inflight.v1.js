'use strict';

// Agent-authored from real Intent reception/cancellation observations. The
// official peer and independent byte oracle are coordinated by the controller.
async function main(ctx) {
  const { serial, peerAlias, file } = ctx.inputs;
  const assertions = [], actions = [];
  const has = (read, text) => read.result.nodes.some(node => node.text === text);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function call(command, args = {}) {
    const value = await ctx.call(command, { serial,
      packageName: 'org.localsend.localsend_app.bridge_sample', ...args });
    if (!value.ok) throw Error(`${command}: ${value.error}`);
    return value;
  }
  async function check(name, condition, read, kind = 'tree') {
    const result = await ctx.assert({ name, condition, predicateSummary: name,
      evidence: read.evidence, requiredEvidence: [kind], requireCoverage: 'complete' });
    assertions.push(result);
    if (result.verdict !== 'passed') throw Error(`${name}: ${result.verdict}`);
  }
  async function observe(name, predicate) {
    const deadline = Date.now() + 20000;
    let previous;
    do {
      const current = await call('flutter-nodes');
      if (current.result.truncated !== false) throw Error('incomplete_flutter_tree');
      // Progress values legitimately change. Require advancing observations of
      // the expected controls, rather than an identical whole-page snapshot.
      if (previous && current.result.updatedAtMs > previous.result.updatedAtMs
        && predicate(previous) && predicate(current)) {
        await check(name, true, current); return current;
      }
      previous = current; await sleep(150);
    } while (Date.now() < deadline);
    throw Error(`${name}: expected page did not appear`);
  }
  async function screenshot(name) {
    const read = await call('screenshot');
    await check(name, read.result.foregroundMatchesPackage === true, read, 'screenshot');
  }
  async function tap(read, text) {
    const nodes = read.result.nodes.filter(node => node.text === text);
    await check(`one ${text} target`, nodes.length === 1, read);
    const value = await call('tap-flutter', { selector: { nodeId: nodes[0].id } });
    if (!value.execution.actionId || value.result.request.actionId !== value.execution.actionId)
      throw Error('action_identity_mismatch');
    actions.push({ text, actionId: value.execution.actionId });
  }
  async function peer(operation) {
    const response = await ctx.askAgent({ question: `Official peer: ${operation}`,
      context: { kind: 'localsend.transfer-inflight/v1', operation, file } });
    if (response.ok !== true) throw Error(`official_peer_${operation}_failed`);
    return response;
  }
  try {
    await observe('initial Receive', read => has(read, '通过链接接收'));
    await peer('offer');
    let read = await observe('real one-file offer', value => has(value, '想要发送给你一个文件')
      && has(value, '接受') && has(value, '拒绝') && has(value, peerAlias));
    await tap(read, '接受');
    const progress = await peer('verify-growing');
    if (progress.samples.length < 2 || progress.samples.at(-2).bytes < 1024 * 1024
      || progress.samples.at(-2).bytes >= progress.samples.at(-1).bytes
      || progress.samples.at(-1).bytes >= file.bytes) throw Error('independent_growth_not_proven');
    read = await observe('receiving before completion', value => has(value, '正在接收文件')
      && has(value, '取消') && !has(value, '已完成'));
    await screenshot('in-progress screenshot');
    await tap(read, '取消');
    read = await observe('cancel confirmation', value => has(value, '要取消文件传输吗？')
      && has(value, '继续') && has(value, '取消'));
    await screenshot('confirmation screenshot');
    await tap(read, '取消');
    await observe('returned to Receive', value => has(value, '通过链接接收'));
    await screenshot('final Receive screenshot');
    const partial = await peer('verify-cancelled-partial');
    if (partial.bytes < progress.samples.at(-1).bytes || partial.bytes >= file.bytes
      || partial.sourceMatchesManifest !== true || partial.bytesEqualToSourcePrefix !== true
      || partial.sizeUnchangedDuringRead !== true || partial.peerOutcome !== 'receiver-cancelled')
      throw Error('independent_partial_or_peer_outcome_failed');
    return { gate: 'passed', assertions, actions, progress, partial, fullAppAcceptance: 'inconclusive' };
  } catch (error) {
    return { gate: 'failed', error: error.message, assertions, actions, fullAppAcceptance: 'inconclusive' };
  }
}

module.exports = { main };
