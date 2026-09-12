'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileBounded } = require('../bin/shared-kernel/execution-io');

test('bounded HTTP transport uses TLS with certificate verification for an explicit https endpoint', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-https-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const config = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  await execFileBounded('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config]);
  let header;
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    header = req.headers['x-aab-runtime-epoch'];
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const source = `require(${JSON.stringify(require.resolve('../bin/shared-kernel/execution-io'))}).httpRequestBounded(
    ${JSON.stringify(`https://127.0.0.1:${server.address().port}`)}, { headers: { 'X-AAB-Runtime-Epoch': 'epoch-tls' } }
  ).then(body => process.stdout.write(body), error => { process.stderr.write(error.code); process.exitCode = 1; });`;
  const result = await execFileBounded(process.execPath, ['-e', source], { encoding: 'utf8', env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } });
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  assert.equal(header, 'epoch-tls');
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  await assert.rejects(execFileBounded(process.execPath, ['-e', source], { encoding: 'utf8', env }), error => {
    assert.match(error.stderr, /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN/);
    return true;
  });
});
