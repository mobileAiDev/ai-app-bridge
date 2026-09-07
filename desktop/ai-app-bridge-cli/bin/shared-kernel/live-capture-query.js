'use strict';

function createLiveCaptureQuery({ runner } = {}) {
  if (typeof runner !== 'function') {
    throw new TypeError('runner');
  }

  async function query(request = {}) {
    const command = commandFor(request);
    if (!command) return unavailablePage('unsupported_capture_stream');
    const { command: _command, stream: _stream, platform: _platform, ...args } = request;
    let result;
    try {
      result = await runner(command, {
        ...args,
        limit: request.limit == null ? 200 : request.limit,
      });
    } catch (error) {
      return unavailablePage(error.code || error.message || 'capture_query_failed');
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
  if (!result || result.ok === false || result.error || !coverage) {
    return unavailablePage(result?.error || result?.reason || 'capture_contract_unavailable');
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

function unavailablePage(error = 'capture_unavailable') {
  return {
    ok: false,
    error,
    coverage: { status: 'unavailable', gap: true, committed: false },
    gap: true,
    committed: false,
    refs: [],
    items: [],
  };
}

module.exports = { createLiveCaptureQuery, capturePage, unavailablePage };
