'use strict';

const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const lesson = 'zim://B237D3C6-4CE9-B57F-411A-3CCB8CC24367/index.html#/javascript-algorithms-and-data-structures/basic-javascript/cf1111c1c11feddfaeb3bdef';
const elementKeys = ['elementId', 'tag', 'id', 'name', 'type', 'text', 'ariaLabel', 'href'];

// Derived from intent-1789183125690-2. Start on the existing lesson with no dialog
// and the separately recorded reader-height fixture applied. Only ordinary
// bound H5 controls perform editing and submission. The controller reads grading.
module.exports.main = async ctx => {
  const { outputDir } = ctx.inputs;
  fs.mkdirSync(outputDir, { recursive: false });
  let sequence = 0;
  const checks = [], artifacts = [], externalOracles = [];
  async function call(command, args = {}) {
    const read = await ctx.call(command, { ...args, feedback: 'off' });
    fs.writeFileSync(path.join(outputDir, `${String(++sequence).padStart(2, '0')}-${command}.json`), JSON.stringify(read, null, 2), { flag: 'wx' });
    if (!read.ok) throw new Error(`${command}: ${JSON.stringify(read.result)}`);
    return read;
  }
  async function check(name, condition, read) {
    const result = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: read.evidence });
    checks.push(result);
    if (result.verdict !== 'passed') throw new Error(`${name}: ${result.verdict}`);
  }
  async function observe() {
    const read = await call('ios-h5-dom');
    if (read.result.dom.url !== lesson || read.result.dom.truncated) throw new Error('Expected a complete observation of the exact lesson');
    return read;
  }
  function select(read, predicate) {
    const matches = read.result.dom.controls.filter(predicate);
    if (matches.length !== 1 || matches[0].interaction.status !== 'ready' || matches[0].disabled) {
      throw new Error('Expected one ready course control');
    }
    const node = matches[0];
    return { selector: { elementId: node.elementId }, webViewId: read.result.pageRef.webViewId,
      expectedTarget: { pageRef: read.result.pageRef, element: Object.fromEntries(elementKeys.map(k => [k, node[k]])) } };
  }
  async function tap(text) {
    const read = await observe();
    return call('ios-h5-click', select(read, node => node.tag === 'button' && node.text === text));
  }
  async function screenshot(name) {
    const file = path.join(outputDir, name + '.png');
    await call('ios-screenshot', { outFile: file });
    artifacts.push({ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  }
  for (const phase of ['wrong', 'correct']) {
    await ctx.progress({ stage: phase });
    await tap('Code');
    const expression = phase === 'wrong' ? '9 + 10' : '12 + 8';
    const marker = `script-${phase}-20260912`;
    const solution = `const sum = ${expression};\nconsole.log('${marker}', sum);`;
    let read = await observe();
    await call('ios-h5-input', { ...select(read, node => node.editable === true), text: solution });
    read = await observe();
    await check(`${phase}: exact multiline editor input`, read.result.dom.controls.filter(n => n.editable).length === 1
      && read.result.dom.controls.find(n => n.editable).text === solution, read);
    const submitted = await tap('Run');
    read = await observe();
    const complete = read.result.dom.controls.filter(n => n.tag === 'button' && n.text === 'Go to next challenge' && n.interaction.status === 'ready');
    await check(`${phase}: completion dialog matches grading`, phase === 'correct' ? complete.length === 1 : complete.length === 0, read);
    if (phase === 'wrong') {
      await tap('Console');
      read = await observe();
      await check('wrong: actual console output is 19', read.result.dom.bodyText.includes(` > ${marker} `)
        && read.result.dom.bodyText.includes(' > 19 '), read);
    }
    await screenshot(phase === 'correct' ? 'correct-completion' : 'wrong-console');
    const reply = await ctx.askAgent({ question: `Read the original course grader for ${phase} without executing it.`,
      options: [{ id: 'recorded', label: 'Grader evidence recorded' }], context: { kind: 'kiwix.course-oracle/v1',
        phase, runActionId: submitted.result.actionId, pageRef: read.result.pageRef } });
    if (reply?.kind !== 'kiwix.course-oracle-result/v1' || reply.phase !== phase || reply.verdict !== 'passed'
      || typeof reply.artifact?.path !== 'string' || !/^[a-f0-9]{64}$/.test(reply.artifact.sha256)) {
      throw new Error('Independent course grading did not pass');
    }
    externalOracles.push(reply);
    if (phase === 'correct') {
      await tap('Close×');
      await tap('Console');
      read = await observe();
      await check('correct: actual console output is 20', read.result.dom.bodyText.includes(` > ${marker} `)
        && read.result.dom.bodyText.includes(' > 20 '), read);
      await screenshot('correct-console');
    }
  }
  return { ok: true, businessVerdict: 'passed', checks, artifacts, externalOracles,
    scope: 'Wrong and correct exercise submissions in the original grader with a declared reader-height fixture; no durable progress claim.' };
};
