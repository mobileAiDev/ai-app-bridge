'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveBinding } = require('../../../binding-path');
const root = path.resolve(__dirname, '../../..');
test('the selected prebuilt addon has a verified identity and loads directly', () => {
  const info = resolveBinding();
  assert.match(info.path, /prebuilds/);
  assert.equal(info.napi, 8);
  assert.match(info.sha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof require(info.path).open, 'function');
});
test('missing and corrupted packaged binaries fail explicitly without source compilation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-prebuilt-damage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['index.js', 'binding-path.js']) fs.copyFileSync(path.join(root, name), path.join(dir, name));
  fs.cpSync(path.join(root, 'prebuilds'), path.join(dir, 'prebuilds'), { recursive: true });
  const file = path.join(dir, path.relative(root, resolveBinding().path));
  const check = code => {
    const child = spawnSync(process.execPath, ['-e', `try { require(${JSON.stringify(dir)}); process.exit(1); } catch(e) { console.log(e.code); }`], {encoding:'utf8'});
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), code);
  };
  fs.writeFileSync(file, 'damaged'); check('native_prebuild_corrupt');
  fs.unlinkSync(file); check('native_prebuild_missing');
});
test('an unsupported platform identifies its ABI and never selects another artifact', () => {
  const child = spawnSync(process.execPath, ['-e', `Object.defineProperty(process, 'platform', {value:'win32'});
try { require(${JSON.stringify(root)}); process.exit(1); } catch(e) { console.log(e.code+' '+e.message); }`], {encoding:'utf8'});
  assert.equal(child.status, 0); assert.match(child.stdout, /native_platform_unsupported.*win32.*Node-API.*No automatic source build/);
});
