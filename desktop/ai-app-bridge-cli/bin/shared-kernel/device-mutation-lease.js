'use strict';

const { createTargetLease } = require('./target-lease-protocol');

function createDeviceMutationLease() {
  return createTargetLease({ maxActive: 1 });
}

const processLease = createDeviceMutationLease();

function getProcessDeviceMutationLease() {
  return processLease;
}

module.exports = { createDeviceMutationLease, getProcessDeviceMutationLease };
