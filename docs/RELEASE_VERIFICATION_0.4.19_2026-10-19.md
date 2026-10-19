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

Published source is immutable tag `0.4.19`, commit
`40861fff549aa14af90ae55fedf52691339496cd`.

- JitPack built that commit. All eight modules' 16 POM/AAR/JAR artifacts and
  both Gradle plugin markers are public and verified. All 341 class hashes
  match the local reference; embedded SDK metadata reports 0.4.19.
- npm CLI and Web archives match the frozen files. Both packages' `latest`
  and `next` point to 0.4.19. CLI SHA-256:
  `f4b70cf9cb211f8d262917f7511ca2182ca9d37d34899f68b733b6e83a7f7513`.
  Web SHA-256:
  `7241e7c75c0ab6c111595150d90eb8d73147f4598eaedacf854771b42afbbc3f`.
- Both Pub packages are public at 0.4.19. Their 61/6 archive files match the
  frozen source exports. An isolated hosted consumer resolves both from
  pub.dev without path overrides; lock hashes and installed sources match,
  and analysis passes.
- A fresh SwiftPM consumer resolves exact 0.4.19 to the tagged commit and
  passes an unsigned generic iOS build. All 43 root-package/iOS subtree
  source files checked match the frozen commit.
- The [GitHub release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.19)
  is public and latest. Anonymous downloads of both archives and SHA256SUMS
  match the frozen files.

The first noninteractive npm attempt required web verification; interactive
CLI verification completed publication and tag updates. Pub package-list
caches initially advertised 0.4.18 after exact 0.4.19 archives were available;
the final ordinary hosted resolution succeeded. One direct GitHub asset
download timed out; the existing system proxy completed public verification.
Initial failures are retained alongside successful results.

The global CLI was installed from public npm. All 260 archive files match.
Automatic setup synchronized five detected clients, six MCP configuration
files and seven complete skill locations. All unrelated parsed client settings
match their pre-install hashes; `setup --check` reports ready with zero edits.
Qoder's missing skill and Antigravity's old body-only copy are repaired.
The current Codex conversation received the installed standing instruction
block; loading in other live client sessions remains unverified.

With explicit user authorization for the newly active power leases, the
shared Runtime was stopped and restarted at 0.4.19. Old MCP server processes
were stopped. A fresh MCP stdio connection using the installed Codex launch
configuration reports client and Runtime 0.4.19, `compatible: true`, no issues,
and the unchanged two-tool surface. Its Script called `runtime status`,
asserted the running version and persisted its result; a second read returned
the same result and hash. Operation ID: `script-1792388642418-2`.
Runtime ID: `77215775-25e2-42d2-bec9-1e9531d7aa56`.

Verification used a fresh connection because the existing chat transport
closed when its old MCP process stopped. Existing clients may need MCP/skill
reload or a new session. Initial verification-harness mistakes (tool wording
matching and reading a Script call envelope instead of its `result`) were
corrected without changing product code; their failed evidence is retained.

## Consumer upgrades

Five common local projects now use public 0.4.19 in nine declarations:
POS Android, POS PDA, Reader, Duo/clone-master and MeasureDevice. Eight
resolution/build checks passed and produced seven debug APKs. All ten
resolved SDK/plugin artifact occurrences match the public Maven downloads.
PDA and Duo use their existing JDK 11 toolchain; the others use JDK 17.

All dependency edits are exact version replacements with original line
endings preserved. The five repositories retain their original HEAD, branch,
index and staged diff. Unrelated dirty/untracked files are unchanged except
for concurrent Duo work in `DeviceSpoofDialog.java`, recorded without reverting
it. Consumer edits remain uncommitted; no consumer repositories were pushed
and no APKs were installed on devices. Build evidence applies to the sources
present at each recorded build time.

The repository's Web smoke consumer also uses public 0.4.19. Its lockfile
integrity and all six installed files match the public archive, and its module
load check passes.

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
