'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const generated = process.argv[2];
if (!generated) throw new Error('Usage: node scripts/verify-golden.js <fresh generated store directory>');
const checksumFile = path.join(__dirname, '../tests/golden/v1/SHA256SUMS');
const checked = [];
for (const line of fs.readFileSync(checksumFile, 'utf8').trim().split(/\r?\n/)) {
  const [, expected, name] = /^(\S+)\s+(.+)$/.exec(line);
  if (name === 'expected.json') continue; // Oracle metadata, not generated store bytes.
  const actual = createHash('sha256').update(fs.readFileSync(path.join(generated, name))).digest('hex');
  assert.equal(actual, expected, `v1 binary format differs: ${name}`);
  checked.push({ file: name, sha256: actual });
}
console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, checked }));
