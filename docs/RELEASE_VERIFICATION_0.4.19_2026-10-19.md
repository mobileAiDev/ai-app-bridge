# 0.4.19 release verification — 2026-10-19

Scope: cross-client MCP, skill and instruction delivery, based on `81f180e`.
SDKs receive coordinated version metadata only. Existing device execution,
MCP tools and command contracts remain unchanged.

## Installation and guidance

Global npm installation and upgrades configure detected Codex, Claude Code,
Cursor, Qoder and Antigravity clients. The host-only `setup` entry installs
the complete five-file skill, updates MCP launch settings and adds a short
managed rule to supported global instruction files. Qoder IDE/CLI and
Antigravity App/IDE/CLI locations are included. Cursor and Qoder IDE can use
`setup --project .` for standing project instructions.

Bridge remains the default App/device route, including ADB via `adb-exec`.
Intent/Script are the primary task interfaces, including one-off tasks;
standalone logs, screenshots, queries and actions use commands directly.
Explicit user choice and confirmed Bridge gaps remain valid exceptions.

MCP initialization and tool descriptions already expose this routing without
calling `capabilities`. Host rendering is outside the server's control.
Setup therefore checks file delivery separately from session loading, which
it reports as `not_verified`. It does not approve trust or restart clients or
the shared Runtime. Local dependency/npx installation does not alter clients;
global setup has an explicit opt-out. See [client setup](../desktop/ai-app-bridge-cli/docs/CLIENT_SETUP.md).

## Prepublication verification

- Host functional suite: 1,941 passed, 23 conditional skips, no failures.
  Final setup tests: 17 passed, including the additional identical external
  skill-link regression found during review. External link targets remain
  untouched; links into the current package remain linked.
- Real global npm installation in an isolated user directory configured all
  five clients. A real 0.4.18 → 0.4.19 upgrade repaired an old body-only skill
  and retained unrelated servers, environment and user settings. Repeated
  setup checks require no changes.
- JSONC/TOML tests cover comments, inline/dotted/table syntax, preserving
  settings, invalid-config rejection before writes and managed instructions.
  Read-only checks, custom paths, explicit selection and opt-out are covered.
- AST comparison confirms only host setup dispatch/help changed in the CLI.
  MCP server, registry, request and discovery sources are byte-for-byte
  unchanged. MCP still exposes `capabilities` and `run`, with 126 commands.
- Android SDK: 221 unit tests passed; UIA: 50 JVM tests passed. All eight
  Maven modules were built locally and the UIA runtime bundle was staged.
- Flutter: 82 tests passed and analyzer clean. Swift: 82 tests passed.
  Web: 43 tests passed. Both skill copies and all references match.
- The final CLI archive passes clean installation with compilers/Python
  denied, native loading, npx reuse, all command contracts, controlled ADB/UIA,
  JS/Python, Intent and persisted result/recovery/shutdown checks.

## Publication and local rollout

Public channel and local rollout verification will be recorded after the
immutable source tag is published. Prepublication success alone does not
establish public availability or loaded client sessions.

## Boundaries

No new physical-device, business-flow or performance acceptance is claimed.
The previously documented performance timing baseline is not changed by this
host installation feature. Native FactStore binaries and format are unchanged.
Other clients need documented paths or a manual export; arbitrary hosts are
not claimed to be automatically supported.

Logs, frozen archives and manifests are retained in the adjacent
`ai-app-bridge-release-evidence/0.4.19-2026-10-19` directory. Initial toolchain
lookup failures are retained separately from the successful Flutter and Swift
test runs.
