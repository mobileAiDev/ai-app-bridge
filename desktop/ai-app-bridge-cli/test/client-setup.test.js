'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setup } = require('../setup/install');
const { updateMcp, updateInstructions, parseConfig } = require('../setup/config');
const { parse } = require('../setup/cli');
const root = path.resolve(__dirname, '..');
const launch = { command: 'C:\\Program Files\\node.exe', args: ['C:\\Bridge Files\\mcp-server.js'] };

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-client-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env: { PATH: '' }, packageRoot: root };
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

test('JSONC editing retains other servers, user environment, comments and disabled choices', () => {
  const input = '{\n // user comment\n "theme":"dark", "mcpServers":{"other":{"command":"keep"},"ai-app-bridge":{"command":"old","env":{"ADB":"special"},"timeout":90}},\n}';
  const updated = updateMcp(input, 'json', launch);
  assert.match(updated, /\/\/ user comment/);
  const result = parseConfig(updated, 'json');
  assert.equal(result.theme, 'dark'); assert.deepEqual(result.mcpServers.other, { command: 'keep' });
  assert.deepEqual(result.mcpServers['ai-app-bridge'], { ...launch, env: { ADB: 'special' }, timeout: 90 });
  assert.equal(updateMcp(updated, 'json', launch), updated);
  assert.throws(() => updateMcp('{"mcpServers":{"ai-app-bridge":{"disabled":true}}}', 'json', launch), /disabled/);
  assert.throws(() => updateMcp('{"mcpServers":{"ai-app-bridge":{"url":"https://example.test"}}}', 'json', launch), /different transport/);
});

for (const [name, input] of Object.entries({
  fresh: '',
  standard: '# keep\r\nmodel = "example"\r\n[mcp_servers."ai-app-bridge"]\r\ncommand = "old" # command note\r\nargs = [\r\n "one",\r\n "two"\r\n]\r\n[mcp_servers."ai-app-bridge".env]\r\nADB = "special"\r\n',
  parent: '[mcp_servers]\nother = {command="keep"}\n',
  inline: 'mcp_servers = { other = { command="keep" }, "ai-app-bridge" = { command="old", env={ADB="special"} } }\n',
  dotted: 'mcp_servers.ai-app-bridge.command = "old"\nmcp_servers.other.command = "keep"\n',
  childFirst: '[mcp_servers.ai-app-bridge.env]\nADB="special"\n',
})) test(`TOML ${name}: changes only the local launch, retaining valid settings`, () => {
  const original = parseConfig(input, 'toml');
  const updated = updateMcp(input, 'toml', launch);
  const data = parseConfig(updated, 'toml');
  assert.deepEqual(data, { ...original, mcp_servers: { ...original.mcp_servers,
    'ai-app-bridge': { ...original.mcp_servers?.['ai-app-bridge'], ...launch } } });
  assert.equal(updateMcp(updated, 'toml', launch), updated);
  if (name === 'standard') { assert.match(updated, /# command note/); assert.match(updated, /# keep\r\n/); }
});

test('five clients receive all skill references; second apply and check make no changes', t => {
  const context = fixture(t);
  write(path.join(context.home, '.qoder/settings.json'), '{"model":"retain","mcpServers":{"other":{"command":"other"}}}');
  write(path.join(context.home, '.codex/skills/ai-app-bridge-use/SKILL.md'), 'legacy');
  const report = setup({ all: true }, context);
  assert.equal(report.clients.length, 5); assert.equal(report.ok, true);
  for (const client of report.clients) {
    assert.equal(client.session.status, 'not_verified');
    for (const skill of client.skills) {
      for (const file of ['SKILL.md', 'agents/openai.yaml', 'references/workflow-lifecycle.md', 'references/runtime-and-targets.md', 'references/results-and-evidence.md']) {
        assert.deepEqual(fs.readFileSync(path.join(skill.path, file)), fs.readFileSync(path.join(root, 'skills/ai-app-bridge-use', file)));
      }
    }
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(context.home, '.qoder/settings.json'))).model, 'retain');
  assert.equal(setup({ all: true }, context).changedFiles.length, 0);
  assert.equal(setup({ all: true, check: true }, context).ok, true);
});

test('automatic detection touches installed clients only; plans and checks are read-only', t => {
  const context = fixture(t); fs.mkdirSync(path.join(context.home, '.qoder'));
  const plan = setup({ dryRun: true }, context);
  assert.deepEqual(plan.clients.map(c => c.client), ['qoder']);
  assert.equal(fs.readdirSync(path.join(context.home, '.qoder')).length, 0);
  assert.equal(setup({ check: true }, context).ok, false);
  assert.deepEqual(fs.readdirSync(context.home), ['.qoder']);
  setup({}, context);
  assert.deepEqual(fs.readdirSync(context.home), ['.qoder']);
});

