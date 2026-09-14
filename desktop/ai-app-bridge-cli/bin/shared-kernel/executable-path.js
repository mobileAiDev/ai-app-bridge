'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Match direct executable lookup, without invoking a shell or running the tool.
// An unavailable optional provider must not prevent Web or iOS runtime startup.
function executablePath(command, { env = process.env, cwd = process.cwd() } = {}) {
  const explicit = command.includes('/') || (process.platform === 'win32' && command.includes('\\'));
  const directories = explicit ? [''] : (env.PATH ?? '/usr/bin:/bin').split(path.delimiter);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(cwd, directory, command + extension);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
      }
    }
  }
  return null;
}

module.exports = { executablePath };
