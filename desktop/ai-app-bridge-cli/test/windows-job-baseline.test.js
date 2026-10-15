'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Only exercise the maintenance harness's result classification/restoration.
// The subprocess output is a fixture, never evidence of Windows Job behavior.
for (const scenario of ['known-regression', 'startup-failed', 'independent-process-killed']) {
  test(`Windows baseline harness restores candidate bytes after ${scenario}`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-job-baseline-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const cli = path.join(directory, 'desktop/ai-app-bridge-cli'), evidence = path.join(directory, 'evidence');
    const files = ['bin/script/node-runtime-adapter.js', 'bin/shared-kernel/portable-exec-file.js'];
    fs.mkdirSync(evidence);
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(cli, file)), { recursive: true });
      fs.writeFileSync(path.join(cli, file), Buffer.from([0, 10, 13, 255]));
    }
    const roles = ['completed-command-daemon', 'completed-javascript-daemon', 'completed-python-daemon', 'independent-process'];
    const before = { phase: 'before-host-death', hostPid: 1, processes: roles.map((role, i) => ({ role, pid: i + 2, start: String(i + 10), observedStart: String(i + 10) })) };
    const after = { phase: 'after-host-death', hostPid: 1, processes: before.processes.map(process => ({ ...process,
      observedStart: scenario === 'independent-process-killed' || process.role !== 'independent-process' ? null : process.start })) };
    const context = { module: { exports: {} }, __dirname: path.join(cli, 'scripts/validation'),
      process: { platform: 'win32', version: 'fixture', versions: { uv: 'fixture' }, execPath: process.execPath, stdout: { write() {} } },
      require(name) {
        if (name === 'node:child_process') return {
          execFileSync: () => Buffer.from('baseline'),
          spawnSync(file, args, options) {
            for (const file of files) assert.equal(fs.readFileSync(path.join(cli, file), 'utf8'), 'baseline');
            fs.writeSync(options.stdio[1], scenario === 'startup-failed' ? 'Error: Cannot load module\n# fail 1\n'
              : `# ${JSON.stringify(before)}\n# ${JSON.stringify(after)}\n# fail 1\n`);
            return { status: 1, signal: null };
          },
        };
        return require(name);
      },
    };
    const filename = require.resolve('../scripts/validation/verify-windows-job-baseline');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    if (scenario === 'known-regression') context.main(evidence);
    else assert.throws(() => context.main(evidence), scenario === 'startup-failed' ? /Both phases must finish/ : /independent process must remain alive/);
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(cli, file)), Buffer.from([0, 10, 13, 255]));
    const report = JSON.parse(fs.readFileSync(path.join(evidence, 'job-baseline.json')));
    assert.equal(report.ok, scenario === 'known-regression');
    assert.equal(report.restored.every(file => file.exactBytes), true);
  });
}
