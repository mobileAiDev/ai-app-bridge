'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const execute = promisify(execFile);
const { createAndroidShellPort, terminalReceipt } = require('../bin/shared-kernel/android-shell-execution');
const { installScript } = require('../bin/shared-kernel/android-install-execution');
const unquote = text => text.slice(1, -1).replaceAll("'\\''", "'");

// Run the production shell templates with K2's relevant capability layout:
// SHA-256 exists only as a multicall applet, never as a PATH executable.
// PM and flock are fixtures; this test does not claim device/locking coverage.
function fixture(t, applet = 'busybox') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-shell-compat-'));
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const name of ['cat', 'mkdir', 'mv', 'rm', 'tr', 'sed', 'printf']) {
    const source = ['/bin', '/usr/bin'].map(root => path.join(root, name)).find(file => fs.existsSync(file));
    fs.symlinkSync(source, path.join(bin, name));
  }
  fs.symlinkSync('/bin/bash', path.join(bin, 'sh'));
  script('setsid', 'exec "$@"'); script('nohup', 'exec "$@"'); script('flock', 'exit 0');
  script('base64', process.platform === 'darwin' ? '/usr/bin/base64 -i "$1"' : '/usr/bin/base64 "$1"');
  if (applet) script(applet, '[ "$1" = sha256sum ] || exit 127\nshift\nexec /usr/bin/shasum -a 256 "$@"');
  script('pm', `printf '%s\\n' "$1" >> '${directory}/pm-calls'\ncase "$1" in install-create) printf 'Success: created install session [42]\\n';; install-write|install-commit) printf 'Success\\n';; *) exit 1;; esac`);
  fs.writeFileSync(path.join(directory, 'boot'), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n');
  fs.writeFileSync(path.join(directory, 'uptime'), '100.00 0.00\n');
  const env = { ...process.env, PATH: bin };
  const translate = value => value.replaceAll('/data/local/tmp', directory)
    .replaceAll('/proc/sys/kernel/random/boot_id', path.join(directory, 'boot'))
    .replaceAll('/proc/uptime', path.join(directory, 'uptime'));
  const run = (_adb, argv) => execute('/bin/bash', ['-c', translate(unquote(argv.at(-1)))], { env });
  return { directory, env, run, translate };
}

for (const applet of ['busybox', 'toybox']) {
  test(`shell worker verifies and completes when SHA-256 is only ${applet} sha256sum`, async t => {
    const f = fixture(t, applet);
    const port = createAndroidShellPort({ adb: 'fixture-adb', serial: 'fixture-phone', run: f.run });
    const identity = await port.prepare(['printf', 'executed']);
    const job = path.join(f.directory, 'ai-app-bridge-shell/v1', identity.jobId);
    await execute('/bin/bash', [path.join(job, 'worker.sh')], { env: f.env });
    const receipt = await port.query(identity);
    assert.equal(terminalReceipt(receipt, identity), true, JSON.stringify(receipt));
    assert.equal(receipt.exitCode, 0);
    assert.equal((await port.output(identity)).stdout, 'executed');
  });
}

test('install worker hashes the APK through busybox before one PM session commit', async t => {
  const f = fixture(t), installId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const job = path.join(f.directory, 'ai-app-bridge-install/v1', installId); fs.mkdirSync(job, { recursive: true });
  const apk = Buffer.from('controlled APK bytes'); fs.writeFileSync(path.join(job, 'base.apk'), apk);
  const identity = { installId, scriptVersion: 2, packageName: 'fixture.app', apkBytes: apk.length,
    apkSha256: createHash('sha256').update(apk).digest('hex'), allowDowngrade: false };
  const result = await execute('/bin/bash', ['-c', f.translate(installScript(identity))], { env: f.env });
  assert.equal(JSON.parse(result.stdout).phase, 'commit-returned', result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.directory, 'pm-calls'), 'utf8'), 'install-create\ninstall-write\ninstall-commit\n');
});

test('changed command bytes produce a terminal non-dispatch receipt instead of stranding ownership', async t => {
  const f = fixture(t), port = createAndroidShellPort({ adb: 'fixture-adb', serial: 'fixture-phone', run: f.run });
  const identity = await port.prepare(['printf', 'original']);
  const job = path.join(f.directory, 'ai-app-bridge-shell/v1', identity.jobId);
  fs.appendFileSync(path.join(job, 'command.sh'), '\nprintf changed\n');
  await execute('/bin/bash', [path.join(job, 'worker.sh')], { env: f.env });
  const receipt = await port.query(identity);
  assert.equal(terminalReceipt(receipt, identity), true, JSON.stringify(receipt));
  assert.equal(receipt.error, 'shell_command_mismatch');
  assert.equal(receipt.dispatched, false);
  assert.equal(fs.existsSync(path.join(job, 'stdout')), false);
});

test('missing all SHA-256 implementations fails before a shell job is admitted', async t => {
  const f = fixture(t, null), port = createAndroidShellPort({ adb: 'fixture-adb', serial: 'fixture-phone', run: f.run });
  await assert.rejects(port.prepare(['printf', 'unused']), error => error.code === 'android_sha256_unavailable' && error.dispatched === false);
  assert.equal(fs.existsSync(path.join(f.directory, 'ai-app-bridge-shell/v1')), false);
});
