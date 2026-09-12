'use strict';

const { canonicalJson, checksumOf } = require('./evidence-schema');
const { capturePageMetadata } = require('./live-capture-query');
const { requireValue, sha256, jsonHash, checkPng, PAYLOAD_SCHEMA, MAX_FILE_BYTES,
  MAX_RECORDING_BYTES } = require('./evidence-recording');

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const portableName = (file, extension) => `payload-${file.sha256}.${extension}`;

// The same analysis runs while exporting and offline. readFile chooses only the
// source location; no payload identities or coverage claims come from a manifest.
function analyzeRecordedPayloads(facts, readFile) {
  const records = facts.map(f => f.payload);
  const byId = new Map(records.map(r => [r.evidenceId, r]));
  const positions = new Map(facts.map(f => [f.payload.evidenceId, f.globalSeq]));
  const calls = new Map();
  const callIds = new Set();
  const sequences = new Set();
  const files = new Map();
  const attachments = [];
  const missingReferences = [];
  const counts = { scriptCalls: 0, assertions: { passed: 0, failed: 0, inconclusive: 0 },
    screenshots: 0, mobilePages: 0, mobileItems: 0, boundMobileItems: 0,
    webPages: 0, webItems: 0, boundWebItems: 0, redactedPayloads: 0 };
  let totalBytes = 0;
  function read(record, file, extension) {
    requireValue(file && /^[a-f0-9]{64}$/.test(file.sha256)
      && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_FILE_BYTES, 'invalid_attachment_file');
    const name = portableName(file, extension);
    const bytes = readFile(record, file, name);
    requireValue(bytes.length === file.bytes && sha256(bytes) === file.sha256, 'attachment_checksum_mismatch', record.evidenceId);
    if (!files.has(name)) {
      totalBytes += bytes.length;
      requireValue(totalBytes <= MAX_RECORDING_BYTES, 'archive_limit_exceeded');
      files.set(name, { path: name, bytes: file.bytes, sha256: file.sha256 });
    }
    return bytes;
  }
  for (const record of records) {
    if (record.kind !== 'attachment') continue;
    requireValue(Number.isSafeInteger(record.sequence) && record.sequence > 0
      && record.file.name === `${record.sequence}.json`, 'invalid_attachment_sequence');
    const key = `${record.recordingId}:${record.sequence}`;
    requireValue(!sequences.has(key), 'duplicate_attachment');
    sequences.add(key);
    const doc = JSON.parse(read(record, record.file, 'json'));
    requireValue(doc.schemaVersion === PAYLOAD_SCHEMA && doc.namespace === record.namespace
      && doc.operationId === record.operationId && doc.recordingId === record.recordingId
      && doc.sequence === record.sequence && doc.kind === record.payloadKind
      && same(doc.target, record.target), 'attachment_binding_mismatch', record.evidenceId);
    requireValue(jsonHash(doc.data) === record.dataSha256 && /^[a-f0-9]{64}$/.test(record.originalSha256),
      'attachment_data_mismatch');
    requireValue(record.representation === (record.originalSha256 === record.dataSha256 ? 'original-json' : 'redacted-json'),
      'attachment_representation_mismatch');
    if (record.representation === 'redacted-json') counts.redactedPayloads += 1;
    requireValue(Array.isArray(record.screenshots) && Array.isArray(doc.screenshots)
      && record.screenshots.length === doc.screenshots.length, 'invalid_screenshot_reference');
    const screenshotFiles = [];
    for (let i = 0; i < record.screenshots.length; i += 1) {
      const file = record.screenshots[i];
      const { ref, ...metadata } = doc.screenshots[i];
      requireValue(file.name === `${record.sequence}-${i + 1}.png` && same(file, metadata)
        && ref?.sha256 === file.sha256, 'invalid_screenshot_reference');
      checkPng(read(record, file, 'png'));
      screenshotFiles.push(portableName(file, 'png'));
      counts.screenshots += 1;
    }
    attachments.push({ evidenceId: record.evidenceId, path: portableName(record.file, 'json'), screenshots: screenshotFiles });
    if (doc.kind === 'script-call') {
      requireValue(record.namespace === 'script', 'attachment_binding_mismatch');
      const { command, args, envelope } = doc.data;
      requireValue(envelope?.command === command && (envelope.execution?.executionId === record.operationId
        || (envelope.ok === false && envelope.execution?.executionId === undefined)), 'call_binding_mismatch');
      if (envelope.execution?.callId) {
        requireValue(!callIds.has(envelope.execution.callId), 'duplicate_call_id');
        callIds.add(envelope.execution.callId);
      }
      const evidence = envelope.evidence;
      if (evidence?.source) {
        requireValue(evidence.source.command === command && evidence.source.scope === 'execution'
          && evidence.source.payloadSha256 === record.sourcePayload?.originalSha256
          && jsonHash(envelope.result) === record.sourcePayload?.archivedSha256, 'call_source_mismatch');
      }
      if (evidence?.observationId) {
        requireValue(!calls.has(evidence.observationId), 'duplicate_observation_id');
        calls.set(evidence.observationId, evidence);
      }
      const screenshotRefs = (evidence?.refs || []).filter(ref => ref.stream === 'screenshot');
      requireValue(same(screenshotRefs, doc.screenshots.map(s => s.ref)), 'invalid_screenshot_reference');
      const actionId = envelope.execution?.actionId;
      if (actionId) {
        const marker = records.find(r => r.kind === 'dispatch-marker' && r.actionId === actionId);
        if (!marker) missingReferences.push({ evidenceId: record.evidenceId, field: 'actionId', value: actionId });
        else requireValue(positions.get(marker.evidenceId) < positions.get(record.evidenceId)
          && same(marker.target, record.target) && (record.representation === 'redacted-json'
          || marker.actionSpecHash === checksumOf({ command, args })), 'call_action_mismatch');
      }
      if (evidence?.capture) {
        analyzeCapturePage({ ...evidence.capture, stream: command.replace(/^web-/, ''),
          window: evidence.window, coverage: evidence.coverage,
          refs: evidence.refs, items: envelope.result.items }, counts, doc.target);
      }
      counts.scriptCalls += 1;
    } else if (doc.kind === 'script-assertion') {
      requireValue(record.namespace === 'script' && doc.screenshots.length === 0, 'attachment_binding_mismatch');
      const { assertion, result } = doc.data;
      requireValue(['passed', 'failed', 'inconclusive'].includes(result?.verdict), 'invalid_recorded_assertion');
      counts.assertions[result.verdict] += 1;
      // Preserve rejected assertion attempts too. A child-supplied predicate is
      // a claim; this verifier checks its Host evidence association, not business truth.
      if (result.scope === 'device' && result.verdict !== 'inconclusive') {
        const id = assertion.evidence?.observationId;
        const evidence = calls.get(id);
        if (!evidence) missingReferences.push({ evidenceId: record.evidenceId, field: 'observationId', value: id ?? null });
        else for (const field of ['observationId', 'source', 'window', 'coverage', 'refs', 'capture']) {
          requireValue(same(assertion.evidence[field], evidence[field]), 'assertion_binding_mismatch', field);
        }
      }
    } else if (doc.kind === 'intent-capture') {
      requireValue(record.namespace === 'intent' && doc.screenshots.length === 0, 'attachment_binding_mismatch');
      const { capture, rawTreeId } = doc.data;
      requireValue(Array.isArray(capture?.pages), 'invalid_recorded_capture');
      const observation = byId.get(record.parentFactId);
      if (observation) {
        requireValue(observation.kind === 'observation' && observation.rawTreeId === rawTreeId
          && observation.revision === record.revision && same(observation.captureRefs, capture.refs)
          && same(observation.captureCoverage, capture.coverage), 'capture_observation_mismatch');
        requireValue(same(observation.capturePages, capture.pages.map(capturePageMetadata)), 'capture_observation_mismatch');
      }
      requireValue(same(capture.refs, capture.pages.flatMap(p => p.refs))
        && same(capture.items, capture.pages.flatMap(p => p.items)), 'capture_page_mismatch');
      for (const page of capture.pages) analyzeCapturePage(page, counts, doc.target);
    } else requireValue(false, 'unsupported_recorded_payload');
  }
  return { scope: 'retained-recorded-payloads', priorHistoryComplete: 'unknown',
    executionStatus: 'not-inferred', businessVerdict: 'not-evaluated',
    referenceClosure: missingReferences.length ? 'partial' : 'complete', missingReferences,
    attachmentCount: attachments.length, bytes: totalBytes, counts, attachments, files: [...files.values()],
    exclusions: ['unrecorded-calls-and-screenshots', 'unqueried-mobile-facts', 'in-memory-events'] };
}

