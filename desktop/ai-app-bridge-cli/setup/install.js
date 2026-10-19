'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { clients, detected } = require('./clients');
const { updateMcp, updateInstructions } = require('./config');

const packageRoot = path.resolve(__dirname, '..');
const packageInfo = require('../package.json');
const skillName = 'ai-app-bridge-use';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);

function skillFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name), file = path.join(directory, entry.name);
    if (entry.isDirectory()) return skillFiles(file, relative);
    if (!entry.isFile()) throw new Error('The packaged skill must contain only ordinary files and directories.');
    return [{ relative, bytes: fs.readFileSync(file) }];
  });
}

function setup(options = {}, context = {}) {
  const home = context.home || os.homedir(), env = context.env || process.env;
  const root = context.packageRoot || packageRoot, version = context.version || packageInfo.version;
  const guidance = fs.readFileSync(path.join(root, 'setup/agent-guidance.md'), 'utf8').trim();
  const launch = { command: context.node || process.execPath, args: [path.join(root, 'bin/mcp-server.js')] };
  if (options.export) return { ok: true, version, mcp: { mcpServers: { 'ai-app-bridge': {
    command: 'npx', args: ['--yes', '--package', `${packageInfo.name}@${version}`, 'ai-app-bridge-mcp'],
  } } }, skillSource: path.join(root, 'skills', skillName), instructions: guidance };
  if (root.split(path.sep).includes('_npx') && !options.check && !options.dryRun) {
    throw new Error('Install the package in a persistent location before setup (npm install -g @mobileaidev/ai-app-bridge). Use --export for a pinned npx MCP configuration.');
  }
  if (options.project && !fs.statSync(options.project).isDirectory()) throw new Error('--project must be an existing directory.');
  const available = clients(home, env);
  if (options.mcpConfig || options.skillsDir || options.instructionsFile) {
    if (!options.mcpConfig || !options.skillsDir || options.clients?.length || options.all) {
      throw new Error('Custom setup requires both --mcp-config and --skills-dir, without --client or --all.');
    }
    available.splice(0, available.length, { id: 'custom', roots: [], commands: [],
      configs: [{ path: path.resolve(options.mcpConfig), format: options.mcpConfig.endsWith('.toml') ? 'toml' : 'json' }],
      skills: [path.resolve(options.skillsDir)], instructions: options.instructionsFile && path.resolve(options.instructionsFile) });
  }
  if (options.all && options.clients?.length) throw new Error('Choose --all or --client, not both.');
  for (const id of options.clients || []) if (!available.some(c => c.id === id)) throw new Error(`Unknown client: ${id}. Supported: ${available.map(c => c.id).join(', ')}.`);
  const selected = available.filter(c => c.id === 'custom' || options.all || (options.clients?.length ? options.clients.includes(c.id) : detected(c, env)));
  const plan = new Map(), detach = new Map();
  function add(file, bytes, kind) {
    // A config-file symlink remains a symlink. Skill-directory links are handled
    // separately so an update never modifies a different package through a link.
    const actual = kind === 'config' && fs.existsSync(file) ? fs.realpathSync(file) : file;
    const before = read(actual);
    const row = { path: actual, before, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), kind };
    if (plan.has(actual) && !equal(plan.get(actual).bytes, row.bytes)) throw new Error(`Conflicting setup targets: ${actual}`);
    plan.set(actual, row);
    return { path: file, status: equal(before, row.bytes) ? 'ready' : 'needs_update' };
  }
  const files = skillFiles(path.join(root, 'skills', skillName));
  const manifest = JSON.stringify({ schemaVersion: 1, version,
    files: Object.fromEntries(files.map(f => [f.relative, hash(f.bytes)])) }, null, 2) + '\n';
  const result = selected.map(client => {
    const configurations = client.configs.map(config => {
      try { return add(config.path, updateMcp(read(config.path)?.toString() || '', config.format, launch), 'config'); }
      catch (error) { throw new Error(`${config.path}: ${error.message}`); }
    });
    const skills = client.skills.map(directory => {
      const destination = path.join(directory, skillName);
      let link;
      try { if (fs.lstatSync(destination).isSymbolicLink()) link = fs.readlinkSync(destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const linkedToPackage = link !== undefined && fs.existsSync(destination)
        && fs.realpathSync(destination) === fs.realpathSync(path.join(root, 'skills', skillName));
      if (link !== undefined && !linkedToPackage) detach.set(destination, link);
      const entries = files.map(f => add(path.join(destination, f.relative), f.bytes, 'skill'));
      // A link directly to this installation already gets its version from the
      // package. Do not write installation bookkeeping into the package itself.
      if (!linkedToPackage) entries.push(add(path.join(destination, '.ai-app-bridge-install.json'), manifest, 'skill'));
      return { path: destination, status: entries.every(x => x.status === 'ready') ? 'ready' : 'needs_update', fileCount: files.length };
    });
    const instructions = [];
    if (client.instructions) instructions.push(add(client.instructions, updateInstructions(read(client.instructions)?.toString() || '', guidance), 'instructions'));
    return { client: client.id, detected: client.id === 'custom' || detected(client, env), configurations, skills, instructions,
      ...(client.projectInstructions && !options.project ? { instructionNote: client.projectInstructions } : {}),
      session: { status: 'not_verified', next: 'Reload MCP and skills, or start a new client session; confirm ai-app-bridge-use appears before relying on it.' } };
  });
  let projectInstructions;
  if (options.project) {
    const file = path.resolve(options.project, 'AGENTS.md');
    projectInstructions = add(file, updateInstructions(read(file)?.toString() || '', guidance), 'instructions');
  }
  const changed = [...plan.values()].filter(row => !equal(row.before, row.bytes) || [...detach.keys()].some(root => row.path.startsWith(root + path.sep)));
  const mode = options.check ? 'check' : options.dryRun ? 'plan' : 'apply';
  if (mode === 'apply') {
    // Validate the entire plan and check for concurrent edits before touching files.
    for (const row of plan.values()) if (!equal(read(row.path), row.before)) throw new Error(`Configuration changed during setup: ${row.path}`);
    for (const [directory, link] of detach) if (fs.readlinkSync(directory) !== link) throw new Error(`Skill link changed during setup: ${directory}`);
    for (const directory of detach.keys()) fs.unlinkSync(directory);
    for (const row of changed) {
      fs.mkdirSync(path.dirname(row.path), { recursive: true, mode: 0o700 });
      let mode = 0o600;
      try { mode = fs.statSync(row.path).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporary = row.path + `.aab-${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, row.bytes, { mode, flag: 'wx' }); fs.renameSync(temporary, row.path); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    for (const row of plan.values()) if (!equal(read(row.path), row.bytes)) throw new Error(`Post-write verification failed: ${row.path}`);
    for (const client of result) for (const group of ['configurations', 'skills', 'instructions']) for (const row of client[group]) row.status = 'ready';
    if (projectInstructions) projectInstructions.status = 'ready';
  }
  return { ok: mode !== 'check' || changed.length === 0, version, mode,
    ready: mode === 'apply' || changed.length === 0, clients: result,
    ...(projectInstructions ? { projectInstructions } : {}), changedFiles: changed.map(row => ({ path: row.path, kind: row.kind })),
    ...(selected.length ? {} : { message: 'No supported client detected. Select --client, --all, or provide custom configuration and skill paths.' }),
    sessionLoaded: 'not_verified', runtimeRestarted: false };
}

module.exports = { setup };
