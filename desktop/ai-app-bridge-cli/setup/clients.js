'use strict';

const fs = require('node:fs');
const path = require('node:path');

function clients(home, env) {
  const codex = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  const claude = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  const qoder = path.resolve(env.QODER_CONFIG_DIR || path.join(home, '.qoder'));
  const cursor = path.join(home, '.cursor');
  const gemini = path.join(home, '.gemini');
  return [
    { id: 'codex', roots: [codex], commands: ['codex'],
      configs: [{ path: path.join(codex, 'config.toml'), format: 'toml' }],
      skills: [path.join(home, '.agents/skills'), ...(fs.existsSync(path.join(codex, 'skills/ai-app-bridge-use')) ? [path.join(codex, 'skills')] : [])],
      instructions: path.join(codex, fs.existsSync(path.join(codex, 'AGENTS.override.md')) ? 'AGENTS.override.md' : 'AGENTS.md') },
    { id: 'claude', roots: [claude], commands: ['claude'],
      configs: [{ path: env.CLAUDE_CONFIG_DIR ? path.join(claude, '.claude.json') : path.join(home, '.claude.json'), format: 'json' }],
      skills: [path.join(claude, 'skills')], instructions: path.join(claude, 'CLAUDE.md') },
    { id: 'cursor', roots: [cursor], commands: ['cursor', 'cursor-agent'],
      configs: [{ path: path.join(cursor, 'mcp.json'), format: 'json' }], skills: [path.join(cursor, 'skills')],
      projectInstructions: 'Cursor global User Rules are managed in its UI; use --project for a project AGENTS.md.' },
    { id: 'qoder', roots: [qoder], commands: ['qoder', 'qodercli'],
      configs: ['mcp.json', 'settings.json'].map(name => ({ path: path.join(qoder, name), format: 'json' })),
      skills: [path.join(qoder, 'skills')], instructions: path.join(qoder, 'AGENTS.md'),
      projectInstructions: 'The global AGENTS.md covers Qoder CLI; use --project for Qoder IDE project instructions.' },
    { id: 'antigravity', roots: [path.join(gemini, 'config'), path.join(gemini, 'antigravity'), path.join(gemini, 'antigravity-cli')], commands: ['antigravity', 'agy'],
      configs: [{ path: path.join(gemini, 'config/mcp_config.json'), format: 'json' }],
      skills: [path.join(gemini, 'config/skills'), path.join(gemini, 'antigravity-cli/skills')],
      instructions: path.join(gemini, 'config/AGENTS.md') },
  ];
}

function detected(client, env, platform = process.platform) {
  if (client.roots.some(root => fs.existsSync(root)) || client.configs.some(c => fs.existsSync(c.path))) return true;
  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return (env.PATH || '').split(path.delimiter).filter(Boolean).some(directory =>
    client.commands.some(name => extensions.some(ext => fs.existsSync(path.join(directory, name + ext)))));
}

module.exports = { clients, detected };
