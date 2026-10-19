# 0.4.19 coordinated release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.19 together. This release adds Host client installation and delivery checks.
Existing MCP `run`/`capabilities`, command schemas and device execution behavior
remain unchanged.

## Changes

Global npm installation and upgrades configure detected Codex, Claude Code,
Cursor, Qoder and Antigravity clients. Host-only `ai-app-bridge setup` installs
MCP, every skill reference and supported short standing instructions together.
It covers both Qoder configuration files and both Antigravity skill locations.
JSONC/TOML edits retain unrelated settings and comments; skill updates repair
missing references and leave external symlink targets untouched.

Use `--check` for file readiness, `--dry-run` for proposed edits, `--client` or
`--all` for selection, and `--project` for a managed project instruction block.
Custom config/skill paths and a pinned MCP export support other hosts. Local
package/npx installation does not alter clients; global setup has an opt-out.
See [the installation contract](CLIENT_SETUP.md).

Bridge remains the default App/device path, including ADB via `adb-exec`.
Intent/Script are the primary task interfaces, including one-off work;
standalone logs, screenshots, queries and actions use commands directly.
Explicit user choice and confirmed Bridge gaps remain valid exceptions.

## Validation and limits

The release-verification report records client installation tests, package and
registry checks. MCP initialization and tool descriptions already expose the
routing before any `capabilities` call. Client delivery is implementation-specific:
setup reports file readiness separately from actual session loading, never
approves trust dialogs and never restarts the shared Runtime.

SDKs and optional executors receive coordinated version updates only. Native
FactStore binaries, Node-API 8 and the v1 storage format remain unchanged.
No new physical-device, business-flow or performance acceptance is claimed.

## Release procedure

Freeze reviewed source and exact archives after applicable checks pass. Publish
a new immutable Git tag and verify all public Maven artifacts before publishing
the other channels. Verify npm, Pub, GitHub downloads and SwiftPM resolution
against frozen inputs. Use public coordinates for consumer upgrades. Check
installed files and resident MCP/Runtime processes separately; installation does
not reload a live process. Existing operations must be considered before restart.
