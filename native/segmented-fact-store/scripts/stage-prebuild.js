'use strict';
// Explicit developer build only. The release script assembles all matrix artifacts.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-glibc' : ''}`;
if (!['darwin-arm64', 'darwin-x64', 'linux-arm64-glibc', 'linux-x64-glibc'].includes(target)) throw new Error(`Unsupported release target: ${target}`);
const bytes = fs.readFileSync(path.join(root, 'build/Release/segmented_fact_store.node'));
const directory = path.join(root, 'prebuilds', target); fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'segmented_fact_store.node'), bytes);
const file = path.join(root, 'prebuilds/manifest.json');
const manifest = JSON.parse(fs.readFileSync(file));
manifest.artifacts[target] = { sha256: createHash('sha256').update(bytes).digest('hex'),
  ...(process.platform === 'linux' ? { minGlibc: process.report.getReport().header.glibcVersionRuntime } : {}),
  minSystem: process.platform === 'darwin' ? 'macOS 13.5' : `glibc ${process.report.getReport().header.glibcVersionRuntime}`, sourceBuild: true };
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
