# 0.4.14 coordinated release verification

Status at source freeze: implementation, platform acceptance and final clean
package verification passed; public publication and consumer upgrades are pending.
These later gates are not implied by the platform results below.

Evidence roots (siblings of this repository):

- `ai-app-bridge-release-evidence/0.4.14-2026-10-15/`
- `ai-app-bridge-release-evidence/windows-closeout-2026-10-15/`

## Scope

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web advance
together to 0.4.14. Windows x64 gains a native store and a tested Host execution
path. macOS arm64/x64 and Linux glibc arm64/x64 were already shipped in 0.4.13.
The native library keeps version 0.2.0, Node-API 8 and the existing v1 format.

The changes include Windows durable I/O, Unicode paths and Python transport,
literal command-wrapper arguments, scoped process cancellation, completed
daemon lifetimes and Runtime shutdown. SDK source exports now include the
private C platform header. Swift/Flutter test maintenance corrects accepted
record and action-phase assumptions without changing production queue limits
or deadlines. See [release changes](../desktop/ai-app-bridge-cli/docs/RELEASE.md).

## Platform acceptance

Both final CI runs used source `6187bb57a389aeab37b4ec4e2a4c5a5c28cb9621`.
The release subsequently imports the exact Windows artifact and updates only
release documentation. Seven native source hashes and each selected binary
are checked against source, CI tarball and fresh installation.

| Platform | Native | Shared Host | Fresh install |
| --- | --- | --- | --- |
| Windows x64 | 17 tests, C suite and golden bytes pass | 206 pass, 0 fail, 2 POSIX-only skips | 9 checks pass, 248 source files verified |
| Intel Mac | 17 tests, C suite and golden bytes pass | 369 pass, 0 fail, 1 platform skip | 9 checks pass, 247 source files verified |
| Linux glibc x64 | 17 tests, C suite and golden bytes pass | 369 pass, 0 fail, 1 platform skip | 9 checks pass, 247 source files verified |
| Linux glibc arm64 | 17 tests, C suite and golden bytes pass | 369 pass, 0 fail, 1 platform skip | 9 checks pass, 247 source files verified |
| Apple Silicon Mac | Final native artifact 17/17 pass | Broad earlier run 1,887 pass, 0 fail, 22 Windows skips; final focused run 32 pass, 0 fail, 1 Windows skip | Final coordinated CLI archive and complete package gate pass, 248 source files verified |

Final [Windows CI](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38734283036)
and [existing POSIX CI](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38734289532)
both passed. The Windows run includes 20 immediate cancellation repetitions,
three nested-process repetitions with 23/24/25 members, old-source negative
controls, independently owned process identities and a real isolated-port ADB
server. No attached device is operated by that ADB check. Fresh installations
exercise CLI/MCP sharing, JavaScript/Python, Chinese input, client disconnect,
askAgent, original-operation checkpoint recovery, cancellation and cleanup.

Failed intermediate runs remain recorded in
[Windows acceptance](WINDOWS_HOST_VALIDATION_2026-10-15.md). Passing installation
alone never converted an earlier lifecycle failure into a pass.

## SDK and publication preparation

- SDK: 160 frozen inputs and 31 canonical iOS/Flutter mirror checks plus three
  WDA mirrors verified. Both Pub dry runs passed without warnings. Unsigned
  generic iOS builds passed from SwiftPM source and the Flutter CocoaPods export,
  including the private C platform header. The two maintained test suites each
  passed 82 cases; source relationships and inherited evidence remain explicit
  in `sdk/SDK_PREFLIGHT_REPORT.json`.
- Maven: isolated `clean publishToMavenLocal` passed in 22.935 seconds, with
  263 tasks and no test/Lint lifecycle. Eight modules, 16 main POM/AAR/JAR
  artifacts and 341 class hashes were checked. Public JitPack publication is
  verified separately after the new immutable tag exists.
- CLI: the final real tarball passes the full clean-package gate, including
  compiler/Python-denied installation, first/repeated npx start, CLI/MCP
  discovery, two-language execution, original-operation recovery, controlled
  UIA/ADB and cancellation/Runtime shutdown. All 248 packaged source files and
  modes match the frozen source. This gate uses controlled devices only.
- Web: the 0.4.14 tarball's six files and modes match the frozen source.
- Four consumers have fresh before-state snapshots. Their versions are changed
  only after public artifacts are readable; unrelated changes and index state
  are preserved. No consumer commit, push or device installation is requested.
- The remote Web smoke example keeps its previous manifest and lockfile until
  the new public npm version can resolve both together.

## Remaining publication gates at this snapshot

Publish the new immutable tag and matching npm/Pub/Maven/GitHub artifacts,
compare public downloads to the
frozen archives, and build normal public-coordinate SDK consumers. Upgrade the
four projects and local CLI/skill, then verify the shared Runtime and actual
connected MCP version separately. Publication evidence is written under the
0.4.14 evidence root; the 0.4.13 release and its evidence are not overwritten.

Frozen npm archive SHA-256 values:

- CLI: `6f77f1efa9197bcea9976dd5a999c247f108055a93ada74ffbabf003dbaffed8`
- Web: `5663620d255b0c588e922419798218e28f72a527bebea80f4b86b8e62d20306f`

## Acceptance limits

Windows power API and lease-lifetime checks passed in actual Windows CI.
Physical Windows display/sleep behavior remains deferred by the user. Host
checks do not imply new Android/iPhone business-flow acceptance; those results
retain their documented scope from prior versions. The Android remote five
second wait failure still has an unknown cause. Existing iOS permission-flow
usability and timing limits remain recorded.

This release makes no new whole-App speed claim and does not ship the deferred
group-commit, connection-cache, universal exploration-export or effect-key
experiments merely because their prototypes ran. See the
[optimization decision record](OPTIMIZATION_EXECUTION_2026-10-15.md).
