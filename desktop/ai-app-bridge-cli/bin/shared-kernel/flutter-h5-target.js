'use strict';

const { object, text } = require('./argument-schema');
const { h5TargetContract } = require('./h5-target');
const schema = 'aab.flutter-h5-target/v1';
const fields = ['runtimeEpoch', 'adapterId', 'adapterGeneration', 'documentId', 'url'];
const pageSchema = object({ schemaVersion: { const: schema },
  ...Object.fromEntries(fields.map(key => [key, text])) }, ['schemaVersion', ...fields]);
module.exports = h5TargetContract({ schema, pageSchema, errorPrefix: 'flutter_h5' });
