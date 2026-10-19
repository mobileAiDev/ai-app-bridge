'use strict';

const jsonc = require('jsonc-parser');
const toml = require('toml-eslint-parser');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);
const keyParts = key => key.keys.map(part => part.type === 'TOMLBare' ? part.name : part.value);

function parseConfig(text, format) {
  if (format === 'toml') return toml.getStaticTOMLValue(toml.parseTOML(text));
  const errors = [];
  const value = jsonc.parse(text || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !object(value)) throw new Error('Configuration must be a valid JSON/JSONC object.');
  return value;
}

// Edit AST value ranges so unrelated settings, comments and formatting survive.
function setToml(text, path, value) {
  const ast = toml.parseTOML(text);
  const containers = [{ path: [], node: ast.body[0] }];
  let found;
  function visit(body, prefix) {
    for (const node of body) {
      if (node.type === 'TOMLTable') {
        containers.push({ path: node.resolvedKey, node });
        visit(node.body, node.resolvedKey);
      } else if (node.type === 'TOMLKeyValue') {
        const full = [...prefix, ...keyParts(node.key)];
        if (samePath(full, path)) found = node.value;
        if (node.value.type === 'TOMLInlineTable') {
          containers.push({ path: full, node: node.value });
          visit(node.value.body, full);
        }
      }
    }
  }
  visit(ast.body[0].body, []);
  const encoded = JSON.stringify(value);
  if (found) return text.slice(0, found.range[0]) + encoded + text.slice(found.range[1]);
  const parent = containers.filter(c => c.path.length < path.length && c.path.every((p, i) => p === path[i]))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const key = path.slice(parent.path.length).map(part => JSON.stringify(part)).join('.');
  const line = `${key} = ${encoded}`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (parent.node.type === 'TOMLInlineTable') {
    const at = parent.node.range[1] - 1;
    return text.slice(0, at) + (parent.node.body.length ? ', ' : '') + line + text.slice(at);
  }
  if (parent.node.type === 'TOMLTopLevelTable') return line + eol + text;
  const headerEnd = text.indexOf('\n', parent.node.key.range[1]);
  if (headerEnd < 0) return text + eol + line + eol;
  return text.slice(0, headerEnd + 1) + line + eol + text.slice(headerEnd + 1);
}

function updateMcp(text, format, launch) {
  const data = parseConfig(text, format);
  const group = format === 'toml' ? 'mcp_servers' : 'mcpServers';
  if (data[group] !== undefined && !object(data[group])) throw new Error(`${group} must be an object.`);
  const current = data[group]?.['ai-app-bridge'];
  if (current !== undefined && !object(current)) throw new Error('ai-app-bridge must be a server configuration object.');
  if (current?.url || current?.serverUrl || (current?.type && current.type !== 'stdio')) {
    throw new Error('ai-app-bridge uses a different transport. Review that entry before configuring the local server.');
  }
  if (current?.disabled === true || current?.enabled === false) {
    throw new Error('ai-app-bridge is explicitly disabled. Enable it in the client configuration before setup.');
  }
  let result = text;
  for (const [field, value] of Object.entries(launch)) {
    if (JSON.stringify(current?.[field]) === JSON.stringify(value)) continue;
    const key = [group, 'ai-app-bridge', field];
    if (format === 'toml') result = setToml(result, key, value);
    else result = jsonc.applyEdits(result || '{}', jsonc.modify(result || '{}', key, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
    }));
  }
  const updated = parseConfig(result, format);
  const expected = { ...data, [group]: { ...data[group], 'ai-app-bridge': { ...current, ...launch } } };
  require('node:assert/strict').deepEqual(updated, expected, 'MCP editing changed unrelated configuration.');
  return result;
}

const begin = '<!-- ai-app-bridge:begin -->';
const end = '<!-- ai-app-bridge:end -->';
function updateInstructions(text, guidance) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = [begin, guidance.trim(), end].join('\n').replace(/\n/g, eol);
  const start = text.indexOf(begin), finish = text.indexOf(end);
  if (start < 0 && finish < 0) return text + (text ? (text.endsWith('\n') ? eol : eol + eol) : '') + block + eol;
  if (start < 0 || finish < start || text.indexOf(begin, start + begin.length) >= 0 || text.indexOf(end, finish + end.length) >= 0) {
    throw new Error('Incomplete or duplicate AI App Bridge instruction markers; repair them before setup.');
  }
  return text.slice(0, start) + block + text.slice(finish + end.length);
}

module.exports = { updateMcp, updateInstructions, parseConfig };
