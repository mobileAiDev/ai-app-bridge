'use strict';

function createLiveCaptureQuery({ runner } = {}) {
  if (typeof runner !== 'function') {
    throw new TypeError('runner');
  }

  async function query(request = {}) {
    const command = commandFor(request);
    if (!command) return unavailablePage('unsupported_capture_stream');
    const { command: _command, stream: _stream, platform: _platform, ...args } = request;
    // CaptureRequest uses null for an absent window boundary. Public command
    // arguments represent absence by omission; no payload or error is replaced.
    for (const key of ['serial', 'packageName', 'afterActionId', 'runtimeEpoch', 'sinceMs', 'timeoutMs']) {
      if (args[key] == null) delete args[key];
    }
    let result;
    try {
      result = await runner(command, {
        ...args,
        limit: request.limit == null ? (command.startsWith('web-') ? 16 : 200) : request.limit,
      });
    } catch (error) {
      return unavailablePage(error.code || error.message || 'capture_query_failed', error);
    }
    if (request.view === 'decision-window' && request.runtimeEpoch != null
      && result?.runtimeEpoch !== request.runtimeEpoch && result?.coverage?.status === 'complete') {
      return unavailablePage('runtime_epoch_changed');
    }
    const expectedTarget = request.targetKey ?? (command.startsWith('ios-') ? request.bundleId : request.packageName);
    if (expectedTarget != null && result?.targetKey !== expectedTarget
      && result?.coverage?.status === 'complete') return unavailablePage('capture_target_mismatch');
    return capturePage(result);
  }

  return query;
}

// Keep mobile-issued window, epoch, refs and pagination intact through each port.
// Legacy payloads and explicit failures never acquire invented strong coverage.
function capturePage(result) {
  const coverage = coverageOf(result);
  if (!result || result.ok === false || result.error || !coverage || coverage.status === 'unavailable') {
    return unavailablePage(result?.error || result?.reason || 'capture_contract_unavailable', result || {});
  }
  if (!Array.isArray(result.refs) || !Array.isArray(result.items)) {
    return unavailablePage('capture_contract_invalid');
  }
  return {
    ...result,
    coverage,
    gap: coverage.gap === true || result.gap === true,
    committed: coverage.committed === true,
  };
}

function coverageOf(result) {
  const coverage = result && result.coverage;
  if (
    !coverage
    || (coverage.status !== 'complete'
      && coverage.status !== 'partial'
      && coverage.status !== 'unavailable')
  ) {
    return null;
  }
  return coverage;
}

// The durable observation and the portable payload verifier share this exact
// metadata projection. Optional diagnostics remain absent when not supplied.
function capturePageMetadata(page) {
  return {
    stream: page.stream, coverage: page.coverage, window: page.window,
    runtimeEpoch: page.runtimeEpoch, targetKey: page.targetKey, storeGeneration: page.storeGeneration,
    watermarkCursor: page.watermarkCursor, nextCursor: page.nextCursor,
    hasMore: page.hasMore, throughWatermark: page.throughWatermark,
    ...(page.barrier === undefined ? {} : { barrier: page.barrier }),
    error: page.error || page.reason || null,
    ...(page.field === undefined ? {} : { field: page.field }),
    ...(page.message === undefined ? {} : { message: page.message }),
  };
}

function commandFor(request) {
  const stream = request.stream;
  if (stream !== 'logs' && stream !== 'network' && stream !== 'state' && stream !== 'events') {
    return null;
  }
  if (request.command) {
    const commands = [stream, `ios-${stream}`, `web-${stream}`];
    if (stream === 'logs') commands.push('webview-console');
    if (stream === 'network') commands.push('webview-network');
    return commands.includes(request.command) ? request.command : null;
  }
  if (request.platform === 'ios') return `ios-${stream}`;
  if (request.platform === 'web') return `web-${stream}`;
  return stream;
}

function unavailablePage(error = 'capture_unavailable', { field, message } = {}) {
  return {
    ok: false,
    error,
    ...(field === undefined ? {} : { field }),
    ...(message === undefined ? {} : { message }),
    coverage: { status: 'unavailable', gap: true, committed: false },
    gap: true,
    committed: false,
    refs: [],
    items: [],
  };
}

module.exports = { createLiveCaptureQuery, capturePage, capturePageMetadata, unavailablePage };
