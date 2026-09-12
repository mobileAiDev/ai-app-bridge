'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createHmac } = require('node:crypto');
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];
module.exports.main = async ctx => {
  const { outputDir, wdaSessionId, issuer, expectedCode, counter } = ctx.inputs;
  fs.mkdirSync(outputDir);
  let sequence = 0;
  async function call(command, args = {}) {
    const result = await ctx.call(command, { wdaSessionId, ...args });
    fs.writeFileSync(path.join(outputDir, `${++sequence}-${command}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
    if (!result.ok) throw new Error(`${command}: ${result.error}`);
    return result;
  }
  // FreeOTP hides the issuer while showing a code for 30 seconds. Wait only by
  // observing; never repeat the HOTP-generating action to recover a timeout.
  const deadline = Date.now() + 45000;
  let read;
  while (true) {
    read = await call('ios-uia-tree');
    if (flatten(read.result.source).some(n => n.isVisible === '1' && n.type === 'StaticText' && n.label === issuer)) break;
    if (Date.now() > deadline) throw new Error('issuer did not become visible');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await call('ios-tap-native', { selector: { label: issuer, type: 'StaticText' } });
  read = await call('ios-uia-tree');
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from('12345678901234567890')).update(bytes).digest();
  const correctCode = String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
  const labels = flatten(read.result.source).filter(n => n.isVisible === '1' && n.type === 'StaticText').map(n => n.label);
  const actual = await ctx.assert({ name: 'fresh HOTP counter matches independent oracle',
    condition: labels.includes(correctCode), requiredEvidence: ['tree'], evidence: read.evidence });
  if (actual.verdict !== 'passed') throw new Error(`counter ${counter}: ${actual.verdict}`);
  const wrong = await ctx.assert({ name: 'deliberately incorrect HOTP expectation',
    condition: labels.includes(expectedCode), requiredEvidence: ['tree'], evidence: read.evidence });
  fs.writeFileSync(path.join(outputDir, 'wrong-code.json'), JSON.stringify({ counter, correctCode, expectedCode, labels, actual, wrong }, null, 2), { flag: 'wx' });
  if (wrong.verdict !== 'passed') throw new Error(`deliberately incorrect HOTP expectation: ${wrong.verdict}`);
  throw new Error('Wrong-code test did not detect the incorrect expectation');
};
