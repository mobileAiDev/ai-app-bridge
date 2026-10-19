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

Published source is immutable tag `0.4.18`, commit
`a6ec8ef883c7ad84e02993cd54d0ceabcf2f46d3`.

- JitPack built the tagged commit. All eight modules' 16 POM/AAR/JAR artifacts
  and both relocated Gradle plugin markers are public and verified. All 341
  class hashes match the local reference build; SDK metadata reports 0.4.18.
- npm CLI and Web SDK are publicly downloadable; both archives match the
  frozen files. Both packages' `latest` and `next` point to 0.4.18. Web SHA-256:
  `5d8d4f98261b3397c68c77391d01abb588c31948403aa045f4ec9ca1dd23f044`.
- Both Pub packages are public at 0.4.18. Their 61/6 archive files match the
  frozen exports. An isolated hosted consumer resolves both from pub.dev;
  lockfile archive hashes match, all source files match, and analysis passes.
- A fresh SwiftPM consumer resolves exact 0.4.18 to the tagged commit. Its
  unsigned generic iOS build passes and all 29 root-package/SDK source files
  match the frozen source.
- The [GitHub release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.18)
  is public and latest. Both npm archives and SHA256SUMS download anonymously
  and match the frozen files.

Initial npm/Pub reads saw stale metadata and the Web archive initially returned
404. Final public downloads and integrity checks passed. Using the machine's
existing system proxy for the CLI resolved the hosted Pub packages without
changing version constraints or adding path overrides.

## Local CLI, skill, MCP and Runtime

The global CLI is installed from public npm at 0.4.18. All 253 archive files
match the public tarball. The installed skill's five files match the packaged
source. Previous local MCP processes were stopped and this session reconnected
with the new tool descriptions. With explicit user authorization, the shared Runtime was
stopped and restarted at 0.4.18, releasing its previous power leases.

The actual MCP `doctor` call reports client and Runtime 0.4.18 with
`compatible: true` and no issues. An actual MCP Script called `runtime status`,
asserted the running version, completed and persisted its result. Reading the
same operation's result returned the same evidence hash. The operation ID is
`script-1792380006067-1`; the new Runtime ID is
`94c0cd0c-17e9-4283-a7d1-81ffa1fcdc49`.

Installation alone does not refresh other already-connected clients' cached
descriptions; those clients need to reconnect.

## Consumer upgrades

Five common local projects now reference 0.4.18 in nine dependency declarations:

| Project | Updated references | Verified build |
| --- | --- | --- |
| POS Android | SDK/plugin version catalog | `sitDebug` |
| POS PDA | SDK and Gradle plugin, from 0.4.1 | `chainPreDebug` |
| Reader | SDK and Gradle plugin | `debug` |
| Duo / clone-master | SDK | `debug` |
| MeasureDevice | Assist SDK/plugin and protocol-lab SDK | Assist app, receiver and protocol app debug |

Eight final resolution/build checks passed, producing seven debug APKs. All ten
resolved Bridge SDK/plugin artifact occurrences match the public 0.4.18 Maven
artifacts. PDA's first JDK 17 attempt failed in its existing ButterKnife
processor's access to javac `TreeScanner`; the same project built with JDK 11,
without changing project code or compatibility settings. Both attempts remain
in the evidence.

All nine edited files match the recorded exact version replacements, including
their original line endings. All five repositories retain their original HEAD,
branch, index and staged diff. Other dirty and untracked files are unchanged
except for concurrent unrelated Duo work, recorded without reverting it.
Consumer dependency edits remain uncommitted; no consumer repositories were
pushed and no APKs were installed on devices. Build evidence applies to the
sources present at each recorded build time.

The repository's Web smoke consumer also uses public 0.4.18. Its lockfile
integrity and all six installed SDK files match the verified public archive,
and its module-load check passes.

## Boundaries

These checks establish prompt exposure, executable examples, unchanged
contracts and package integrity. They do not guarantee every agent/model will
choose the intended route or establish new physical-device or business-flow
acceptance. Native FactStore binaries and storage format remain unchanged.

Detailed logs, the baseline timing comparison and frozen artifacts are in
`ai-app-bridge-release-evidence/0.4.18-2026-10-19`, adjacent to the repository.
