# 0.4.9 release verification

Release source: `f3274017c89ebe8306284a0cc6ecd1246ce331ef`, annotated tag
`0.4.9` (`41c3a35a7d4b784c89e0e86a2e6d8ce93024e0a3`). The tag and
validated package bytes are immutable. This closeout is subsequent documentation,
not a different 0.4.9 build.

Status: **GitHub, Android, Flutter and Swift publication is complete; npm
publication still awaits account authentication.** Local CLI installation and
fresh MCP checks pass. Four Android consumers have been upgraded and built.
The already connected Codex MCP process still reports 0.4.8 and must reconnect.
The public Web smoke dependency remains 0.4.8 until npm 0.4.9 is available.

Evidence is retained in the sibling directory
`ai-app-bridge-release-evidence/0.4.9-2026-10-14/` (`P` below). The frozen
candidate evidence remains in `release-readiness-2026-10-14/` (`E`). See the
[candidate audit](RELEASE_CANDIDATE_AUDIT_2026-10-14.md) for the complete review,
adoption decisions, retained failures and runtime acceptance boundaries.

## Public channels

| Component | Observed status |
|---|---|
| Git source and [GitHub Release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.9) | Main and tag peel to the frozen source; release published with the validated CLI/Web archives and SHA-256 checksums |
| CLI/MCP `@mobileaidev/ai-app-bridge` | npm pending authentication; the validated 0.4.9 archive is attached to GitHub |
| Web `@mobileaidev/ai-app-bridge-web` | npm pending authentication; the validated 0.4.9 archive is attached to GitHub |
| Android SDK, Gradle plugin and six optional executors | JitPack 0.4.9; eight modules and 16 public POM/binary files downloaded and verified |
| Flutter `ai_app_bridge_flutter` | Pub 0.4.9; public latest 0.4.9; all 57 published files match the frozen inventory and release Git |
| Flutter `ai_app_bridge_test` | Pub 0.4.9; public latest 0.4.9; all six published files match the frozen inventory and release Git |
| Swift package | Public tag identity and all 40 source blobs match; three principal source files additionally downloaded and checked byte for byte |

Frozen archive SHA-256:

- CLI: `ec828a94e653bed51c9b360650de24771318100a84a0ec5011f3507dd54f53fe`
- Web: `475a82cc476e74708e6e493970ac0380e2f1ed7766381e9428b7042c1d030382`
- Flutter SDK: `5b48bf4a101740e37efcd4dc46fa7fdb056abc549684730245e8835002613381`
- Flutter helper: `9c5bf62a5bd89e5e3c435ece349c13b3147a5fa9a12144c92af1c3716fb5efa3`

The final CLI archive differs from the execution-tested archive only in the
release documentation. All other 222 shipped files and their modes are unchanged;
clean package installation and all 223-file comparisons passed again. See
`E/release-package-parity.json` and `E/package-release/report.json`.

The hash-bound UIA JAR is
`260d631a2ddfd61ac5a031ac36983a4bd9bb3adc46c12a62feb57cf36ca8a60c`.
It has no separate semantic version. Device/Web protocol identities and the
private FactStore component version are unchanged.

JitPack reports `status:ok`, the exact release commit and a successful 4m39s
build. Its log also retains a lint/UAST cache-write heap error; the complete
build exited 0 and the public products passed the independent checks. Two
`raw.githubusercontent.com` TLS resets are retained; Swift source content was
then explicitly fetched through the public GitHub Git Blob API and verified.
These events are not rewritten as successful first attempts.

## Local CLI, MCP and skill

The global installation at
`/opt/homebrew/lib/node_modules/@mobileaidev/ai-app-bridge` is 0.4.9, installed
from the exact frozen release archive while npm authentication is pending.
All 223 package files match that archive. The two installed Bridge skill files
already matched the release and required no change.

Existing Codex and Cursor configuration points to this global installation;
their configuration bytes and approval settings were preserved. A fresh MCP
process passed runtime identity/compatibility, a same-runtime CLI query, Host
doctor with zero issues, wrapped read-only ADB, eight concurrent JavaScript
calls and Python Script. The isolated verification Runtime was stopped afterward.
See `P/local/global-install-parity.json`, `global-mcp-report.json`,
`skill-update.json` and `post-test-cleanup.json`.

The actual pre-existing Codex connection was checked separately after the disk
upgrade: its pinned client identity is still 0.4.8 and the shared Runtime is
stopped. Updating installed files does not replace that process. The fresh MCP
result must not be represented as a completed reconnect of the current chat.
See `P/local/current-codex-doctor-after-disk-upgrade.json`.

## Consumer dependency integration

| Consumer | Built targets |
|---|---|
| POS | `app:sitDebug` |
| Reader | `app:debug`, including the 0.4.9 Gradle plugin |
| Duo active worktree | `app:debug` |
| MeasureDevice | `measure-assist-android` app and receiver debug; `protocol-lab-android` app debug |

All six APK builds passed, with ZIP CRC and recorded artifact hashes checked.
Actual resolved SDK and plugin bytes match the downloaded public JitPack files:

- SDK AAR: `272662943b1da5e5ec54123d046a7b9c285dea5f5fd0d4dff98e9898338a6c51`
- Gradle plugin JAR: `8cd2ca586a0105ec4852aadad116e0df27bcea4f406d370fb3943e4112b3117f`

Seven exact dependency-version replacements were made. Consumer HEADs,
branches, index bytes, existing staged changes and unrelated working/untracked
files were preserved. The consumer edits remain local and uncommitted. This is
build integration evidence; no consumer APK was installed on a phone or K2.
See `P/consumers-pos-duo/closeout.json` and
`P/consumers-reader-measure/closeout.json`.

## Remaining release closeout

1. Complete npm's account verification and publish the two exact archives with
   the intended public default tags. Download them from npm and verify hashes.
2. Upgrade `web/remote-smoke` from the actual public npm metadata; verify its
   installed files and executable entry points. Do not invent lockfile integrity.
3. Reconnect Codex to load the updated MCP and verify the actual current client.

The first npm login attempt expired: its callback returned HTTP 404 after
repeated pending responses. A subsequent `npm whoami` returned HTTP 401. No npm
publication success is claimed, and no package has been republished as a retry.

The accepted performance and recovery evidence is unchanged: the prepared
dynamic Android flows improve by 31.24% and 26.55% in their respective paired
comparisons; this is not a universal app-speed promise. iOS shared tests and
unsigned compilation passed, but iOS device/Simulator runtime acceptance remains
unverified. Neither channel publication nor consumer compilation expands those
runtime claims.
