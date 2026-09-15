'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { defaultDirectory } = require('../shared-kernel/device-ownership-store');
const { CommandError } = require('../command-errors');
const { atomicJson, readJson } = require('./managed-runtime');
const { AndroidExecutorPort } = require('./android-port');

const fileFor = serial => path.join(defaultDirectory(), 'automation-sessions', createHash('sha256').update(serial).digest('hex') + '.json');
function owner(serial) { return readJson(fileFor(serial)); }
function claim(serial, descriptorFile) {
  const descriptor = readJson(descriptorFile);
  if (!descriptor || descriptor.serial !== serial) throw new CommandError('executor_descriptor_mismatch', 'Automation claim requires the exact device descriptor.');
  const claim = { serial, sessionId: descriptor.sessionId, descriptorFile };
  atomicJson(fileFor(serial), claim);
  return claim;
}
function release(serial, sessionId) {
  const current = owner(serial);
  if (!current) return;
  if (current.sessionId !== sessionId) throw new CommandError('executor_automation_owner_changed', 'A different test session owns UiAutomation.');
  fs.unlinkSync(fileFor(serial));
  const fd = fs.openSync(path.dirname(fileFor(serial)), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function assertAvailable(serial) {
  const current = owner(serial);
  if (!current) return;
  const descriptor = readJson(current.descriptorFile);
  if (!descriptor || descriptor.serial !== serial || descriptor.sessionId !== current.sessionId)
    throw new CommandError('executor_automation_owner_invalid', 'The recorded UiAutomation owner cannot be resolved.');
  const port = new AndroidExecutorPort(descriptor);
  const runner = readJson(path.join(path.dirname(current.descriptorFile), 'runner-result.json'));
  if ((runner?.sessionId === current.sessionId && runner.instrumentFinished)
    || await port.bootChanged() || (descriptor.pid && await port.processEnded())) { release(serial, current.sessionId); return; }
  throw new CommandError('uia_owned_by_test_executor', 'The test session owns UiAutomation. Use android-executor with engine uiautomator, or close that session first.',
    { dispatched: false, ambiguous: false, details: { serial, sessionId: current.sessionId, runtimeEpoch: descriptor.runtimeEpoch, packageName: descriptor.packageName } });
}

module.exports = { owner, claim, release, assertAvailable };
