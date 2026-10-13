# 0.4.8 release verification

Release source: `ddf95d1e578a094f3b6c9aa4fcd80bbfc75ff9d2`, annotated tag
`0.4.8`. The tag and published package bytes are immutable. This closeout is a
subsequent documentation update, not a different 0.4.8 build.

Status: **coordinated publication and local/consumer integration are complete**.
[GitHub 0.4.8 is published](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.8),
and both npm packages now have `latest` and `next` set to 0.4.8. Broader workflow
performance acceptance remains open for the full mixed/recovery flows described
below; completing publication does not close those performance requirements.

Evidence is retained under the sibling directory
`ai-app-bridge-release-evidence/0.4.8-work/2026-10-13/` (`N` below).
The [validation history](WORKFLOW_PERFORMANCE_0.4.8_CANDIDATE_2026-10-13.md)
retains failures, superseded candidates and timing boundaries.

## Public artifacts

| Component | Verification |
|---|---|
| CLI/MCP `@mobileaidev/ai-app-bridge` | npm 0.4.8; `latest` 0.4.8; public tarball equals the validated package |
| Web `@mobileaidev/ai-app-bridge-web` | npm 0.4.8; `latest` and `next` 0.4.8; public tarball equals the validated package |
| Android SDK, Gradle plugin and six optional executors | JitPack 0.4.8; eight modules, all 16 public POM/binary files verified |
| Flutter `ai_app_bridge_flutter` | Pub 0.4.8; 57/57 published files match the frozen inventory and release Git blobs |
| Flutter `ai_app_bridge_test` | Pub 0.4.8; 6/6 published files match the frozen inventory and release Git blobs |
| iOS Swift package | Public 0.4.8 tag peels to the release source; 40 source blobs verified |

The hash-bound UIA payload has no independent semantic version. Rebuilt bytes
match the CLI payload. The Host declares `sdkReleaseVersion: "0.4.8"`; optional
executor preparation resolves that explicit SDK dependency.

Public npm SHA-256:

- CLI: `576c6ba680036704e49bf8fbb847d14641c37f3fdcbac0bead5b900ab0aa3e66`
- Web: `0eafceeadcb79af8eea1c732c2d1e7737f2588a7244e152d9a164d772abb87ec`

Both registry SHA-512 values also match. See `N/publication/*-integrity.json`,
`jitpack/artifacts-report.json` and `pub-ios-verification.json`. Two Web `latest`
authentication attempts ended with callback HTTP 404; the second retained
repeated HTTP 202 responses without a successful callback. Neither changed or
invalidated the already verified package. A fresh third authentication succeeded:
the CLI confirmed the tag update and an independent registry read returned
`latest:0.4.8/next:0.4.8`. The package was not republished.

## Final-version verification

- Host: 1,660 functional and 50 performance tests passed; all 561 captured source
  files stayed unchanged during the run. Clean CLI installation and controlled
  CLI/MCP/npx, JS/Python, continuation, shutdown, permission and evidence checks
  passed; 218/218 shipped files match source, tarball and installation.
- Android: 214 debug and 214 release SDK tests, 50 UIA tests and eight plugin
  tests passed. These are 486 variant results, not 486 distinct test cases.
  No lint error/fatal finding occurred; existing warnings remain recorded.
- Web: the same 38 tests passed from source and the installed release tarball;
  all six published package files match source.
- Flutter: analyzers, 80 SDK tests and both Pub preflights passed. The helper has
  analyzer/preflight coverage and no separate test directory.
- iOS: unsigned generic-device compilation passed; 26 shared Swift/C files match
  the standalone and Flutter-embedded SDK. No device or Simulator runtime
  acceptance is claimed.

The final Host/Native/Web 0.4.8 builds also ran the original prepared business
programs, without rewriting their steps:

| Prepared flow | Final 0.4.8 result |
|---|---|
| Native HTTP login | 1.983 s for one Intent; 4.238 s including launch/readiness and independent server verification; one server session |
| Three Native/H5 commerce journeys | 46.299 s through the final oracle; 187 commands, two external calls, deliberate child-process interruption and same-operation continuation; 15/15 business checks |
| Web registration, five JS journeys and one Python journey | 9.327 s through final verification; 184 internal calls, 83 assertions, all six records independently checked |

These final-version traces ran alongside release work. They establish execution,
correctness and recovery for those programs, not a new controlled performance
improvement. Earlier quieter comparisons remain unchanged in the validation
history: the Web candidate was not faster than 0.4.7. The measured 40.69%
lossless response-byte saving is a delivery result, not execution-time saving.
Initial authoring and explicit agent-decision waits have separate timing scopes.
These flows do not constitute complete coverage of arbitrary apps.

The earlier complete three-journey mixed Native/Flutter/H5 program took
**62.334 seconds** for 201 commands, exceeding the 60-second target. It needs an
equivalent complete rerun; the faster three-journey Native/H5 program is a
different workload and cannot satisfy this row.

Flutter 0.4.8 changes version/dependency metadata, not the already tested
execution implementation. Earlier real mixed commerce and expired-session
recovery programs completed in 25.938 and 29.377 seconds. However, the complete
process-death recovery program took **67.501 seconds** and recorded
`performanceBudgetMet:false`. A later targeted recovery diagnostic does not
replace that complete commerce result. This cold-start/recovery long tail is
retained as a performance limitation, not marked as a passed one-minute budget.
Exact historical reports are listed in `N/publication/final-audit.md`.

## Local and consumer updates

The global CLI and installed Bridge skill use 0.4.8. All 218 global installed
files match the public archive, and both skill files match the installed package.
Existing Codex/Cursor launch paths already point to this global installation.
After the user's Codex restart, the actual connected MCP client and Runtime both
report 0.4.8 with identical code/config fingerprints and `compatible:true`;
Host doctor reports zero issues. See `N/local/global-upgrade.json` and
`current-codex-doctor-after-restart.json`.

| Consumer | Built target(s) |
|---|---|
| POS | `app:sitDebug` |
| Reader | `app:debug`, including the 0.4.8 Gradle plugin |
| Duo active worktree | `app:debug` |
| MeasureDevice | `measure-assist-android` app and receiver debug; `protocol-lab-android` app debug |

Seven dependency/build commands passed and all six APKs were verified against
their recorded SHA-256 values and ZIP integrity. The resolved SDK and plugin
bytes equal their public JitPack artifacts. Seven exact dependency-version
replacements were made; the existing worktree changes, staging, branches and
HEADs were preserved. Consumer updates are local and uncommitted. This is build
integration evidence, not consumer device acceptance. No K2 or physical-phone
installation or interaction was performed during this closeout.
See `N/consumers/REPORT.md` and `closeout.json`.

Future releases default to a coordinated version across maintained Bridge
components and recent consumers, as recorded in the CLI release policy.
