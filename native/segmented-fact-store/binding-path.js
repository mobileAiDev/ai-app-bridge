'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function resolveBinding() {
  const platform = process.platform, arch = process.arch, napi = Number(process.versions.napi);
  const glibc = platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime : undefined;
  const target = `${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
  const description = `${platform}/${arch}, Node ${process.versions.node}, Node-API ${napi}, libc ${glibc || 'not-glibc'}`;
  const manifest = require('./prebuilds/manifest.json');
  const artifact = manifest.artifacts[target];
  const minimum = artifact?.minGlibc;
  const reject = (code, message) => { throw Object.assign(new Error(`${message} (${description}). No automatic source build is attempted.`), { code }); };
  if (artifact && platform === 'linux' && !/^\d+\.\d+$/.test(minimum)) reject('native_prebuild_corrupt', 'The packaged Linux artifact has no valid minimum glibc version');
  const olderGlibc = glibc && minimum && (Number(glibc.split('.')[0]) < Number(minimum.split('.')[0]) ||
    (Number(glibc.split('.')[0]) === Number(minimum.split('.')[0]) && Number(glibc.split('.')[1]) < Number(minimum.split('.')[1])));
  if (!artifact || napi < manifest.napi || (platform === 'linux' && (!glibc || olderGlibc))) {
    reject('native_platform_unsupported', 'Supported prebuilds require macOS 13.5+ arm64/x64 or Linux glibc 2.28+ arm64/x64, and Node-API 8+');
  }
  const file = path.join(__dirname, 'prebuilds', target, 'segmented_fact_store.node');
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) { reject('native_prebuild_missing', `Cannot read packaged native artifact ${file}: ${error.code}`); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== artifact.sha256) reject('native_prebuild_corrupt', `Checksum mismatch for ${file}; reinstall this package`);
  return { path: file, target, sha256, napi: manifest.napi, ...artifact };
}
module.exports = { resolveBinding };
