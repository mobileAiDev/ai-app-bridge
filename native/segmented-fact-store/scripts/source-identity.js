'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceFiles = [
  'binding.gyp', 'include/sfs.h', 'src/sfs.c', 'src/sfs_platform.h',
  'bindings/node/sfs_node.c', 'bindings/node/windows_process.c', 'bindings/node/windows_process.h',
];

function sourceIdentity() {
  return Object.fromEntries(sourceFiles.map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
  ]));
}

module.exports = { sourceIdentity };
