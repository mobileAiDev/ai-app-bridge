'use strict';

// Maintainer-only cross-build on macOS. Normal installation only verifies and
// loads the checked-in artifact; it never runs a compiler.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const [headers, zig] = process.argv.slice(2);
if (process.platform !== 'darwin' || !headers || !zig) {
  throw new Error('Usage on macOS: node scripts/build-release-prebuilds.js <Node include/node directory> <Zig 0.15.2 executable>');
}
if (execFileSync(zig, ['version'], { encoding: 'utf8' }).trim() !== '0.15.2') throw new Error('Zig 0.15.2 is required');
const root = path.resolve(__dirname, '..');
const common = ['-O2', '-std=c11', '-DNAPI_VERSION=8', '-D_POSIX_C_SOURCE=200809L',
  '-I', path.resolve(headers), '-I', path.join(root, 'include'),
  path.join(root, 'src/sfs.c'), path.join(root, 'bindings/node/sfs_node.c')];
const manifest = { napi: 8, artifacts: {} };
for (const [target, compiler, args, metadata] of [
  ['darwin-arm64', 'clang', ['-arch', 'arm64', '-mmacosx-version-min=13.5', '-bundle', '-undefined', 'dynamic_lookup'], { minSystem: 'macOS 13.5', compiler: 'Apple clang, -O2 -mmacosx-version-min=13.5' }],
  ['darwin-x64', 'clang', ['-arch', 'x86_64', '-mmacosx-version-min=13.5', '-bundle', '-undefined', 'dynamic_lookup'], { minSystem: 'macOS 13.5', compiler: 'Apple clang, -O2 -mmacosx-version-min=13.5' }],
  ...[['arm64', 'aarch64'], ['x64', 'x86_64']].map(([arch, triple]) => [
    `linux-${arch}-glibc`, zig, ['cc', '-target', `${triple}-linux-gnu.2.28`, '-fPIC', '-shared', '-lpthread'],
    { minGlibc: '2.28', minSystem: 'Linux glibc 2.28', compiler: 'zig cc 0.15.2, -O2 -target *-linux-gnu.2.28' },
  ]),
]) {
  const file = path.join(root, 'prebuilds', target, 'segmented_fact_store.node');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(compiler, [...args, ...common, '-o', file], { stdio: 'inherit' });
  manifest.artifacts[target] = { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ...metadata };
}
fs.writeFileSync(path.join(root, 'prebuilds/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
