# Client setup

Global installation automatically configures detected Codex, Claude Code,
Cursor, Qoder and Antigravity clients. It installs the complete usage skill and
a short execution rule wherever the client supports global instruction files.
The same process runs on global upgrades.

```sh
npm install -g @mobileaidev/ai-app-bridge@0.4.19
ai-app-bridge setup --check
```

For Cursor and Qoder IDE, add the short rule to the current project's
`AGENTS.md` explicitly:

```sh
ai-app-bridge setup --project .
```

The rule keeps Bridge as the default, Intent/Script as the primary task
interfaces, and direct commands for standalone logs, screenshots, queries and
actions. It retains explicit user choice and confirmed capability/availability
gaps. Detailed workflow guidance stays in the skill; full command contracts
remain available through scoped `capabilities` queries.

## Select, inspect and update

```sh
ai-app-bridge setup                         # detected clients
ai-app-bridge setup --client qoder,cursor    # selected clients
ai-app-bridge setup --all                   # all supported clients
ai-app-bridge setup --dry-run               # proposed files; no writes
ai-app-bridge setup --check                 # current file/contract checks
ai-app-bridge setup --export                # pinned npx MCP config + rule text
```

Detection uses client configuration directories and executables on PATH. A
client installed later is picked up on the next `setup` or global upgrade.
`--check` exits 1 when files need updating; rerunning setup synchronizes them.
No existing client is required for an explicit `--client` selection.

Set `AI_APP_BRIDGE_SKIP_SETUP=1` for a global install that should leave clients
untouched. With npm `--ignore-scripts`, run setup explicitly afterwards. Local
dependency installs and ephemeral npx installs never configure clients
automatically. Apply setup from a persistent installation; `--export` supports
manual pinned npx connections without referencing an evictable npm cache path.

## Locations

All paths below are user-level. The installer changes only the
`ai-app-bridge` MCP launch, its skill bundle and its marked instruction block.
It preserves other servers, provider environment, timeouts, comments and user
instructions. It validates all selected configurations before writing any file.
Malformed configuration, explicit disablement or an existing remote Bridge
transport is reported for review instead of being silently replaced.

| Client | MCP configuration | Skill directories | Standing instructions |
| --- | --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml` (default `~/.codex`) | `~/.agents/skills`; an existing `$CODEX_HOME/skills` Bridge copy is also updated | `$CODEX_HOME/AGENTS.override.md` when present, otherwise `AGENTS.md` |
| Claude Code | `~/.claude.json` | `~/.claude/skills` | `~/.claude/CLAUDE.md` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/skills` | Project `AGENTS.md` with `--project`; global User Rules use Cursor's UI |
| Qoder IDE + CLI | `~/.qoder/mcp.json` and `~/.qoder/settings.json` | `~/.qoder/skills` | `~/.qoder/AGENTS.md` for CLI; project `AGENTS.md` with `--project` for IDE |
| Antigravity App/IDE + CLI | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills` | `~/.gemini/config/AGENTS.md` |

`CLAUDE_CONFIG_DIR` and `QODER_CONFIG_DIR` replace their respective default
configuration directories; Claude's custom global state file is
`$CLAUDE_CONFIG_DIR/.claude.json`. The generated local MCP launch points to the
Node executable and this persistent package installation. Moving/removing that
installation requires rerunning setup from its new location.

Skill updates copy every packaged reference, preserve unrelated files in an
existing skill directory, and record a version/hash manifest. A skill link into
the current package stays linked. A stale link to another directory is replaced
with a local copy, leaving its original target untouched.

## Other clients

For a host using JSON/JSONC `mcpServers` or TOML `mcp_servers`, supply its actual
documented locations. `--skills-dir` is the parent directory of skill folders:

```sh
ai-app-bridge setup --mcp-config /path/to/client/mcp.json \
  --skills-dir /path/to/client/skills \
  --instructions-file /path/to/client/AGENTS.md
```

The instruction file is optional. For other configuration formats, use
`--export` and the host's installation mechanism. This is not a claim of
automatic compatibility with every CLI or hosted/remote agent.

## Verify delivery

Setup reports file readiness separately from `sessionLoaded: not_verified`.
It never approves client trust dialogs, reconnects a live client or restarts
the shared Runtime. Reconnect MCP and reload skills (Qoder CLI supports
`/skills reload`), then confirm `ai-app-bridge-use` appears in that session.
Check the actual MCP connection's `doctor` result before claiming Runtime
compatibility after an upgrade; consider other active work before restarting.

MCP `initialize.instructions` and `tools/list` descriptions already carry the
execution guidance without calling the Bridge `capabilities` tool. Hosts choose
how to expose those fields. The installed rule and skill provide additional
entry points; their files alone do not prove that a live session loaded them.

Client contracts checked for this release: [Codex skills](https://developers.openai.com/codex/skills),
[Codex instructions](https://developers.openai.com/codex/guides/agents-md),
[Claude skills](https://code.claude.com/docs/en/skills),
[Cursor skills](https://cursor.com/help/customization/skills),
[Cursor rules](https://cursor.com/docs/rules),
[Qoder CLI configuration](https://docs.qoder.com/cli/mcp-reference),
[Qoder memory](https://docs.qoder.com/cli/memory),
[Qoder IDE rules](https://docs.qoder.com/user-guide/rules),
[Antigravity MCP](https://antigravity.google/docs/mcp), and
[Antigravity skills](https://antigravity.google/docs/skills).
