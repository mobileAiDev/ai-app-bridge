'use strict';

const fs = require('node:fs'), path = require('node:path');
const { createHmac, createHash } = require('node:crypto');

// RFC 4226 Appendix D, public synthetic fixture. No App crypto or Keychain reads.
function hotp(counter) {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from('12345678901234567890')).update(bytes).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function flatten(node, output = []) {
  if (!node) return output;
  output.push(node);
  for (const child of node.children || []) flatten(child, output);
  return output;
}
const visible = node => node.isVisible === '1';
const has = (read, label, type) => flatten(read.result.source).some(n => visible(n) && n.label === label && (!type || n.type === type));
const field = (read, id) => flatten(read.result.source).find(n => visible(n) && n.rawIdentifier === id);

module.exports.main = async ctx => {
  const { outputDir, issuer, description, wdaSessionId } = ctx.inputs;
  if (!outputDir || !issuer || !description || !wdaSessionId) throw new Error('Explicit outputDir, issuer, description and WDA session required');
  fs.mkdirSync(outputDir, { recursive: false });
  let sessionId = wdaSessionId, sequence = 0;
  const checks = [], artifacts = [];
  const startedAtMs = Date.now();
  async function call(command, args = {}, sessionBound = true) {
    const result = await ctx.call(command, { ...(sessionBound ? { wdaSessionId: sessionId } : {}), ...args });
    const filename = `${String(++sequence).padStart(3, '0')}-${command}.json`;
    fs.writeFileSync(path.join(outputDir, filename), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    if (!result.ok) throw new Error(`${command}: ${result.error}: ${JSON.stringify(result.result)}`);
    return result;
  }
  async function check(name, condition, read, stream = 'tree') {
    const verdict = await ctx.assert({ name, condition, requiredEvidence: [stream], evidence: read.evidence });
    checks.push(verdict);
    if (verdict.verdict !== 'passed') throw new Error(`${name}: ${verdict.verdict} ${verdict.reason || ''}`);
  }
  const tree = () => call('ios-uia-tree');
  const tap = selector => call('ios-tap-native', { selector });
  const input = (selector, text) => call('ios-input-native-text', { selector, text });
  async function screenshot(name) {
    const outFile = path.join(outputDir, name + '.png');
    const read = await call('ios-screenshot', { outFile }, false);
    const sha256 = createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    await check(`${name}: captured screenshot bytes`, read.evidence.refs.some(ref => ref.stream === 'screenshot' && ref.sha256 === sha256), read, 'screenshot');
    artifacts.push({ name, path: outFile, sha256, evidence: read.evidence, binding: 'separate capture after nearby tree; not atomic' });
  }
  let read = await tree();
  await check('FreeOTP home and no duplicate fixture issuer', !!field(read, 'manualAddButton') && !has(read, issuer), read);
  await tap({ accessibilityId: 'manualAddButton' });
  await tap({ accessibilityId: 'nextButton' });
  read = await tree();
  await check('empty form is rejected', has(read, 'Some fields are empty!', 'Alert'), read);
  await screenshot('empty-form-error');
  await tap({ label: 'OK', type: 'Button' });
  for (const [id, value] of [['issuerField', issuer], ['descriptionField', description], ['secretField', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ']]) {
    await input({ accessibilityId: id }, value);
    read = await tree();
    await check(`${id}: actual editor value`, field(read, id)?.value === value, read);
  }
  await tap({ label: 'HOTP', type: 'Button' });
  await tap({ accessibilityId: 'algorithmControl' });
  await tap({ label: 'SHA1', type: 'Button' });
  read = await tree();
  await check('HOTP, six digits and SHA1 selected', field(read, 'algorithmControl')?.label === 'SHA1'
    && flatten(read.result.source).some(n => visible(n) && n.type === 'Button' && n.label === 'HOTP' && n.value === '1')
    && flatten(read.result.source).some(n => visible(n) && n.type === 'Button' && n.label === '6' && n.value === '1'), read);
  await screenshot('configured-token');
  await tap({ accessibilityId: 'nextButton' });
  await input({ label: 'Search Icons', type: 'SearchField' }, 'freebsd');
  read = await tree();
  // The real icon grid has no text or accessibility IDs on its cells. Bind the
  // unique filtered Cell from this fresh tree; do not retain coordinates/UIDs.
  const cells = flatten(read.result.source).filter(n => visible(n) && n.type === 'Cell');
  await check('icon search returns one current result', cells.length === 1
    && flatten(read.result.source).some(n => n.type === 'SearchField' && n.value === 'freebsd'), read);
  await screenshot('filtered-icon');
  await tap({ elementId: cells[0].elementId, type: 'Cell' });
  await tap({ label: 'Next', type: 'Button' });
  read = await tree();
  const switches = flatten(read.result.source).filter(n => visible(n) && n.type === 'Switch');
  await check('test token does not require device authentication', switches.length === 1 && switches[0].value === '0', read);
  await tap({ label: 'Next', type: 'Button' });
  read = await tree();
  await check('saved issuer and description are present', has(read, issuer, 'StaticText') && has(read, description, 'StaticText'), read);
  await tap({ label: issuer, type: 'StaticText' });
  read = await tree();
  await check('HOTP counter zero matches independent RFC oracle', hotp(0) === '755224' && has(read, hotp(0), 'StaticText'), read);
  await screenshot('hotp-counter-0');
  const previousProcessId = read.result.session.processId;
  await call('ios-wda-session', { operation: 'close' });
  await call('ios-launch-app', { terminateExisting: true }, false);
  const created = await call('ios-wda-session', { operation: 'create' }, false);
  sessionId = created.result.session.sessionId;
  read = await tree();
  await check('record survives a real App process restart', read.result.session.processId !== previousProcessId
    && has(read, issuer, 'StaticText') && has(read, description, 'StaticText'), read);
  await tap({ label: issuer, type: 'StaticText' });
  read = await tree();
  await check('persisted HOTP counter advances to one', hotp(1) === '287082' && has(read, hotp(1), 'StaticText'), read);
  await screenshot('hotp-counter-1-after-restart');
  const result = { ok: true, startedAtMs, completedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs,
    issuer, description, sessionId, checks, artifacts, oracle: { source: 'https://www.rfc-editor.org/rfc/rfc4226.html#appendix-D',
      implementation: 'Node crypto HMAC-SHA1, separate from FreeOTP implementation', counters: [0, 1], expected: [hotp(0), hotp(1)] } };
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
};
