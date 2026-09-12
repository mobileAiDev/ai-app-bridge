'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Resolve existing ancestors too, so a not-yet-created store has the same
// identity before and after mkdir, including macOS /var and /private/var.
function canonicalPath(input) {
  const absolute = path.resolve(input);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute));
  }
}

module.exports = { canonicalPath };
