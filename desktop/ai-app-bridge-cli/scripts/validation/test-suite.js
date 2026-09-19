'use strict';
// Timing gates run after the functional suite, one file at a time.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function tests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? tests(file) : entry.name.endsWith('.test.js') ? [file] : [];
  });
}
// Keep mixed files intact: their functional assertions still run, serially.
const timingFiles = new Set(['p2-script-supervisor.test.js', 'p3-script-runners.test.js',
  'p8-handshake-bench.test.js', 'p8-start-overhead-bench.test.js', 'p8-material-summary-p95.test.js',
  'p8-spawn-residual.test.js', 'p8-page-summary-bench.test.js', 'stability-g8.test.js']);
const isTiming = file => file.includes(`${path.sep}performance${path.sep}`) || timingFiles.has(path.basename(file));
const groups = { functional: tests(path.join(root, 'test')).filter(file => !isTiming(file)),
  performance: tests(path.join(root, 'test')).filter(isTiming) };
const selected = process.argv[2] ? [process.argv[2]] : ['functional', 'performance'];
for (const group of selected) {
  if (!groups[group]) throw new Error(`Unknown test group: ${group}`);
  process.stdout.write(`Test group: ${group} (${groups[group].length} files)\n`);
  const child = spawnSync(process.execPath, ['--import', './test-support/ownership-test-sandbox.js', '--test',
    ...(group === 'performance' ? ['--test-concurrency=1'] : []), ...groups[group].sort()], { cwd: root, stdio: 'inherit' });
  if (child.status !== 0) process.exit(child.status || 1);
}
