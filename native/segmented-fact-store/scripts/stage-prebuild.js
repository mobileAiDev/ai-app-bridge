'use strict';
// Explicit developer build only. The release script assembles all matrix artifacts.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const os = require('node:os');
const { sourceIdentity } = require('./source-identity');
const root = path.resolve(__dirname, '..');
const target = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-glibc' : ''}`;
if (!['darwin-arm64', 'darwin-x64', 'linux-arm64-glibc', 'linux-x64-glibc', 'win32-x64'].includes(target)) throw new Error(`Unsupported release target: ${target}`);
const bytes = fs.readFileSync(path.join(root, 'build/Release/segmented_fact_store.node'));
const directory = path.join(root, 'prebuilds', target); fs.mkdirSync(directory, { recursive: true });
const artifact = path.join(directory, 'segmented_fact_store.node');
const staged = `${artifact}.${process.pid}.tmp`;
// Replacing a loaded Mach-O inode in place can retain its old kernel signature
// cache. Publish the complete new inode instead of overwriting executable bytes.
fs.writeFileSync(staged, bytes, { flag: 'wx' });
fs.renameSync(staged, artifact);
const file = path.join(root, 'prebuilds/manifest.json');
const manifest = JSON.parse(fs.readFileSync(file));
manifest.artifacts[target] = { sha256: createHash('sha256').update(bytes).digest('hex'),
  ...(process.platform === 'linux' ? { minGlibc: process.report.getReport().header.glibcVersionRuntime } : {}),
  minSystem: process.platform === 'darwin' ? 'macOS 13.5' : process.platform === 'win32' ? 'Windows 10 x64' : `glibc ${process.report.getReport().header.glibcVersionRuntime}`,
  sourceBuild: true, sourceSha256: sourceIdentity(),
  buildHost: { platform: process.platform, arch: process.arch, release: os.release(), node: process.versions.node, napi: Number(process.versions.napi) },
  ...(process.env.SFS_PREBUILD_COMPILER ? { compiler: process.env.SFS_PREBUILD_COMPILER } : {}),
};
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
