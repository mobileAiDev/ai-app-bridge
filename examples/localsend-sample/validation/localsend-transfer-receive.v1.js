'use strict';

// Authored from localsend-transfer-intent-20260911-03 on LocalSend v1.18.2.
// This source covers real reception and continued UI operation after the
// transfer service stops. The desktop peer and byte oracle live outside Bridge.
async function main(ctx) {
  const { serial, peerAlias, files, manifestSha256 } = ctx.inputs;
  const target = { serial, packageName: 'org.localsend.localsend_app.bridge_sample' };
  const assertions = [], actions = [], oracles = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const named = (read, text) => read.result.nodes.filter(node => node.text === text);
  const has = (read, text) => named(read, text).length > 0;
  async function call(command, args = {}) {
    const result = await ctx.call(command, { ...target, ...args });
    if (!result.ok) throw Error(`${command}: ${result.error}`);
    return result;
  }
  async function check(name, condition, read, kind = 'tree') {
    const result = await ctx.assert({ name, predicateSummary: name, condition,
      evidence: read.evidence, requiredEvidence: [kind], requireCoverage: 'complete' });
    assertions.push(result);
    if (result.verdict !== 'passed') throw Error(`${name}: ${result.verdict}`);
  }
  async function observe(name, predicate) {
    const deadline = Date.now() + 20000;
    let previous;
    do {
      const current = await call('flutter-nodes');
      if (current.result.truncated !== false) throw Error('Flutter observation is incomplete');
      if (previous && current.result.updatedAtMs > previous.result.updatedAtMs
        && predicate(previous) && predicate(current)) {
        await check(name, true, current);
        return current;
      }
      previous = current;
      await sleep(150);
    } while (Date.now() < deadline);
    throw Error(`${name}: expected page did not appear`);
  }
  async function screenshot(name) {
    const read = await call('screenshot');
    await check(name, read.result.foregroundMatchesPackage === true, read, 'screenshot');
    return read;
  }
  async function tap(read, candidates, name) {
    await check(`${name}: one observed target`, candidates.length === 1, read);
    const result = await call('tap-flutter', { selector: { nodeId: candidates[0].id } });
    const actionId = result.execution?.actionId;
    if (!actionId || result.result.request?.actionId !== actionId)
      throw Error(`${name}: provider action identity differs from Script identity`);
    actions.push({ name, actionId, result: result.result });
  }
  try {
    await observe('initial Receive page', read => has(read, '通过链接接收'));
    const offer = await ctx.askAgent({ question: 'Start the verified official LocalSend peer with these exact files.',
      context: { kind: 'localsend.transfer-peer/v1', operation: 'offer', files, peerAlias, manifestSha256 } });
    if (offer.ok !== true || offer.peerAlias !== peerAlias || offer.manifestSha256 !== manifestSha256)
      throw Error('Desktop peer did not confirm the frozen transfer fixture');
    let read = await observe('incoming transfer offer', value => has(value, '接受') && has(value, '拒绝'));
    await check('incoming offer names the expected peer', has(read, peerAlias), read);
    await check('incoming offer contains both files', has(read, '想要发送给你 2 个文件') && files.length === 2, read);
    await screenshot('incoming offer screenshot belongs to LocalSend');
    await tap(read, named(read, '接受'), 'accept fixed files');
    read = await observe('received both files', value => has(value, '已完成')
      && files.every(file => has(value, file.name)));
    await screenshot('completed receive screenshot belongs to LocalSend');
    const oracle = await ctx.askAgent({ question: 'Read the actual Android files and compare bytes with the frozen source manifest.',
      context: { kind: 'localsend.transfer-peer/v1', operation: 'verify-received', files, manifestSha256 } });
    if (oracle.ok !== true || oracle.manifestSha256 !== manifestSha256 || oracle.files?.length !== files.length
      || !files.every(file => oracle.files.some(actual => actual.name === file.name
        && actual.bytesEqual === true && actual.sourceMatchesManifest === true
        && actual.bytes === file.bytes && actual.sha256 === file.sha256)))
      throw Error('Independent received-file oracle failed');
    oracles.push(oracle);
    // File status labels also say Done. The observed bottom action is distinct.
    read = await observe('completed transfer remains visible', value => has(value, '已完成'));
    await tap(read, named(read, '完成').filter(node => node.bounds.top > read.result.viewport.logicalHeight - 100),
      'Done after background transfer engine stops');
    await observe('returned to Receive after transfer', value => has(value, '通过链接接收'));
    await screenshot('final Receive screenshot belongs to LocalSend');
    return { gate: 'passed', assertions, actions, oracles, fullAppAcceptance: 'inconclusive' };
  } catch (error) {
    return { gate: 'failed', error: error.message, assertions, actions, oracles, fullAppAcceptance: 'inconclusive' };
  }
}

module.exports = { main };
