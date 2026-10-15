'use strict';

// Each unfinished execution owns a Job handle in its Host. Host death closes
// those handles; independent controllers and completed daemons own their lives.
function createProcessScope(pid) {
  return process.platform === 'win32'
    ? require('@mobileaidev/segmented-fact-store-native').windowsCreateProcessScope(pid)
    : null;
}

module.exports = { createProcessScope };
