'use strict';
const fs = require('node:fs'), path = require('node:path');
module.exports.main = async ctx => {
  fs.mkdirSync(ctx.inputs.outputDir, { recursive: false });
  const read = await ctx.call('ios-h5-dom');
  fs.writeFileSync(path.join(ctx.inputs.outputDir, 'actual-article.json'), JSON.stringify(read, null, 2) + '\n', { flag: 'wx' });
  if (!read.ok) throw new Error(`${read.error}`);
  const actual = await ctx.assert({ name: 'actual greenhouse article is present',
    condition: read.result.dom.title === 'Greenhouse gas' && read.result.dom.bodyText.includes('Greenhouse gases (GHGs)'),
    requiredEvidence: ['tree'], evidence: read.evidence });
  if (actual.verdict !== 'passed') throw new Error(`baseline: ${actual.verdict}`);
  const wrong = await ctx.assert({ name: 'deliberately incorrect H5 article expectation',
    condition: read.result.dom.title === 'Paris Agreement', requiredEvidence: ['tree'], evidence: read.evidence });
  if (wrong.verdict !== 'passed') throw new Error(`deliberately incorrect H5 article expectation: ${wrong.verdict}`);
  throw new Error('Wrong-article test did not detect the incorrect expectation');
};
