'use strict';

// Authored from the real Memos editor Intent. Preserve the business expectation:
// both task checkboxes must reflect the saved content. Restore the original memo
// before reporting a display failure; never accept the observed wrong value.
// Read-only decoder for the pinned Memos API schema, not a Bridge provider.
// proto/api/v1/memo_service.proto: UpdateMemoRequest.memo = 1;
// Memo.name = 1, Memo.content = 7; UpdateMemo returns Memo directly.
function fields(bytes) {
  const values = new Map(); let offset = 0;
  function varint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw Error('Truncated Protobuf varint');
      const byte = bytes[offset++]; value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw Error('Oversized Protobuf varint');
  }
  while (offset < bytes.length) {
    const tag = Number(varint()), id = tag >>> 3, wire = tag & 7;
    if (!id) throw Error('Invalid Protobuf field');
    let value;
    if (wire === 0) value = varint();
    else {
      const size = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) throw Error('Unsupported or truncated Protobuf field');
      value = bytes.subarray(offset, offset + size); offset += size;
    }
    if (!values.has(id)) values.set(id, []);
    values.get(id).push(value);
  }
  return values;
}
function one(message, id) {
  const values = message.get(id);
  if (values?.length !== 1 || !Buffer.isBuffer(values[0])) throw Error(`Expected exactly one byte field ${id}`);
  return values[0];
}
function body(record, side) {
  if (record[`${side}BodyState`] !== 'complete') throw Error(`${side} body is incomplete`);
  const text = record[`${side}Body`], encoding = record[`${side}BodyEncoding`];
  if (typeof text !== 'string' || !['utf8', 'base64'].includes(encoding)) throw Error('Unknown captured body encoding');
  const bytes = Buffer.from(text, encoding);
  if (encoding === 'base64' && bytes.toString('base64') !== text) throw Error('Invalid captured Base64');
  return bytes;
}
function decodeMemo(bytes) {
  const memo = fields(bytes), decoder = new TextDecoder('utf-8', { fatal: true });
  return { name: decoder.decode(one(memo, 1)), content: decoder.decode(one(memo, 7)) };
}
function decodeUpdate(record) {
  if (record.method !== 'POST' || !record.url.endsWith('/memos.api.v1.MemoService/UpdateMemo')) throw Error('Expected Memos UpdateMemo');
  return { request: decodeMemo(one(fields(body(record, 'request')), 1)), response: decodeMemo(body(record, 'response')) };
}

const keys = ['elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel', 'placeholder', 'href', 'text'];

