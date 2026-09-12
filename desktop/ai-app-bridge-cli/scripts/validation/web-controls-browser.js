'use strict';

// Real browser contract checks. Pass an installed browser and Playwright module
// explicitly; this runner neither installs software nor changes a user profile.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const outputDir = path.resolve(process.argv[2]);
fs.mkdirSync(outputDir, { recursive: false });
process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(outputDir, 'facts');
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = path.join(outputDir, 'ownership');
const { chromium } = require(process.env.AAB_PLAYWRIGHT_MODULE);
const { WebBridgeProvider } = require('../../bin/web-provider');
const { closeHostFactStore } = require('../../bin/shared-kernel/host-fact-store');
const { validateCommandArguments, isMutationCommand } = require('../../bin/command-registry');
const { runExecution } = require('../../bin/shared-kernel/execution-scope');
const { selectWebNode } = require('../../bin/shared-kernel/web-dom-target');

const html = `<!doctype html><html><body>
<button id="save" onclick="window.clicks++">Save</button><input id="text" value="original">
<div id="editor" contenteditable="true" role="textbox" style="width:300px;height:60px;border:1px solid">Draft</div>
<button id="low" style="position:absolute;top:2000px" onclick="window.clicks++">Below</button>
<script>window.clicks=0;window.inputs=[];window.keys=[];
document.querySelector('#text').addEventListener('input',e=>window.inputs.push(e.target.value));
document.querySelector('#text').addEventListener('keydown',e=>{window.keys.push(e.key);if(e.key==='Enter'){e.preventDefault();history.pushState({},'', '/searched');}});
</script></body></html>`;

const provider = new WebBridgeProvider();
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
let browser;
const checks = [];
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = await provider.run('web-session-start', { webPort: 0 });
  assert.equal(started.ok, true);
  browser = await chromium.launch({ executablePath: process.env.AAB_CHROMIUM_EXECUTABLE, headless: true });
  async function check(name, action) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const sessionId = `web-contract-${checks.length + 1}`;
    await context.addInitScript({ path: path.resolve(__dirname, '../../../../web/ai-app-bridge-web/src/index.js') });
    await context.addInitScript(config => document.addEventListener('DOMContentLoaded', () => {
      window.bridge = window.AiAppBridgeWeb.createAiAppBridge(config).start();
    }), { endpoint: started.endpoint, token: started.token, sessionId, appName: 'Web contract fixture' });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.bridge?.isConnected());
      const { runtimeEpoch, targetId } = provider.listSessions().sessions.find(s => s.sessionId === sessionId);
      const target = { sessionId, runtimeEpoch, targetId };
      const call = (command, args = {}) => runExecution({ timeoutMs: 5000, mutation: isMutationCommand(command, args) },
        () => provider.run(command, validateCommandArguments(command, { ...target, ...args })));
      const snapshot = await call('web-dom'); assert.equal(snapshot.ok, true, snapshot.error);
      const observed = id => {
        const node = snapshot.dom.controls.find(n => n.id === id); assert.ok(node, id);
        const selected = selectWebNode(snapshot, { elementId: node.elementId }); assert.equal(selected.ok, true);
        return { selector: { elementId: node.elementId }, expectedTarget: selected.targetRef };
      };
      await action({ page, call, snapshot, observed, target });
      checks.push({ name, passed: true });
      console.log(JSON.stringify(checks.at(-1)));
    } finally { await context.close(); }
  }

  await check('native value setter dispatches actual browser input', async ({ page, call, observed }) => {
    await page.evaluate(() => Object.defineProperty(document.querySelector('#text'), 'value', {
      get() { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(this); },
      set() { throw new Error('Framework-owned setter must not be called'); }, configurable: true,
    }));
    const result = await call('web-input', { ...observed('text'), value: 'Edited 中文' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(await page.evaluate(() => window.inputs), ['Edited 中文']);
    assert.equal(await page.locator('#text').inputValue(), 'Edited 中文');
  });
  await check('contenteditable browser insertion reaches the editor', async ({ page, call, observed }) => {
    const result = await call('web-input', { ...observed('editor'), value: 'New 中文 content' });
    assert.equal(result.ok, true, result.error);
    assert.equal(await page.locator('#editor').innerText(), 'New 中文 content');
  });
  await check('duplicate visible text does not dispatch', async ({ page, call }) => {
    await page.evaluate(() => document.body.append(document.querySelector('#save').cloneNode(true)));
    const result = await call('web-click', { selector: { text: 'Save', tag: 'button' } });
    assert.equal(result.error, 'web_element_ambiguous'); assert.equal(result.dispatched, false);
    assert.equal(await page.evaluate(() => window.clicks), 0);
  });
  await check('replacement with the same selector rejects old identity', async ({ page, call, observed }) => {
    const original = observed('save');
    await page.evaluate(() => { const button = document.querySelector('#save'); button.replaceWith(button.cloneNode(true)); });
    const result = await call('web-click', { ...original, selector: { css: '#save' } });
    assert.equal(result.error, 'reobserve_required'); assert.equal(result.dispatched, false);
    assert.equal(await page.evaluate(() => window.clicks), 0);
  });
  await check('returning to the same URL rejects an old page observation', async ({ page, call, observed }) => {
    const original = observed('save');
    await page.evaluate(() => { history.pushState({}, '', '/elsewhere'); history.replaceState({}, '', '/'); });
    const result = await call('web-click', original);
    assert.equal(result.error, 'reobserve_required'); assert.equal(result.dispatched, false);
    assert.equal(await page.evaluate(() => window.clicks), 0);
  });
  await check('focus replacement cannot write to the new input', async ({ page, call, observed }) => {
    await page.evaluate(() => document.querySelector('#text').addEventListener('focus', event => {
      event.target.replaceWith(event.target.cloneNode(true));
    }, { once: true }));
    const result = await call('web-input', { ...observed('text'), value: 'Must not write' });
    assert.equal(result.error, 'web_element_changed');
    assert.equal(await page.locator('#text').inputValue(), 'original');
    assert.deepEqual(await page.evaluate(() => window.inputs), []);
  });
  await check('an overlay prevents clicking the covered target', async ({ page, call, observed }) => {
    await page.evaluate(() => { const cover = document.createElement('div'); cover.style = 'position:fixed;inset:0;z-index:100;background:white'; document.body.append(cover); });
    const result = await call('web-click', observed('save'));
    assert.equal(result.error, 'web_element_obscured'); assert.equal(result.dispatched, false);
    assert.equal(await page.evaluate(() => window.clicks), 0);
  });
  await check('explicit scrolling makes the observed off-screen target reachable', async ({ page, call, observed }) => {
    const outside = await call('web-click', observed('low'));
    assert.equal(outside.error, 'web_element_outside_viewport'); assert.equal(outside.dispatched, false);
    assert.equal((await call('web-scroll', { ...observed('low'), mode: 'into-view' })).ok, true);
    assert.equal((await call('web-click', observed('low'))).ok, true);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
  await check('Enter delivers one keydown even when the handler navigates', async ({ page, call, observed }) => {
    const result = await call('web-key', { ...observed('text'), key: 'Enter' });
    assert.equal(result.ok, true, result.error); assert.equal(result.trusted, false);
    assert.equal(result.defaultPrevented, true);
    assert.deepEqual(await page.evaluate(() => window.keys), ['Enter']);
    assert.equal(new URL(page.url()).pathname, '/searched');
  });
}

main().then(() => fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ ok: true, checks }, null, 2)))
  .catch(error => { fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2)); console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); await provider.close(); await new Promise(resolve => server.close(resolve)); closeHostFactStore(); });
