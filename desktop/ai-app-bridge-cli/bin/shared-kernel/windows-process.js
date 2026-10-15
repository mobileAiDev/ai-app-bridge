'use strict';

// A separate Job per Script is nested under the Runtime Job. The OS closes
// these handles on process death, including when no JavaScript cleanup runs.
function createProcessScope(pid) {
  return process.platform === 'win32'
    ? require('@mobileaidev/segmented-fact-store-native').windowsCreateProcessScope(pid)
    : null;
}

function retainRuntimeProcessScope() {
  const scope = createProcessScope(process.pid);
  // Retain the native handle for the entire process lifetime. Do not explicitly
  // close a Job containing this Runtime before its durable shutdown completes.
  if (scope) process.once('exit', () => scope);
}

module.exports = { createProcessScope, retainRuntimeProcessScope };
