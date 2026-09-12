#!/usr/bin/env node
'use strict';

// Qualifies the WDA preparation path from an actual tarball installed outside
// the checkout. It does not select, install to, or operate a physical device.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const source = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output); // Keep prior validation evidence immutable.
const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = { ...process.env, NODE_PATH: '', AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(output, 'ownership') };
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], {
  cwd: source, env, encoding: 'utf8', timeout: 60000,
}))[0];
write('pack.json', packed);
const tarball = path.join(output, packed.filename);
const install = path.join(output, 'clean-install');
fs.mkdirSync(install);
fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'aab-wda-package-validation', private: true }));
const log = fs.openSync(path.join(output, 'install.log'), 'w');
try {
  execFileSync('npm', ['install', '--foreground-scripts', '--prefer-offline', '--no-audit', '--no-fund', tarball],
    { cwd: install, env, stdio: ['ignore', log, log], timeout: 300000 });
} finally { fs.closeSync(log); }
const installLog = fs.readFileSync(path.join(output, 'install.log'), 'utf8');
assert.match(installLog, /@mobileaidev\/segmented-fact-store-native@[^\s]+ install/);
assert.match(installLog, /gyp info ok/);
const installed = path.join(install, 'node_modules/@mobileaidev/ai-app-bridge');
const checked = [];
for (const file of packed.files.filter(file => /^(bin\/|runtime\/ios-wda\/)/.test(file.path))) {
  const current = path.join(source, file.path), actual = path.join(installed, file.path);
  assert.equal(sha256(actual), sha256(current), file.path);
  checked.push({ path: file.path, bytes: fs.statSync(actual).size, sha256: sha256(actual) });
}
// Resolve every module from the clean installation in a new process.
const probe = [
  "const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');",
  "const { createRequire } = require('node:module');",
  'const root = ' + JSON.stringify(installed) + ';',
  "const local = createRequire(path.join(root, 'package.json'));",
  "const builder = local('./bin/ios-wda-project');",
  "const provider = local('./bin/ios-provider');",
  "const registry = local('./bin/command-registry');",
  "assert.equal(typeof provider.IOSBridgeProvider, 'function');",
  "assert.equal(local('appium-webdriveragent/package.json').version, '14.1.1');",
  "const schema = registry.commandSchema('ios-tap');",
  "assert.deepEqual(schema.required, ['deviceId','wdaRunnerBundleId','bundleId','wdaSessionId','tapX','tapY']);",
  "assert.equal(local('./bin/mcp-server').capabilityPayload({command:'ios-tap'}).targetKind, 'ios-app');",
  "assert.equal(typeof local('./bin/ios-wda-execution').executeWDAAction, 'function');",
  "assert.equal(registry.commandSchema('ios-execution').properties.kind.enum.includes('wda'), true);",
  'const prepared = builder.prepareWdaProject({destination:' + JSON.stringify(path.join(output, 'prepared-wda')) + '});',
  "const script = path.join(path.dirname(prepared.projectPath), 'Scripts/embed-runner-icon.sh');",
  "assert.ok(fs.statSync(script).mode & 0o111);",
  "const upstream = path.dirname(local.resolve('appium-webdriveragent/package.json'));",
  "for (const edit of prepared.transformations) {",
  "  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(upstream, edit.path))).digest('hex');",
  "  assert.equal(digest, edit.beforeSha256);",
  "}",
  "const nativeRoot = path.dirname(local.resolve('@mobileaidev/segmented-fact-store-native/package.json'));",
  "for (const file of prepared.nativeCore.files) {",
  "  const digest = name => require('node:crypto').createHash('sha256').update(fs.readFileSync(name)).digest('hex');",
  "  assert.equal(digest(path.join(nativeRoot, file.path)), file.sha256);",
  "  assert.equal(digest(path.join(path.dirname(prepared.projectPath), 'WebDriverAgentLib/Routing', path.basename(file.path))), file.sha256);",
  "}",
  "console.log(JSON.stringify({ok:true,upstream,prepared,physicalDeviceClaim:false}));",
].join('\n');
fs.writeFileSync(path.join(output, 'probe.cjs'), probe);
const probeResult = JSON.parse(execFileSync(process.execPath, [path.join(output, 'probe.cjs')], {
  cwd: install, env, encoding: 'utf8', timeout: 30000,
}));
write('probe.json', probeResult);
const help = execFileSync(process.execPath, [path.join(installed, 'bin/ai-app-bridge.js'), '--help', 'ios-wda-session'],
  { cwd: install, env, encoding: 'utf8', timeout: 15000 });
assert.match(help, /wdaRunnerBundleId|wda-runner-bundle-id/);
fs.writeFileSync(path.join(output, 'session-help.txt'), help);
const report = { ok: true, tarball: packed.filename, sha256: sha256(tarball),
  installation: 'fresh npm install with actual successful native node-gyp lifecycle',
  runtimeFileCount: checked.filter(file => file.path.startsWith('bin/')).length,
  wdaSourceFileCount: checked.filter(file => file.path.startsWith('runtime/ios-wda/')).length,
  checked, preparedProject: probeResult.prepared, physicalDeviceClaim: false };
write('report.json', report);
process.stdout.write(JSON.stringify({ ok: report.ok, sha256: report.sha256,
  runtimeFileCount: report.runtimeFileCount, wdaSourceFileCount: report.wdaSourceFileCount,
  report: path.join(output, 'report.json'), physicalDeviceClaim: false }) + '\n');
