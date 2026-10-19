#!/usr/bin/env node
'use strict';

const help = `Usage: ai-app-bridge setup [options]

Configure MCP, the complete ai-app-bridge-use skill and supported global
instructions for detected Codex, Claude Code, Cursor, Qoder and Antigravity clients.
Qoder IDE/CLI and Antigravity App/IDE/CLI locations are covered together.
Repeat after upgrades to synchronize installed files. Existing settings survive.

  --client <id[,id]>       Select clients (codex, claude, cursor, qoder, antigravity).
  --all                    Configure all supported clients, including absent ones.
  --project <directory>   Add/update a short managed block in project AGENTS.md.
                           Use for Cursor and Qoder IDE always-loaded instructions.
  --check                  Check without writes; exit 1 when updates are needed.
  --dry-run                Show the proposed changes without writes.
  --export                 Print pinned npx MCP configuration and instruction text.
  --mcp-config <file>      Custom JSON/JSONC mcpServers or TOML mcp_servers config.
  --skills-dir <directory> Custom skills root; required with --mcp-config.
  --instructions-file <file> Optional custom Markdown instruction file.
  --help                   Show this help.

No runtime restart or client trust approval is performed. File checks cannot
prove an existing session loaded the instructions; reconnect and check its
skill list. Global npm installs run setup for detected clients automatically.
Set AI_APP_BRIDGE_SKIP_SETUP=1 to opt out, or use setup after --ignore-scripts.
Local dependency/npx installation does not change client configuration.
`;

function parse(argv) {
  const result = {};
  const values = { '--client': 'clients', '--project': 'project', '--mcp-config': 'mcpConfig', '--skills-dir': 'skillsDir', '--instructions-file': 'instructionsFile' };
  const flags = { '--all': 'all', '--check': 'check', '--dry-run': 'dryRun', '--export': 'export', '--help': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (flags[option]) result[flags[option]] = true;
    else if (values[option]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
      if (option === '--client') result.clients = [...new Set([...(result.clients || []), ...value.split(',')])];
      else if (result[values[option]] !== undefined) throw new Error(`Duplicate option: ${option}`);
      else result[values[option]] = value;
    } else throw new Error(`Unknown setup option: ${option}`);
  }
  if ([result.check, result.dryRun, result.export].filter(Boolean).length > 1) throw new Error('Choose one of --check, --dry-run and --export.');
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parse(argv);
    if (options.help) { process.stdout.write(help); return; }
    const result = require('./install').setup(options);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'client_setup_failed', message: error.message }) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main, parse };