async function main(ctx) {
  const sample = ctx.inputs;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const verdicts = [];
  async function call(command, args = {}) {
    const reply = await ctx.call(command, args);
    if (!reply.ok || reply.ambiguous === true) throw Error(`${command}:${reply.error}`);
    return reply;
  }
  const read = selector => call('web-dom', selector === undefined ? {} : { selector });
  const controls = observation => observation.result.dom.controls.filter(node => node.visible);
  function one(observation, predicate) {
    const nodes = controls(observation).filter(predicate);
    if (nodes.length !== 1) throw Error(`Expected exactly one observed control, found ${nodes.length}`);
    return nodes[0];
  }
  async function check(name, condition, evidence, stream, deferFailure = false) {
    const result = await ctx.assert({ name, condition, evidence, requiredEvidence: [stream] });
    verdicts.push(result);
    if (result.verdict !== 'passed' && !deferFailure) throw Error(`${name}:${result.verdict}`);
    return result;
  }
  function act(observed, node, command, args = {}) {
    return call(command, { ...args, selector: { elementId: node.elementId },
      expectedTarget: { pageRef: observed.result.pageRef,
        element: Object.fromEntries(keys.map(key => [key, node[key]])) } });
  }
  async function edit(content) {
    let observed = await read('article button');
    await act(observed, one(observed, node => node.tag === 'button'), 'web-click');
    observed = await read();
    await act(observed, one(observed, node => node.text === 'Edit'), 'web-click');
    observed = await read();
    await act(observed, one(observed, node => node.role === 'textbox' && node.editable && node.text.includes(sample.marker)), 'web-input', { value: content });
    observed = await read();
    const save = one(observed, node => node.tag === 'button' && node.text === 'Save' && !node.disabled);
    const before = await call('web-network');
    const beforeEvents = await call('web-events');
    const action = await act(observed, save, 'web-click');
    const deadline = Date.now() + 15000;
    let captured, records;
    do {
      captured = await call('web-network', { factCursor: before.evidence.capture.watermarkCursor });
      records = captured.result.items.filter(record => record.url.endsWith('/memos.api.v1.MemoService/UpdateMemo'));
      if (captured.evidence.coverage.status === 'complete' && records.length === 1) break;
      if (Date.now() >= deadline) throw Error('Save capture window did not complete');
      await sleep(100);
    } while (true);
    const record = records[0], decoded = decodeUpdate(record);
    await check('captured save request contains the exact memo and content',
      decoded.request.name === sample.memoName && decoded.request.content === content,
      captured.evidence, 'network');
    await check('server response contains the exact saved memo and content',
      record.statusCode === 200 && decoded.response.name === sample.memoName && decoded.response.content === content,
      captured.evidence, 'network');
    const events = await call('web-events', { factCursor: beforeEvents.evidence.capture.watermarkCursor });
    await check('save click is captured under its actual synchronous action', events.result.items.some(record =>
      record.actionId === action.execution.actionId && record.data?.events?.some(event => event.type === 'interaction.click' && event.target.text === 'Save')),
    events.evidence, 'events');
    let tasks;
    do {
      tasks = await read('article [role="checkbox"]');
      if (controls(tasks).length === 2) break;
      if (Date.now() >= deadline) throw Error('The saved memo did not return to its two task controls');
      await sleep(100);
    } while (true);
    return { tasks, decoded, actionId: action.execution.actionId,
      association: { actionId: record.actionId, kind: record.association } };
  }
  const initial = await read('article');
  await check('exactly the selected existing memo is visible',
    controls(initial).length === 1 && controls(initial)[0].text.includes(sample.marker), initial.evidence, 'tree');
  const saved = await edit(sample.checked.content);
  const decision = await ctx.askAgent({ checkpoint: 'saved-completed-tasks', marker: sample.marker,
    instruction: 'Check the live Memos SQLite snapshot for both completed tasks, then answer {"restore":true}.' });
  if (decision.restore !== true) throw Error('Persistence checkpoint rejected');
  let observed;
  const displayDeadline = Date.now() + 5000;
  do {
    observed = await read('article [role="checkbox"]');
    if (controls(observed).length === 2 && controls(observed).every(node => node.checked === true)) break;
    if (Date.now() >= displayDeadline) break;
    await sleep(200);
  } while (true);
  const display = await check('both saved tasks are displayed checked',
    controls(observed).length === 2 && controls(observed).every(node => node.checked === true), observed.evidence, 'tree', true);
  const restored = await edit(sample.restored.content);
  const restoreDeadline = Date.now() + 5000;
  while (!(controls(restored.tasks).length === 2 && controls(restored.tasks)[0].checked === true && controls(restored.tasks)[1].checked === false)
    && Date.now() < restoreDeadline) {
    await sleep(500);
    restored.tasks = await read('article [role="checkbox"]');
  }
  await check('the original task display is restored',
    controls(restored.tasks).length === 2 && controls(restored.tasks)[0].checked === true && controls(restored.tasks)[1].checked === false,
    restored.tasks.evidence, 'tree');
  if (display.verdict !== 'passed') throw Error('Memos saved both tasks but rendered stale checkbox state; original content was restored.');
  return { assertions: verdicts, saved: saved.decoded, restored: restored.decoded };
}
module.exports = { main, decodeUpdate };
