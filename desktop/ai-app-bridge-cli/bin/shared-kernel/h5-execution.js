'use strict';

const managed = require('./managed-sdk-execution');
const schema = 'aab.h5-execution/v1';

module.exports = {
  schema,
  executeH5Action: options => managed.executeManagedAction({ ...options, kind: 'h5', schema }),
  terminalReceipt: (result, identity) => managed.terminalReceipt(schema, result, identity),
  settlementProof: (result, identity) => managed.settlementProof('h5', schema, result, identity),
};
