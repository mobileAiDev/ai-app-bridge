'use strict';

const { object, text, integer } = require('./argument-schema');
const { h5TargetContract } = require('./h5-target');
const schema = 'aab.android-h5-target/v1';
const pageSchema = object({ schemaVersion: { const: schema }, runtimeEpoch: text, packageName: text,
  processId: integer(1), activity: text, windowId: text, webViewId: text, documentId: text, url: text },
['schemaVersion', 'runtimeEpoch', 'packageName', 'processId', 'activity', 'windowId', 'webViewId', 'documentId', 'url']);

module.exports = h5TargetContract({ schema, pageSchema, errorPrefix: 'android_h5' });
