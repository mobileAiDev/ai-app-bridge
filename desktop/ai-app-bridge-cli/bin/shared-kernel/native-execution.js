'use strict';

const managed = require('./managed-sdk-execution');
const schema = 'aab.native-execution/v1';

function executeNativeAction({ runtime, ...options }) {
  return managed.executeManagedAction({ ...options, kind: 'native', schema, runtime: runtime });
}

module.exports = { schema, executeNativeAction,
  terminalReceipt: (result, identity) => managed.terminalReceipt(schema, result, identity),
  settlementProof: (result, identity) => managed.settlementProof('native', schema, result, identity),
};