function analyzeCapturePage(page, counts, target) {
  requireValue(Array.isArray(page.items) && Array.isArray(page.refs)
    && ['complete', 'partial', 'unavailable'].includes(page.coverage?.status), 'invalid_recorded_capture');
  if (target.platform === 'web') return analyzeWebPage(page, counts, target);
  counts.mobilePages += 1;
  counts.mobileItems += page.items.length;
  // Uncommitted/memory-only pages remain inspectable without strong fact refs.
  if (page.coverage.committed !== true) return;
  requireValue(page.refs.length === page.items.length, 'capture_ref_count_mismatch');
  const ids = new Set();
  for (let i = 0; i < page.refs.length; i += 1) {
    const ref = page.refs[i];
    const item = page.items[i];
    requireValue(typeof ref.mobileFactId === 'string' && ref.mobileFactId.length > 0 && !ids.has(ref.mobileFactId)
      && typeof ref.runtimeEpoch === 'string' && ref.runtimeEpoch.length > 0
      && ref.targetKey === page.targetKey && ref.captureId === item.id && ref.capturedAtMs === item.timestampMs
      && ({ logs: 'log', network: 'network', state: 'state', events: 'event' })[ref.stream] === item.type,
    'capture_ref_binding_mismatch');
    // Connected history may include older epochs; its page epoch is the current
    // runtime. Only an explicitly filtered window restricts each fact's epoch.
    if (page.window?.runtimeEpoch != null) requireValue(ref.runtimeEpoch === page.window.runtimeEpoch, 'capture_epoch_mismatch');
    ids.add(ref.mobileFactId);
    counts.boundMobileItems += 1;
  }
}

