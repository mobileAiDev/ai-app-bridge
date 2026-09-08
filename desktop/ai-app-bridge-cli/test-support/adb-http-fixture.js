'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Describe the already listening test HTTP server as an ADB forward, without using a device.
function createAdbHttpFixture({ directory, serial, port, logPath }) {
  const file = path.join(directory, 'adb-http-fixture');
  const mapping = `${serial} tcp:${port} tcp:${port}\n`;
  fs.writeFileSync(file, `#!${process.execPath}
const args = process.argv.slice(2);
${logPath ? `require('node:fs').appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');` : ''}
if (args.includes('--list')) process.stdout.write(${JSON.stringify(mapping)});
`, { mode: 0o755 });
  return file;
}

module.exports = { createAdbHttpFixture };
