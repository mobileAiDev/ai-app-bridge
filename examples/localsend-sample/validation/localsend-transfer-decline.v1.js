'use strict';

// Authored from the real rejection and sender cancellation Intents 05 and 06.
// The sender cancels while the receiver has not accepted; this is not an
// in-flight transfer cancellation scenario.
async function main(ctx) {
  const { serial, peerAlias, file, outcome } = ctx.inputs;
  const assertions = [], actions = [];
  const has = (read, text) => read.result.nodes.some(node => node.text === text);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function call(command, args = {}) {
    const value = await ctx.call(command, { serial, packageName: 'org.localsend.localsend_app.bridge_sample', ...args });
    if (!value.ok) throw Error(`${command}: ${value.error}`);
    return value;
  }
  async function check(name, condition, read, kind = 'tree') {
    const value = await ctx.assert({ name, condition, predicateSummary: name, evidence: read.evidence,
      requiredEvidence: [kind], requireCoverage: 'complete' });
    assertions.push(value);
    if (value.verdict !== 'passed') throw Error(`${name}: ${value.verdict}`);
  }
  async function observe(name, predicate) {
    const deadline = Date.now() + 20000;
    let previous;
    do {
      const current = await call('flutter-nodes');
      if (current.result.truncated !== false) throw Error('incomplete_flutter_tree');
      if (previous && current.result.updatedAtMs > previous.result.updatedAtMs
        && predicate(previous) && predicate(current)) {
        await check(name, true, current); return current;
      }
      previous = current; await sleep(150);
    } while (Date.now() < deadline);
    throw Error(`${name}: expected page did not appear`);
  }
  async function screenshot(name) {
    const value = await call('screenshot');
    await check(name, value.result.foregroundMatchesPackage === true, value, 'screenshot');
  }
  async function tap(read, text) {
    const nodes = read.result.nodes.filter(node => node.text === text);
    await check(`one ${text} target`, nodes.length === 1, read);
    const result = await call('tap-flutter', { selector: { nodeId: nodes[0].id } });
    if (!result.execution.actionId || result.result.request.actionId !== result.execution.actionId)
      throw Error('action_identity_mismatch');
    actions.push({ text, actionId: result.execution.actionId });
  }
  async function peer(operation) {
    const response = await ctx.askAgent({ question: `Official peer: ${operation}`,
      context: { kind: 'localsend.transfer-decline/v1', operation, file, outcome } });
    if (response.ok !== true) throw Error(`official_peer_${operation}_failed`);
    return response;
  }
  try {
    if (!['reject', 'sender-cancel'].includes(outcome)) throw Error('unsupported_transfer_outcome');
    await observe('initial Receive', value => has(value, '通过链接接收'));
    await peer('offer');
    let read = await observe('real one-file offer', value => has(value, '想要发送给你一个文件')
      && has(value, '接受') && has(value, '拒绝'));
    await check('expected official peer is visible', has(read, peerAlias), read);
    await screenshot('offer screenshot');
    if (outcome === 'reject') await tap(read, '拒绝');
    else {
      await peer('cancel-pending-request');
      read = await observe('sender cancellation visible', value => has(value, '发送者取消了请求。') && has(value, '关闭'));
      await screenshot('cancelled request screenshot');
      await tap(read, '关闭');
    }
    await observe('returned to Receive', value => has(value, '通过链接接收'));
    await screenshot('final Receive screenshot');
    const oracle = await peer('verify-absent');
    if (oracle.fileName !== file.name || oracle.matches.length !== 0 || oracle.peerOutcome !== outcome)
      throw Error('independent_nonreceipt_oracle_failed');
    return { gate: 'passed', outcome, assertions, actions, oracle, fullAppAcceptance: 'inconclusive' };
  } catch (error) {
    return { gate: 'failed', error: error.message, outcome, assertions, actions, fullAppAcceptance: 'inconclusive' };
  }
}

module.exports = { main };
