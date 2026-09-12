'use strict';

const { randomUUID } = require('node:crypto');

const bootId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const runtimeEpoch = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

function uiaXml(xml, { boot = bootId, epoch = runtimeEpoch, snapshotId = randomUUID() } = {}) {
  return xml.replace(/<hierarchy\b/, `<hierarchy aab-schema="aab.uia.snapshot.v1" aab-boot-id="${boot}" aab-runtime-epoch="${epoch}" aab-snapshot-id="${snapshotId}"`)
    .replace(/<node\b/g, () => `<node aab-ref="${randomUUID()}"`);
}

module.exports = { uiaXml, bootId, runtimeEpoch };
