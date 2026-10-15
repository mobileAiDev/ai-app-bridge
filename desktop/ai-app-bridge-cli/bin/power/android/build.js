'use strict';

// Explicit build inputs keep the shipped dex reproducible and auditable.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const [androidJar, d8] = process.argv.slice(2);
if (!androidJar || !d8) throw new Error('Usage: node build.js /absolute/android.jar /absolute/d8');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-power-build-'));
const source = path.join(__dirname, 'PowerLease.java');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
try {
  const classes = path.join(directory, 'classes'), dex = path.join(directory, 'dex');
  fs.mkdirSync(classes); fs.mkdirSync(dex);
  run('javac', ['-source', '8', '-target', '8', '-classpath', androidJar, '-d', classes, source]);
  const classJar = path.join(directory, 'classes.jar');
  run('jar', ['cf', classJar, '-C', classes, '.']);
  run(d8, ['--min-api', '21', '--lib', androidJar, '--output', dex, classJar]);
  const output = path.join(__dirname, 'power-lease.jar');
  run('jar', ['cf', output, '-C', dex, 'classes.dex']);
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify({ schemaVersion: 'aab.power.android/v1',
    minApi: 21, sourceSha256: sha256(source), jarSha256: sha256(output), androidJarSha256: sha256(androidJar) }, null, 2) + '\n');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
