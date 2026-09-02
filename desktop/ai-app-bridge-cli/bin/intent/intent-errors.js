'use strict';

function emptyTimings() {
  return {
    workerOverheadMs: 0,
    targetLeaseWaitMs: 0,
    providerAcquireMs: 0,
    evidenceCommitMs: 0,
    summaryMs: 0,
    decisionWaitMs: 0,
    actionMs: 0,
    receiptCommitMs: 0,
    totalMs: 0,
  };
}

function intentError(error, extra = {}) {
  return {
    ok: false,
    command: 'intent',
    latestEvidenceIds: extra.latestEvidenceIds || {},
    timings: extra.timings || emptyTimings(),
    ...extra,
    error,
  };
}

module.exports = { intentError, emptyTimings };
