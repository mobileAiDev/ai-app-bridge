# 0.4.18 release verification — 2026-10-19

Scope: agent-facing guidance and coordinated version metadata, based on
`a918fc5`. Command names, schemas and execution behavior remain unchanged.

## Guidance

Bridge is the default App/device execution path, including ADB through
`adb-exec`. Intent and Script are the primary task interfaces, including
one-off work. Standalone logs, screenshots, queries, diagnosis and explicit
atomic actions can use their Bridge command directly. External tools remain
available for explicit user choice or a confirmed Bridge capability or
availability gap.

MCP initialization, tool descriptions, command summaries, CLI help, READMEs
and the packaged skill use the same routing. The skill entry shrank from
26,199 to 5,045 bytes; detailed lifecycle, target/recovery and evidence guidance
is preserved in three linked references. Outer prompts explain capability and
routing; command hints retain only useful call essentials, with full parameters
discovered by command/operation when unknown.

## Prepublication verification

- AST comparison against the base, excluding guidance strings only, confirms
  the four edited JavaScript files preserve execution logic and schemas.
  MCP still exposes exactly `capabilities` and `run`, with 126 commands.
- Host functional: 1,925 passed, 23 conditional skips, no failures. Targeted
  contract/guidance/executable-example checks: 48 passed.
- Host performance: 49 passed, one G3 tree-summary timing threshold failed;
  isolated repetition also failed. The unchanged 0.4.17 baseline reproduces
  the same failure on this machine. The test and transformer are unchanged;
  all initial and comparison logs are retained. This wording release does not
  claim a fully passing performance suite or a performance improvement.
- Android SDK: 221 unit tests passed; UIA: 50 JVM tests passed. The UIA bundle
  was staged and all eight Maven modules were built into a local repository.
- Flutter: 82 tests passed, analyzer clean. Swift: 82 tests passed.
  Web: 43 tests passed.
- Both skill copies pass skill validation, link checks and byte-for-byte
  synchronization checks. Skill metadata and references are packaged together.
- The final CLI tarball passes clean installation with compilers/Python denied,
  bundled native loading, 126-command discovery, controlled ADB/UIA, JS/Python,
  Intent, CLI/MCP continuation and persisted-result/recovery checks.
  SHA-256: `8ee32349f8240832f699d9b4c28662a13a86ff6d09bff77c767ae80507474afd`.

## Publication

Public registry and installed-file verification will be recorded after the
immutable source tag and frozen archives are published. No public-channel
completion is asserted by this prepublication report.

## Boundaries

These checks establish prompt exposure, executable examples, unchanged
contracts and package integrity. They do not guarantee every agent/model will
choose the intended route, establish new physical-device or business-flow
acceptance, or reload already-running MCP/Runtime processes. Native FactStore
binaries and storage format remain unchanged.

Detailed logs, the baseline timing comparison and frozen artifacts are in
`ai-app-bridge-release-evidence/0.4.18-2026-10-19`, adjacent to the repository.