function analyzeWebPage(page, counts, target) {
  counts.webPages += 1; counts.webItems += page.items.length;
  if (page.coverage.committed !== true) return;
  requireValue(['logs', 'network', 'state', 'events'].includes(page.stream), 'invalid_web_capture_stream');
  const targetKey = `web:${JSON.stringify([target.sessionId, target.targetId, page.stream])}`;
  requireValue(page.targetKey === targetKey && page.runtimeEpoch === target.runtimeEpoch
    && page.refs.length === page.items.length, 'web_capture_target_mismatch');
  const ids = new Set();
  for (let index = 0; index < page.items.length; index++) {
    const item = page.items[index], ref = page.refs[index];
    requireValue(ref.source === 'host-fact-store' && ref.stream === page.stream
      && ref.targetKey === targetKey && ref.runtimeEpoch === target.runtimeEpoch
      && Number.isSafeInteger(ref.globalSeq) && ref.globalSeq > 0 && !ids.has(ref.globalSeq)
      && ref.globalSeq === item.id && same(ref, item.ref)
      && item.sessionId === target.sessionId && item.targetId === target.targetId && item.runtimeEpoch === target.runtimeEpoch
      && typeof item.captureId === 'string' && item.captureId.length > 0
      && Number.isSafeInteger(item.sourceSequence) && item.sourceSequence > 0,
    'web_capture_ref_binding_mismatch');
    requireValue(item.association === 'unattributed' ? item.actionId === null
      : ['explicit', 'synchronous'].includes(item.association) && typeof item.actionId === 'string' && item.actionId.length > 0,
    'web_capture_action_binding_mismatch');
    if (page.window?.afterActionId != null) requireValue(item.actionId === page.window.afterActionId, 'web_capture_action_binding_mismatch');
    ids.add(ref.globalSeq); counts.boundWebItems += 1;
  }
}

module.exports = { analyzeRecordedPayloads };
