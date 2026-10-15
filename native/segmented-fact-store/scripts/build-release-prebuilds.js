'use strict';

// Maintainer-only cross-build on macOS. Normal installation only verifies and
// loads the checked-in artifact; it never runs a compiler.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { sourceIdentity } = require('./source-identity');

const [headers, zig] = process.argv.slice(2);
if (process.platform !== 'darwin' || !headers || !zig) {
  throw new Error('Usage on macOS: node scripts/build-release-prebuilds.js <Node include/node directory> <Zig 0.15.2 executable>');
}
if (execFileSync(zig, ['version'], { encoding: 'utf8' }).trim() !== '0.15.2') throw new Error('Zig 0.15.2 is required');
const root = path.resolve(__dirname, '..');
const common = ['-O2', '-std=c11', '-DNAPI_VERSION=8', '-D_POSIX_C_SOURCE=200809L',
  '-I', path.resolve(headers), '-I', path.join(root, 'include'),
  path.join(root, 'src/sfs.c'), path.join(root, 'bindings/node/sfs_node.c'),
  path.join(root, 'bindings/node/windows_process.c')];
const manifest = { napi: 8, artifacts: {} };
const sourceSha256 = sourceIdentity();
const windows = JSON.parse(fs.readFileSync(path.join(root, 'prebuilds/manifest.json'))).artifacts['win32-x64'];
if (windows) {
  if (JSON.stringify(windows.sourceSha256) !== JSON.stringify(sourceSha256)) {
    throw new Error('The Windows prebuild belongs to different source files. Build and verify Windows in CI before assembling this release.');
  }
  const file = path.join(root, 'prebuilds/win32-x64/segmented_fact_store.node');
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== windows.sha256) {
    throw new Error('The Windows prebuild checksum does not match its provenance.');
  }
  manifest.artifacts['win32-x64'] = windows;
}
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
  const staged = `${file}.${process.pid}.tmp`;
  execFileSync(compiler, [...args, ...common, '-o', staged], { stdio: 'inherit' });
  fs.renameSync(staged, file);
  manifest.artifacts[target] = { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sourceSha256, ...metadata };
}
fs.writeFileSync(path.join(root, 'prebuilds/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
