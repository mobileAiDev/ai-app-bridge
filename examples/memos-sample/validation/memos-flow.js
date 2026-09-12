'use strict';

// Auth and business actions use public Bridge calls. The SQLite oracle runs in
// a separate process after this Script; it never supplies UI success signals.
const fs = require('node:fs');
const elementKeys = ['elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel', 'placeholder', 'href', 'text'];

module.exports.main = async function main(ctx) {
  const { marker, content, editedContent, credentialsPath, negativeOnly = false } = ctx.inputs;
  const verdicts = [];
  async function call(command, args = {}) {
    const result = await ctx.call(command, args);
    if (!result.ok || result.ambiguous === true) throw new Error(`${command}:${result.error || 'ambiguous'}`);
    return result;
  }
  const read = selector => call('web-dom', selector ? { selector } : {});
  const controls = observation => observation.result.dom.controls.filter(node => node.visible);
  function one(observation, predicate, label) {
    const nodes = controls(observation).filter(predicate);
    if (nodes.length !== 1) throw new Error(`${label}:expected one observed control, received ${nodes.length}`);
    return nodes[0];
  }
  async function act(observation, node, command, args = {}) {
    return call(command, { selector: { elementId: node.elementId }, expectedTarget: {
      pageRef: observation.result.pageRef,
      element: Object.fromEntries(elementKeys.map(key => [key, node[key]])),
    }, ...args });
  }
  async function check(name, observation, condition) {
    const verdict = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: observation.evidence });
    verdicts.push(verdict);
    if (verdict.verdict !== 'passed') throw new Error(`${name}:${verdict.verdict}:${verdict.reason || ''}`);
  }
  async function until(name, selector, predicate) {
    const deadline = Date.now() + 15000;
    do {
      const observation = await read(selector);
      if (predicate(observation)) { await check(name, observation, true); return observation; }
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error(`${name}:observed state deadline`);
  }
  async function button(text) {
    const observation = await until(`${text} is ready`, undefined, value => {
      const nodes = controls(value).filter(node => node.text === text);
      return nodes.length === 1 && nodes[0].interaction.status === 'ready';
    });
    return act(observation, one(observation, node => node.text === text, text), 'web-click');
  }

  let observation = await read();
  if (new URL(observation.result.dom.url).pathname === '/auth') {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    await act(observation, one(observation, node => node.id === 'signin-username', 'username'), 'web-input', { value: credentials.username });
    observation = await read();
    await act(observation, one(observation, node => node.id === 'signin-password', 'password'), 'web-input', { value: credentials.password });
    await button('登录');
    observation = await until('authenticated home', undefined, value => new URL(value.result.dom.url).pathname === '/');
  }
  if (negativeOnly) {
    await check('wrong memo content must fail', observation, observation.result.dom.bodyText.includes(marker));
    return { verdicts };
  }
  observation = await until('home editor is ready', undefined, value => controls(value).some(node =>
    node.role === 'textbox' && node.editable && node.interaction.status === 'ready'));
  await check('fresh marker is absent before create', observation, !observation.result.dom.bodyText.includes(marker));
  await act(observation, one(observation, node => node.role === 'textbox' && node.editable, 'home editor'), 'web-input', { value: content });
  await button('Save');
  await until('created memo is rendered as an article', 'article', value => controls(value).some(node => node.text.includes(marker)));

  observation = await read();
  await act(observation, one(observation, node => node.tag === 'input' && node.placeholder === 'Search memos...', 'search'), 'web-input', { value: marker });
  observation = await read();
  await act(observation, one(observation, node => node.tag === 'input' && node.placeholder === 'Search memos...', 'search'), 'web-key', { key: 'Enter' });
  await until('search isolates the created memo', 'article', value => controls(value).length === 1 && controls(value)[0].text.includes(marker));

  async function openMenu() {
    const article = await read('article button');
    return act(article, one(article, node => node.tag === 'button', 'memo menu'), 'web-click');
  }
  await openMenu(); await button('Edit');
  observation = await read();
  const editor = one(observation, node => node.role === 'textbox' && node.editable && node.text.includes(marker), 'existing memo editor');
  await check('existing editor contains original content', observation, editor.text.includes(marker) && editor.text.includes('牛奶 2 瓶'));
  await act(observation, editor, 'web-input', { value: editedContent });
  observation = await read();
  await act(observation, one(observation, node => node.tag === 'button' && node.text === 'Save' && !node.disabled,
    'enabled edit Save'), 'web-click');
  await until('edited memo is rendered', 'article', value => controls(value).length === 1 && controls(value)[0].text.includes('Script edit verified'));

  await openMenu(); await button('Delete');
  observation = await read();
  await check('delete requires confirmation', observation,
    controls(observation).some(node => node.text === 'Cancel') && controls(observation).some(node => node.text === 'Delete'));
  await button('Cancel');
  observation = await until('cancelled delete retains the memo', undefined, value =>
    value.result.dom.bodyText.includes(marker) && !controls(value).some(node => node.tag === 'button' && node.text === 'Cancel'));
  await check('final edited business content is visible', observation, observation.result.dom.bodyText.includes('Script edit verified'));
  return { marker, verdicts, assertionCount: verdicts.length };
};
