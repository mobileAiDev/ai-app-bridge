'use strict';

const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];

// Written from the real 2026-09-11 native/H5 Intent observations. The fixed ZIM
// and a foreground Greenhouse gas article are explicit preconditions.
module.exports.main = async ctx => {
  const { outputDir, wdaSessionId } = ctx.inputs;
  if (!outputDir || !wdaSessionId) throw new Error('outputDir and an explicit WDA session are required');
  fs.mkdirSync(outputDir, { recursive: false });
  const checks = [], artifacts = [], startedAtMs = Date.now();
  let sequence = 0;
  async function call(command, args = {}, native = false) {
    const read = await ctx.call(command, { ...(native ? { wdaSessionId } : {}), ...args });
    fs.writeFileSync(path.join(outputDir, `${String(++sequence).padStart(3, '0')}-${command}.json`), JSON.stringify(read, null, 2) + '\n', { flag: 'wx' });
    if (!read.ok) throw new Error(`${command}: ${read.error}: ${JSON.stringify(read.result)}`);
    return read;
  }
  async function check(name, condition, read, stream = 'tree') {
    const verdict = await ctx.assert({ name, condition, requiredEvidence: [stream], evidence: read.evidence });
    checks.push(verdict);
    if (verdict.verdict !== 'passed') throw new Error(`${name}: ${verdict.verdict}`);
  }
  async function page(title, article, body) {
    const deadline = Date.now() + 10000;
    let read;
    do {
      read = await call('ios-h5-dom');
      if (read.result.dom.readyState === 'complete' && read.result.dom.title === title) break;
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    const dom = read.result.dom;
    await check(`article ${title}: actual title, local URL and body`, dom.title === title
      && dom.url === `zim://53293C1B-CED3-5244-564A-B40E435E2F0A/${article}`
      && dom.bodyText.includes(body) && dom.readyState === 'complete' && !dom.bodyTextTruncated, read);
    return read;
  }
  async function screenshot(name) {
    const outFile = path.join(outputDir, name + '.png');
    const read = await call('ios-screenshot', { outFile });
    const sha256 = createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    await check(`${name}: actual screenshot bytes`, read.evidence.refs.some(ref => ref.stream === 'screenshot' && ref.sha256 === sha256), read, 'screenshot');
    artifacts.push({ name, path: outFile, sha256, evidence: read.evidence, binding: 'separate capture after nearby DOM; not atomic' });
  }
  const gas = () => page('Greenhouse gas', 'Greenhouse_gas', 'Greenhouse gases (GHGs)');
  const climate = () => page('Climate change', 'Climate_change', 'climate change describes global warming');
  const before = await gas();
  const links = before.result.dom.controls.filter(n => n.tag === 'a' && n.text === 'climate change' && n.visible);
  await check('one current climate link in greenhouse article', links.length === 1, before);
  await call('ios-h5-scroll', { selector: { text: 'climate change', tag: 'a' } });
  const scrolled = await gas();
  const moved = scrolled.result.dom.controls.find(n => n.elementId === links[0].elementId);
  await check('scroll moves the same article link toward the viewport center', !!moved
    && before.result.pageRef.documentId === scrolled.result.pageRef.documentId
    && links[0].bounds.top - moved.bounds.top > 100 && moved.bounds.top > 0, scrolled);
  await screenshot('greenhouse-link-after-scroll');
  await call('ios-h5-click', { selector: { text: 'climate change', tag: 'a' } });
  const opened = await climate();
  await check('H5 navigation has a new document identity', opened.result.pageRef.documentId !== scrolled.result.pageRef.documentId, opened);
  await screenshot('climate-after-h5-link');
  await call('ios-h5-scroll', { selector: { text: 'greenhouse gases', tag: 'a' } });
  await call('ios-h5-click', { selector: { text: 'greenhouse gases', tag: 'a' } });
  await gas();
  const native = await call('ios-uia-tree', {}, true);
  await check('native back navigation is available above the H5 page', flatten(native.result.source)
    .some(n => n.type === 'Button' && n.label === 'Go Back' && n.isVisible === '1' && n.isEnabled === '1'), native);
  await call('ios-tap-native', { selector: { label: 'Go Back', type: 'Button' } }, true);
  await climate();
  await call('ios-tap-native', { selector: { label: 'Go Forward', type: 'Button' } }, true);
  await gas();
  await screenshot('greenhouse-after-native-forward');
  const result = { ok: true, startedAtMs, completedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs,
    checks, artifacts, scope: 'fixed offline articles, actual DOM scrolling and native back/forward; bookmarks and persistence are not covered' };
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
};
