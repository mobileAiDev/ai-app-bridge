'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Describe the already listening test HTTP server as an ADB forward, without using a device.
function createAdbHttpFixture({ directory, serial, port, logPath, foregroundPackage }) {
  const file = path.join(directory, 'adb-http-fixture');
  const runtimeEpoch = '1788970540000-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41';
  const socketName = `aab-sdk-${runtimeEpoch}`;
  const mapping = `${serial} tcp:${port} localabstract:${socketName}\n`;
  fs.writeFileSync(file, `#!${process.execPath}
const args = process.argv.slice(2);
${logPath ? `require('node:fs').appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');` : ''}
if (args.includes('--list')) process.stdout.write(${JSON.stringify(mapping)});
if (args.includes('get-serialno')) process.stdout.write(${JSON.stringify(serial)});
if (args.includes('files/ai_app_bridge_endpoint.json')) process.stdout.write(JSON.stringify({
  schema: 'ai-app-bridge.android-endpoint.v1', ok: true,
  packageName: args[args.indexOf('run-as') + 1], transport: 'localabstract',
  runtimeEpoch: ${JSON.stringify(runtimeEpoch)}, socketName: ${JSON.stringify(socketName)},
  version: 'test', updatedAtMs: 1788970540000,
}));
${foregroundPackage ? `if (args.includes('dumpsys') && args.includes('window')) process.stdout.write(${JSON.stringify(`mCurrentFocus=Window{test u0 ${foregroundPackage}/${foregroundPackage}.MainActivity}\n`)});` : ''}
`, { mode: 0o755 });
  return file;
}

module.exports = { createAdbHttpFixture };
