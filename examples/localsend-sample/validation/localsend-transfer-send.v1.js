'use strict';

// Authored from Intent 03/04: Flutter -> the explicitly bound OPPO picker ->
// Flutter -> the official desktop peer. Only the two manifest files are sent.
async function main(ctx) {
  const { serial, peerAlias, files, manifestSha256 } = ctx.inputs;
  const APP = 'org.localsend.localsend_app.bridge_sample', PICKER = 'com.coloros.filemanager';
  const actions = [], assertions = [], stableObservations = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const has = (read, text) => read.result.nodes.some(node => node.text === text);
  const named = (read, text) => read.result.nodes.filter(node => node.text === text);
  const fileNode = (read, file) => read.result.nodes.filter(node => node.packageName === PICKER
    && typeof node.text === 'string' && node.text.replace(/\r?\n/g, '') === file.name);
  async function call(command, args = {}, packageName = APP) {
    const value = await ctx.call(command, { serial, packageName, ...args });
    if (!value.ok) throw Error(`${command}: ${value.error}`);
    return value;
  }
  async function check(name, condition, read, kind = 'tree') {
    const value = await ctx.assert({ name, condition, predicateSummary: name, evidence: read.evidence,
      requiredEvidence: [kind], requireCoverage: 'complete' });
    assertions.push(value);
    if (value.verdict !== 'passed') throw Error(`${name}: ${value.verdict}`);
  }
  function geometry(read, provider) {
    return JSON.stringify(read.result.nodes.filter(node => provider === 'flutter' || node.packageName === PICKER)
      .map(node => [node.text, node.className, node.resourceId, node.bounds, node.checked, node.enabled]));
  }
  async function observe(name, predicate, provider = 'flutter') {
    const deadline = Date.now() + 20000;
    let previous;
    do {
      const current = provider === 'flutter' ? await call('flutter-nodes')
        : await ctx.call('uia-tree', { serial, packageName: PICKER, compact: true, maxNodes: 1000, maxDepth: 100 });
      if (!current.ok && provider === 'uia' && current.error === 'uia_tree_changed'
        && current.dispatched === false && current.ambiguous === false && current.execution.actionId === null) {
        await ctx.progress({ stage: 'picker-tree-reobserve', callId: current.execution.callId, error: current.error });
        previous = undefined; await sleep(200); continue;
      }
      if (!current.ok || current.result.truncated !== false) throw Error(`${name}: ${current.error || 'incomplete_tree'}`);
      if (previous && predicate(previous) && predicate(current)
        && (provider === 'uia' || current.result.updatedAtMs > previous.result.updatedAtMs)
        && geometry(previous, provider) === geometry(current, provider)) {
        await check(name, true, current);
        stableObservations.push({ name, provider, firstObservationId: previous.evidence.observationId,
          observationId: current.evidence.observationId, firstUpdatedAtMs: previous.result.updatedAtMs,
          updatedAtMs: current.result.updatedAtMs });
        return current;
      }
      previous = current; await sleep(200);
    } while (Date.now() < deadline);
    throw Error(`${name}: stable expected page did not appear`);
  }
  async function act(command, args, name, packageName = APP) {
    const result = await call(command, args, packageName);
    const actionId = result.execution.actionId;
    if (!actionId || result.executionReceipt?.actionId !== actionId) throw Error(`${name}: original_settlement_proof_missing`);
    actions.push({ name, command, actionId, target: result.execution.target, executionReceipt: result.executionReceipt });
  }
  async function tapFlutter(read, text, footer = false) {
    const nodes = named(read, text).filter(node => !footer || node.bounds.top > read.result.viewport.logicalHeight - 100);
    await check(`one Flutter ${text} target`, nodes.length === 1, read);
    await act('tap-flutter', { selector: { nodeId: nodes[0].id } }, text);
  }
  async function tapPicker(read, text) {
    await check(`one picker ${text} target`, named(read, text).filter(node => node.packageName === PICKER).length === 1, read);
    await act('tap-uia', { selector: { text } }, text, PICKER);
  }
  async function screen(name, packageName = APP) {
    const value = await call('screenshot', {}, packageName);
    await check(name, value.result.foregroundMatchesPackage === true, value, 'screenshot');
  }
  async function peer(operation) {
    const response = await ctx.askAgent({ question: `Official receiving peer: ${operation}`,
      context: { kind: 'localsend.transfer-send/v1', operation, files, manifestSha256 } });
    if (response.ok !== true) throw Error(`official_peer_${operation}_failed`);
    return response;
  }
  try {
    if (files.length !== 2) throw Error('exact_two_file_fixture_required');
    let read = await observe('initial Receive', value => has(value, '通过链接接收'));
    await peer('start-receiver');
    await tapFlutter(read, '发送');
    read = await observe('empty Send selection', value => has(value, '文件') && has(value, '选择'));
    await tapFlutter(read, '文件');
    read = await observe('OPPO file picker', value => has(value, '最近') && has(value, '文件') && has(value, '添加(0)'), 'uia');
    await tapPicker(read, '文件');
    read = await observe('picker storage choices', value => has(value, '全部文件'), 'uia');
    await tapPicker(read, '全部文件');
    read = await observe('picker storage root', value => has(value, 'Download'), 'uia');
    await tapPicker(read, 'Download');
    read = await observe('stable Download listing', value => has(value, 'Download') && has(value, '添加(0)'), 'uia');
    for (let index = 0; !files.every(file => fileNode(read, file).length === 1); index++) {
      if (index === 8) throw Error('fixture_files_not_found_within_eight_scrolls');
      const lists = read.result.nodes.filter(node => node.packageName === PICKER && node.scrollable === true);
      await check('one scrollable file list', lists.length === 1, read);
      const b = lists[0].bounds, before = geometry(read, 'uia');
      await act('swipe', { startX: Math.round((b.left + b.right) / 2), startY: Math.round(b.top + (b.bottom - b.top) * 0.75),
        endX: Math.round((b.left + b.right) / 2), endY: Math.round(b.top + (b.bottom - b.top) * 0.25), durationMs: 400 },
      'scroll Download file list', PICKER);
      read = await observe('Download scroll stopped', value => has(value, '添加(0)') && geometry(value, 'uia') !== before, 'uia');
    }
    for (let index = 0; index < files.length; index++) {
      const nodes = fileNode(read, files[index]);
      await check(`observed exact fixture ${files[index].name}`, nodes.length === 1, read);
      await tapPicker(read, nodes[0].text);
      read = await observe(`picker selected ${index + 1} files`, value => has(value, `添加(${index + 1})`), 'uia');
    }
    await screen('two-file picker selection', PICKER);
    await tapPicker(read, '添加(2)');
    read = await observe('Flutter has exactly two selected files', value => has(value, '文件：2') && has(value, peerAlias));
    await screen('Flutter two-file selection');
    await tapFlutter(read, peerAlias);
    await peer('accept-exact-files');
    await observe('both outgoing files completed', value => has(value, '已完成') && files.every(file => has(value, file.name)));
    await screen('completed send');
    const oracle = await peer('verify-received');
    if (oracle.manifestSha256 !== manifestSha256 || oracle.files.length !== 2 || !files.every(file =>
      oracle.files.some(actual => actual.name === file.name && actual.bytesEqual && actual.sourceMatchesManifest
        && actual.bytes === file.bytes && actual.sha256 === file.sha256))) throw Error('independent_received_file_oracle_failed');
    read = await observe('completed send remains visible', value => has(value, '已完成'));
    await tapFlutter(read, '完成', true);
    read = await observe('selection cleared after send', value => has(value, '选择') && has(value, '文件') && !has(value, '文件：2'));
    await tapFlutter(read, '接收');
    await observe('returned to Receive', value => has(value, '通过链接接收'));
    await screen('final Receive');
    return { gate: 'passed', assertions, actions, stableObservations, oracle, fullAppAcceptance: 'inconclusive' };
  } catch (error) {
    return { gate: 'failed', error: error.message, assertions, actions, stableObservations, fullAppAcceptance: 'inconclusive' };
  }
}

module.exports = { main };
