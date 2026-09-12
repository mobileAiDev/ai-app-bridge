'use strict';

const { object, text, integer } = require('./argument-schema');
const { h5TargetContract } = require('./h5-target');
const schema = 'aab.ios-h5-target/v1';
const pageSchema = object({ schemaVersion: { const: schema }, runtimeEpoch: text, bundleId: text,
  processId: integer(1), webViewId: text, documentId: text, url: text },
['schemaVersion', 'runtimeEpoch', 'bundleId', 'processId', 'webViewId', 'documentId', 'url']);
module.exports = h5TargetContract({ schema, pageSchema, errorPrefix: 'ios_h5' });
