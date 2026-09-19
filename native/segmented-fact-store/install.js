'use strict';
// Validate the bundled binary; never invoke a compiler or download a substitute.
require('./index');
const info = require('./binding-path').resolveBinding();
process.stdout.write(`FactStore prebuild ${info.target} ${info.sha256}\n`);
