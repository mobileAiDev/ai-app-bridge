'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizePersistentFact,
  sanitizePersistentValue,
} = require('../bin/fact-codec');

test('nonsecret JSON captured as text retains its exact whitespace, escapes and duplicate-free bytes', () => {
  for (const raw of [
    String.raw`{"resourceName":"sample:id\/next","actionId":"intent:\u8282\u70b9","text":"{\"x\":1}"}`,
    '  { "number": 1.000, "nested": [{"same":1},{"same":2}] }\n',
    '["colon: brace} key\\\"", {"number": 9007199254740993}]',
  ]) {
    assert.equal(sanitizePersistentValue({ receiptJson: raw }).receiptJson, raw);
    assert.equal(sanitizePersistentValue(sanitizePersistentValue({ receiptJson: raw })).receiptJson, raw);
  }
});

test('preserving JSON text never retains a secret hidden by duplicate or escaped keys', () => {
  for (const raw of [
    String.raw`{"tok\u0065n":"hidden-secret","token":"[REDACTED]"}`,
    String.raw`{"nested":{"password":"hidden-secret"},"nested":{}}`,
    String.raw`[{"to\u006ben":"hidden-secret","token":"[REDACTED]"}]`,
  ]) {
    const result = sanitizePersistentValue({ receiptJson: raw });
    assert.doesNotMatch(result.receiptJson, /hidden-secret/);
    assert.doesNotThrow(() => JSON.parse(result.receiptJson));
    assert.deepEqual(sanitizePersistentValue(result), result);
  }
});

test('JSON receipt text still applies nested credential and inline token redaction', () => {
  const raw = String.raw`{"binding":{"text":"password=private-value"},"token":"private-token","safe":"sample:id\/next"}`;
  const result = sanitizePersistentValue({ receiptJson: raw }).receiptJson;
  assert.doesNotMatch(result, /private-value|private-token/);
  assert.equal(JSON.parse(result).safe, 'sample:id/next');
  assert.notEqual(result, raw);
});

test('canonical fact normalization keeps bodies and only redacts password and token', () => {
  const normalized = normalizePersistentFact({
    partition: 'network',
    targetKey: 'android:device:com.example',
    app: { platform: 'android', token: 'app-token-secret' },
    runtimeEpoch: 'runtime-1',
    actionId: 'action-1',
    dedupeKey: 'capture-1',
    timestamps: { occurredAtMs: 100, observedAtMs: 110 },
    payload: {
      url: 'https://url-user:url-password@example.test/tokenpluginfile.php/path-token-secret/orders?token=url-secret&code=otp-secret&signature=sig-secret&view=summary',
      headers: {
        Authorization: 'Bearer header-secret',
        'X-API-Key': 'x-api-key-secret',
        Cookie: 'session=cookie-secret',
        Accept: 'application/json',
      },
      log: 'Cookie: session=cookie-secret',
      json: '{"password":"json-secret","safe":"retained"}',
      requestBody: '{"privateNote":"raw-request-secret"}',
      nested: { response_body: Buffer.from('raw-response-secret') },
    },
  }, 120);

  const encoded = JSON.stringify(normalized);
  assert.doesNotMatch(
    encoded,
    /app-token-secret|url-password|path-token-secret|url-secret|header-secret|json-secret/,
  );
  assert.match(encoded, /url-user/);
  assert.match(encoded, /otp-secret/);
  assert.match(encoded, /sig-secret/);
  assert.match(encoded, /x-api-key-secret/);
  assert.match(encoded, /cookie-secret/);
  assert.match(encoded, /raw-request-secret/);
  assert.match(normalized.payload.url, /tokenpluginfile\.php\/(?:\[|%5B)REDACTED(?:\]|%5D)/i);
  assert.equal(normalized.app.token, '[REDACTED]');
  assert.match(normalized.payload.url, /token=%5BREDACTED%5D/);
  assert.match(normalized.payload.url, /code=otp-secret/);
  assert.match(normalized.payload.url, /signature=sig-secret/);
  assert.match(normalized.payload.url, /view=summary/);
  assert.equal(normalized.payload.headers.Authorization, '[REDACTED]');
  assert.equal(normalized.payload.headers['X-API-Key'], 'x-api-key-secret');
  assert.equal(normalized.payload.headers.Cookie, 'session=cookie-secret');
  assert.equal(normalized.payload.headers.Accept, 'application/json');
  assert.equal(JSON.parse(normalized.payload.json).safe, 'retained');
  assert.equal(normalized.payload.requestBody, '{"privateNote":"raw-request-secret"}');
  assert.equal(normalized.payload.nested.response_body.type, 'buffer');
  assert.equal(normalized.payload.nested.response_body.byteLength, 19);
  assert.equal(normalized.timestamps.ingestedAtMs, 120);
  assert.match(normalized.dedupeKey, /^[A-Za-z0-9_-]{43}$/);
});

test('canonical URL projection keeps non-token path markers and redacts JWT tokens', () => {
  const projected = sanitizePersistentValue({
    url: '/auth/code/path-code-secret/continue?view=summary',
    redirectUri: '/callback/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature-secret/done',
  });

  assert.equal(projected.url, '/auth/code/path-code-secret/continue?view=summary');
  assert.match(projected.redirectUri, /\/callback\/\[REDACTED\]\/done/);
  assert.doesNotMatch(projected.redirectUri, /eyJhbGci|eyJzdWI|signature-secret/);
});

test('canonical projection converts buffers to metadata and rejects cycles', () => {
  assert.deepEqual(sanitizePersistentValue({ body: Buffer.from('private bytes') }), {
    body: { type: 'buffer', byteLength: 13 },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => sanitizePersistentValue(cyclic), /without cycles/);
});

test('canonical projection redacts only password field values in UiAutomator XML', () => {
  const source = [
    "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>",
    '<hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">',
    '<android.widget.FrameLayout class="android.widget.FrameLayout" package="org.example" bounds="[0,0][1080,2400]">',
    '<android.widget.EditText class="android.widget.EditText" resource-id="org.example:id/password" text="real-password-secret" content-desc="private password" password="true" clickable="true" bounds="[40,300][1000,440]" />',
    '</android.widget.FrameLayout>',
    '</hierarchy>',
  ].join('');

  const projected = sanitizePersistentValue({ value: source });

  assert.doesNotMatch(projected.value, /real-password-secret/);
  assert.match(projected.value, /text="\[REDACTED\]"/);
  assert.match(projected.value, /content-desc="private password"/);
  assert.match(projected.value, /password="true"/);
});
