'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createNodeRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { createPythonRuntimeAdapter } = require('../bin/script/python-runtime-adapter');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aab-module-loading-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'flows'), cwd = path.join(root, 'work');
  fs.mkdirSync(sourceDir); fs.mkdirSync(cwd);
  return { root, sourceDir, cwd };
}

async function run(t, spec) {
  const runtime = spec.language === 'python' ? createPythonRuntimeAdapter() : createNodeRuntimeAdapter();
  t.after(() => runtime.stop?.());
  const result = await runtime.start({ spec, host: { call: () => assert.fail('No device call was expected') },
    emit() {}, control: () => ({ status: 'running', pauseReason: null }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result;
}

test('sourcePath CommonJS resolves siblings, packages, assets and cycles from the declared file while executing frozen entry bytes', async t => {
  const { root, sourceDir, cwd } = fixture(t), sourcePath = path.join(sourceDir, 'flow.cjs');
  fs.mkdirSync(path.join(sourceDir, 'helpers'));
  fs.mkdirSync(path.join(root, 'node_modules', 'fixture-package'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'fixture-package', 'index.js'), 'module.exports = 23;');
  fs.writeFileSync(path.join(sourceDir, 'helpers', 'child.cjs'), "exports.value = require('fixture-package'); exports.parentMarker = require('../flow.cjs').marker;");
  fs.writeFileSync(path.join(sourceDir, 'asset.txt'), 'source asset');
  fs.writeFileSync(sourcePath, `exports.marker = 'frozen-entry';
const child = require('./helpers/child.cjs');
exports.main = () => ({ value: child.value, parent: child.parentMarker, filename: __filename,
  directory: __dirname, cwd: process.cwd(), asset: require('node:fs').readFileSync(require('node:path').join(__dirname, 'asset.txt'), 'utf8') });`);
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath, cwd });
  assert.equal(compiled.ok, true);
  fs.writeFileSync(sourcePath, 'throw new Error("The changed entry must not execute");');
  assert.deepEqual(await run(t, compiled.spec), { value: 23, parent: 'frozen-entry', filename: sourcePath,
    directory: sourceDir, cwd, asset: 'source asset' });
});

test('sourcePath Python imports sibling packages and supports dataclasses and __file__ while executing frozen entry bytes', async t => {
  const { sourceDir, cwd } = fixture(t), sourcePath = path.join(sourceDir, 'flow.py');
  fs.mkdirSync(path.join(sourceDir, 'helpers'));
  fs.writeFileSync(path.join(sourceDir, 'helpers', '__init__.py'), '');
  fs.writeFileSync(path.join(sourceDir, 'helpers', 'data.py'), 'VALUE = 23\n');
  fs.writeFileSync(path.join(sourceDir, 'helpers', 'child.py'), 'from .data import VALUE\n');
  fs.writeFileSync(path.join(sourceDir, 'asset.txt'), 'source asset');
  fs.writeFileSync(sourcePath, `from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from helpers.child import VALUE
import os
@dataclass
class Item:
    value: int
def main(ctx):
    return {"value": Item(VALUE).value, "filename": __file__, "cwd": os.getcwd(), "asset": Path(__file__).with_name("asset.txt").read_text(), "entry": "frozen-entry"}
`);
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'python', sourcePath, cwd });
  assert.equal(compiled.ok, true);
  fs.writeFileSync(sourcePath, 'raise RuntimeError("The changed entry must not execute")\n');
  assert.deepEqual(await run(t, compiled.spec), { value: 23, filename: sourcePath, cwd, asset: 'source asset', entry: 'frozen-entry' });
});

for (const language of ['javascript', 'python']) test(`inline ${language} imports local helpers from the declared cwd`, async t => {
  const { cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'helper.cjs'), 'module.exports = 41;');
  fs.writeFileSync(path.join(cwd, 'helper.py'), 'VALUE = 41\n');
  const source = language === 'javascript'
    ? "module.exports.main = () => ({ value: require('./helper.cjs'), cwd: process.cwd() });"
    : 'from helper import VALUE\nimport os\ndef main(ctx):\n    return {"value": VALUE, "cwd": os.getcwd()}\n';
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language, source, cwd });
  assert.equal(compiled.ok, true);
  assert.deepEqual(await run(t, compiled.spec), { value: 41, cwd });
});