test('a malformed configuration aborts the entire plan before any files are written', t => {
  const context = fixture(t);
  write(path.join(context.home, '.qoder/settings.json'), '{broken');
  assert.throws(() => setup({ all: true }, context), /valid JSON/);
  assert.deepEqual(fs.readdirSync(context.home), ['.qoder']);
  assert.deepEqual(fs.readdirSync(path.join(context.home, '.qoder')), ['settings.json']);
});

test('upgrade restores missing references and replaces an old linked skill without editing its target', t => {
  const context = fixture(t); const outside = path.join(context.home, 'old-package');
  write(path.join(outside, 'SKILL.md'), 'old external skill');
  const destination = path.join(context.home, '.claude/skills/ai-app-bridge-use');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
  setup({ clients: ['claude'] }, context);
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'old external skill');
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
  fs.unlinkSync(path.join(destination, 'references/runtime-and-targets.md'));
  assert.equal(setup({ clients: ['claude'], check: true }, context).ok, false);
  setup({ clients: ['claude'] }, context);
  assert.equal(setup({ clients: ['claude'], check: true }, context).ok, true);
});

test('package-linked skills do not modify installed package contents', t => {
  const context = fixture(t); const destination = path.join(context.home, '.claude/skills/ai-app-bridge-use');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(path.join(root, 'skills/ai-app-bridge-use'), destination, process.platform === 'win32' ? 'junction' : 'dir');
  const report = setup({ clients: ['claude'] }, context);
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  assert.equal(report.changedFiles.some(x => x.kind === 'skill'), false);
  assert.equal(fs.existsSync(path.join(root, 'skills/ai-app-bridge-use/.ai-app-bridge-install.json')), false);
});

test('an identical skill in another package is detached without writing metadata through its link', t => {
  const context = fixture(t), outside = path.join(context.home, 'old-package');
  fs.cpSync(path.join(root, 'skills/ai-app-bridge-use'), outside, { recursive: true });
  const destination = path.join(context.home, '.claude/skills/ai-app-bridge-use');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
  setup({ clients: ['claude'] }, context);
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(outside, '.ai-app-bridge-install.json')), false);
  assert.equal(fs.existsSync(path.join(destination, '.ai-app-bridge-install.json')), true);
  assert.equal(setup({ clients: ['claude'], check: true }, context).ok, true);
});

test('managed instructions preserve surrounding user text and reject damaged markers', () => {
  const original = 'Existing user rules.\n';
  const first = updateInstructions(original, 'New guidance');
  assert.ok(first.startsWith(original));
  const second = updateInstructions(first + 'More user rules.\n', 'Updated guidance');
  assert.match(second, /Updated guidance/); assert.doesNotMatch(second, /New guidance/);
  assert.ok(second.endsWith('More user rules.\n'));
  assert.equal(updateInstructions(second, 'Updated guidance'), second);
  assert.throws(() => updateInstructions('<!-- ai-app-bridge:begin -->', 'x'), /markers/);
});

test('custom client and explicit project configuration work outside known client directories', t => {
  const context = fixture(t); const project = path.join(context.home, 'project');
  fs.mkdirSync(project); write(path.join(project, 'AGENTS.md'), 'Keep project policy.\n');
  const options = { mcpConfig: path.join(context.home, 'other/mcp.json'), skillsDir: path.join(context.home, 'other/skills'), project };
  const report = setup(options, context);
  assert.deepEqual(report.clients.map(x => x.client), ['custom']);
  assert.ok(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8').startsWith('Keep project policy.\n'));
  assert.equal(setup({ ...options, check: true }, context).ok, true);
  assert.throws(() => setup({ mcpConfig: options.mcpConfig }, context), /requires both/);
});

test('global npm lifecycle enrolls detected clients; dependency, npx and opt-out installs do not', () => {
  const code = fs.readFileSync(path.join(root, 'setup/postinstall.js'), 'utf8');
  for (const [env, expected] of [[{}, 0], [{ npm_config_global: 'false' }, 0], [{ npm_config_global: 'true' }, 1], [{ npm_config_global: 'true', AI_APP_BRIDGE_SKIP_SETUP: '1' }, 0]]) {
    let calls = 0;
    vm.runInNewContext(code, { process: { env }, require(name) { assert.equal(name, './cli'); return { main() { calls++; } }; } });
    assert.equal(calls, expected);
  }
});

test('export is read-only and pins the selected package version; CLI rejects ambiguous inputs', t => {
  const context = fixture(t); const report = setup({ export: true }, { ...context, version: '9.8.7' });
  assert.ok(report.mcp.mcpServers['ai-app-bridge'].args.includes('@mobileaidev/ai-app-bridge@9.8.7'));
  assert.deepEqual(fs.readdirSync(context.home), []);
  assert.throws(() => parse(['--client']), /requires a value/);
  assert.throws(() => parse(['--check', '--dry-run']), /Choose one/);
  assert.throws(() => parse(['--unknown']), /Unknown/);
  assert.throws(() => setup({ clients: ['unknown'] }, context), /Unknown client/);
});
