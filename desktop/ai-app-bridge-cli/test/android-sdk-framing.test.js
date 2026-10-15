'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { executeCommand } = require('../test-support/host-client');
const { executeProviderCommand } = require('../bin/device-provider');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
const { schema } = require('../bin/shared-kernel/h5-execution');
const { schema: targetSchema } = require('../bin/shared-kernel/android-h5-target');

const runtimeEpoch = '1788970540000-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41';
const packageName = 'example.framing';
const pageRef = { schemaVersion: targetSchema, runtimeEpoch, packageName, processId: 42,
  activity: 'example.framing.Main', windowId: 'window-1', webViewId: 'webview-1', documentId: 'document-1', url: 'https://bridge.test/' };

async function fixture(t, reject, bodyLimit = Infinity) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader('Connection', 'close');
    const declaredBytes = Number(request.headers['content-length'] || 0);
    if (declaredBytes > bodyLimit) {
      requests.push({ path: request.url, bytes: declaredBytes });
      // This fixture tests receipt classification, not the SDK's parser. Drain
      // without retaining the body so Node's TCP close cannot race the chosen
      // refusal with ECONNRESET. A lost response is covered separately below.
      for await (const _chunk of request) { /* discard */ }
      return reject(response, null, declaredBytes);
    }
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url === '/v1/status') return response.end(JSON.stringify({ ok: true, app: { packageName },
      debugBridge: { runtimeEpoch, h5TargetSchema: targetSchema, h5ExecutionSchema: schema } }));
    const payload = JSON.parse(body);
    requests.push({ path: request.url, body: payload, bytes: Buffer.byteLength(body) });
    if (request.url === '/v1/h5/cancel') return response.end(JSON.stringify({ ok: false, error: 'h5_execution_not_found' }));
    reject(response, payload, Buffer.byteLength(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-sdk-framing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const serial = 'framing-' + randomUUID();
  const target = { serial, packageName, port: server.address().port,
    adb: createAdbHttpFixture({ directory, serial, port: server.address().port }) };
  return { target, requests };
}

const framingRejections = [
  { status: 400, error: 'invalid_http_request', message: 'Duplicate Content-Length is not supported.' },
  { status: 400, error: 'incomplete_http_request', message: 'The connection ended after 2 of 8 body bytes.' },
  { status: 408, error: 'http_request_timeout', message: 'HTTP request framing exceeded the 5000 ms deadline.' },
  { status: 413, error: 'http_request_too_large', message: 'HTTP body exceeds 4194304 bytes.' },
];

for (const rejection of framingRejections) test(`Android SDK HTTP ${rejection.status} ${rejection.error} is a settled refusal without cancellation`, async t => {
  const response = { ok: false, error: rejection.error, message: rejection.message, dispatched: false, ambiguous: false };
  const { target, requests } = await fixture(t, reply => {
    reply.writeHead(rejection.status, { 'Content-Type': 'application/json; charset=utf-8' });
    reply.end(JSON.stringify(response));
  });
  const result = await executeCommand('h5-eval', { ...target, expectedPage: pageRef,
    script: '1 + 1', requestId: 'refused-action' });
  assert.equal(result.error, rejection.error);
  assert.equal(result.message, rejection.message);
  assert.equal(result.dispatched, false);
  assert.equal(result.ambiguous, false);
  assert.notEqual(result.settled, false);
  assert.equal(result.cancellation, undefined);
  assert.equal(result.details.statusCode, rejection.status);
  assert.deepEqual(result.details.response, response);
  assert.equal(typeof result.details.suggestion, 'string');
  assert.ok(result.details.suggestion.length > 0);
  assert.deepEqual(requests.map(request => request.path), ['/v1/h5/action']);
  const ownership = await executeCommand('device-ownership', { serial: target.serial, operation: 'status' });
  assert.equal(ownership.active, 0);
  assert.notEqual(ownership.unresolved, true);
});

const unprovenFailures = [
  { name: 'plain HTTP 413', status: 413, body: 'Request too large' },
  { name: 'unrelated HTTP 400 error', status: 400,
    body: { ok: false, error: 'business_request_failed', message: 'Not a framing refusal.', dispatched: false, ambiguous: false } },
  { name: 'unrelated HTTP 500 refusal', status: 500,
    body: { ok: false, error: 'http_request_too_large', message: 'Proxy failed.', dispatched: false, ambiguous: false } },
  { name: 'mismatched status and error', status: 400,
    body: { ok: false, error: 'http_request_too_large', message: 'Wrong status.', dispatched: false, ambiguous: false } },
  { name: 'missing no-dispatch proof', status: 413,
    body: { ok: false, error: 'http_request_too_large', message: 'No dispatch facts.' } },
  { name: 'ambiguous response', status: 408,
    body: { ok: false, error: 'http_request_timeout', message: 'Unknown dispatch.', dispatched: false, ambiguous: true } },
  { name: 'action response claiming framing refusal', status: 400,
    body: { ok: false, error: 'invalid_http_request', message: 'Not a parser response.', dispatched: false, ambiguous: false,
      execution: { schemaVersion: schema } } },
  { name: 'lost connection', disconnect: true },
];

for (const failure of unprovenFailures) test(`Android SDK ${failure.name} cannot prove an action was not dispatched`, async t => {
  const { target, requests } = await fixture(t, reply => {
    if (failure.disconnect) return reply.destroy();
    reply.writeHead(failure.status);
    reply.end(typeof failure.body === 'string' ? failure.body : JSON.stringify(failure.body));
  });
  const result = await executeCommand('h5-eval', { ...target, expectedPage: pageRef, script: '1 + 1', requestId: 'unknown-action' });
  assert.equal(result.ok, false);
  assert.equal(result.dispatched, null);
  assert.equal(result.ambiguous, true);
  assert.equal(result.settled, false);
  assert.equal(result.executionReceipt, null);
  assert.equal(result.cancellation.error, 'h5_execution_not_found');
  assert.deepEqual(requests.map(request => request.path), ['/v1/h5/action', '/v1/h5/cancel']);
  const ownership = await executeCommand('device-ownership', { serial: target.serial, operation: 'status' });
  assert.equal(ownership.unresolved, true);
});

test('an oversized H5 request is refused and a corrected new action can complete on the same target', async t => {
  const { target, requests } = await fixture(t, (reply, body, bytes) => {
    if (bytes > 4 * 1024 * 1024) {
      reply.writeHead(413);
      return reply.end(JSON.stringify({ ok: false, error: 'http_request_too_large', message: 'HTTP body exceeds 4194304 bytes.',
        dispatched: false, ambiguous: false }));
    }
    reply.end(JSON.stringify({ ok: true, actionId: body.actionId, runtimeEpoch, dispatched: true, ambiguous: false, settled: true,
      execution: { schemaVersion: schema, actionId: body.actionId, runtimeEpoch, settled: true }, result: JSON.stringify({ ok: true }) }));
  }, 4 * 1024 * 1024);
  // Read the provider result directly: the public delivery layer correctly stores
  // the multi-megabyte request as a response reference instead of inlining it.
  const rejected = await executeProviderCommand('h5-eval', { ...target, expectedPage: pageRef,
    script: '/*' + 'x'.repeat(4 * 1024 * 1024) + '*/', requestId: 'oversized-action' });
  assert.equal(rejected.error, 'http_request_too_large');
  assert.equal(rejected.dispatched, false);
  assert.equal(rejected.ambiguous, false);
  const completed = await executeCommand('h5-eval', { ...target, expectedPage: pageRef, script: '1 + 1', requestId: 'corrected-action' });
  assert.equal(completed.ok, true);
  assert.equal(completed.executionReceipt.actionId, 'corrected-action');
  assert.deepEqual(requests.map(request => request.path), ['/v1/h5/action', '/v1/h5/action']);
  assert.ok(requests[0].bytes > 4 * 1024 * 1024);
});
