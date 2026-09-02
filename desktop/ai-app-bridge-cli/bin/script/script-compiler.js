'use strict';

const { checksumOf } = require('../shared-kernel/evidence-schema');
const { scriptError } = require('./script-errors');

function compileScript(input) {
  let raw = input;
  if (typeof input === 'string') {
    const parsed = parseScriptText(input);
    if (!parsed.ok) return parsed;
    raw = parsed.value;
  }
  if (!raw || typeof raw !== 'object') {
    return scriptError('invalid_script');
  }
  const steps = Array.isArray(raw.steps) ? raw.steps.map((step, index) => normalizeStep(step, index)) : [];
  if (steps.length === 0) return scriptError('invalid_script', { field: 'steps' });
  for (const step of steps) {
    if (!step.ok) return step;
  }
  const canonical = {
    name: raw.name || raw.id || 'script',
    target: {
      serial: raw.target?.serial || raw.serial || null,
      packageName: raw.target?.packageName || raw.packageName || null,
    },
    steps: steps.map((step) => step.step),
  };
  return {
    ok: true,
    script: canonical,
    hash: checksumOf(canonical),
  };
}

function normalizeStep(step, index) {
  if (!step || typeof step !== 'object') return scriptError('invalid_step', { index });
  const type = step.type || step.observe && 'observe' || step.action && 'action' || step.assert && 'assert' || step.checkpoint && 'checkpoint';
  if (!['observe', 'action', 'assert', 'checkpoint'].includes(type)) {
    return scriptError('invalid_step', { index, type });
  }
  const body = step[type] && typeof step[type] === 'object' ? step[type] : step;
  const id = step.id || body.id || `${type}-${index + 1}`;
  if (type === 'observe') {
    return { ok: true, step: { id, type, provider: body.provider || 'native' } };
  }
  if (type === 'action') {
    return {
      ok: true,
      step: {
        id,
        type,
        action: body.action || body.name || 'tap',
        provider: body.provider || null,
        text: body.text || body.targetText || null,
        nodeId: body.nodeId || null,
        keyCode: body.keyCode != null ? body.keyCode : null,
        delta: body.delta != null ? body.delta : null,
        exact: body.exact === true,
        requireClickable: body.requireClickable === true,
      },
    };
  }
  if (type === 'assert') {
    return { ok: true, step: { id, type, text: body.text || body.targetText || null } };
  }
  return { ok: true, step: { id, type } };
}

function parseScriptText(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return scriptError('invalid_script');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (error) {
      return scriptError('invalid_script', { detail: error.message });
    }
  }
  try {
    return { ok: true, value: parseMinimalYaml(trimmed) };
  } catch (error) {
    return scriptError('invalid_script', { detail: error.message });
  }
}

function parseMinimalYaml(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const line of lines) {
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent._list)) {
        throw new Error('yaml list without key');
      }
      const item = parseYamlValue(trimmed.slice(2));
      if (item && typeof item === 'object' && item._pair) {
        const object = { [item.key]: item.value };
        parent._list.push(object);
        if (item.value && typeof item.value === 'object') stack.push({ indent, value: object[item.key] === null ? object : object });
        if (item.value === null) stack.push({ indent, value: object });
      } else {
        parent._list.push(item);
      }
      continue;
    }
    const pair = parseYamlValue(trimmed);
    if (!pair || !pair._pair) throw new Error(`yaml mapping required: ${trimmed}`);
    if (Array.isArray(parent)) throw new Error('yaml map into list');
    parent[pair.key] = pair.value === '__list__' ? assignList(parent, pair.key) : pair.value;
    if (pair.value === '__list__') stack.push({ indent, value: { _list: parent[pair.key] } });
    else if (pair.value && typeof pair.value === 'object') stack.push({ indent, value: pair.value });
    else if (pair.value === null) {
      parent[pair.key] = {};
      stack.push({ indent, value: parent[pair.key] });
    }
  }
  return unwrapLists(root);
}

function assignList(parent, key) {
  parent[key] = [];
  return parent[key];
}

function parseYamlValue(text) {
  if (text.endsWith(':')) {
    const key = text.slice(0, -1).trim();
    if (key === 'steps') return { _pair: true, key, value: '__list__' };
    return { _pair: true, key, value: null };
  }
  const match = /^([^:]+):\s*(.*)$/.exec(text);
  if (!match) return coerceYamlScalar(text);
  const value = match[2];
  if (value === '') return { _pair: true, key: match[1].trim(), value: null };
  return { _pair: true, key: match[1].trim(), value: coerceYamlScalar(value) };
}

function coerceYamlScalar(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function unwrapLists(value) {
  if (Array.isArray(value)) return value.map(unwrapLists);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value._list) && Object.keys(value).length === 1) return value._list.map(unwrapLists);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapLists(child)]));
}

module.exports = { compileScript };
