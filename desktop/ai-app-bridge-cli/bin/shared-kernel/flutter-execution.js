'use strict';

const managed = require('./managed-sdk-execution');
const schema = 'aab.flutter-execution/v1';

function executeFlutterAction({ tree, ...options }) {
  return managed.executeManagedAction({ ...options, kind: 'flutter', schema, runtime: tree });
}

module.exports = { schema, executeFlutterAction,
  terminalReceipt: (result, identity) => managed.terminalReceipt(schema, result, identity),
  settlementProof: (result, identity) => managed.settlementProof('flutter', schema, result, identity),
};
