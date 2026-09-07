'use strict';

const { createScriptSupervisor, createDefaultRuntime } = require('../../bin/script/script-supervisor');
const { createFakeRuntimeAdapter } = require('../../bin/script/fake-runtime-adapter');

// Test-only program injection; source-only cases still spawn the real language runtime.
function createTestScriptSupervisor(options = {}) {
  return createScriptSupervisor({
    ...options,
    createRuntime: options.createRuntime || ((runtimeOptions) => (
      runtimeOptions.program
        ? createFakeRuntimeAdapter(runtimeOptions)
        : createDefaultRuntime(runtimeOptions)
    )),
  });
}

module.exports = { createTestScriptSupervisor };
