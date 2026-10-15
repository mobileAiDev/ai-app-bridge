# 0.4.13 coordinated release verification

Status: public publication, four consumer upgrades and the actual connected
Codex MCP/Runtime verification completed.

Immutable source tag: `0.4.13`, commit
`7317a7fe829e563a37a046f62e479e0ca58c9d0e`.

Evidence root: sibling `ai-app-bridge-release-evidence/0.4.13-2026-10-15/`.

## Publication scope

The user requested independent Maven publication, with later implementation
repairs published as new versions rather than replacing an existing tag.
The only behavior change since 0.4.12 is the publication command in
`jitpack.yml`: `clean publishToMavenLocal` replaces
`clean build publishToMavenLocal`. Public versions are coordinated at 0.4.13.
Application/runtime implementation and test logic are unchanged.

`publishToMavenLocal` retains compilation, packaging and publication metadata
dependencies. The aggregate `build` lifecycle, unit tests and Lint are separate
validation commands. This follows the supported
[JitPack custom installation contract](https://docs.jitpack.io/building/#custom-commands)
and [Gradle Maven publication tasks](https://docs.gradle.org/current/userguide/publishing_maven.html).
Neither tests nor assertions are deleted or weakened by this change. Publication
success and regression-suite results must be reported independently.

The immutable 0.4.12 source and failed public build are documented in
[its verification record](RELEASE_VERIFICATION_0.4.12_2026-10-15.md).
Its remote capture-attachment timeout remains a separate diagnosis item.

## Validation scope

- Reused implementation evidence from 0.4.12: Host functional 1,857/1,857,
  performance 50/50, Web 38/38; Android local full build 498/498 with Lint
  zero errors/13 warnings. The conflicting remote Android test outcome is
  retained, not converted into a pass.
- Swift/Flutter original-source pressure/deadline test failures are documented
  separately. An isolated harness corrected those test assumptions and passed
  82/82 tests in each suite plus five paired high-load repetitions, with every
  runtime source byte identical to the frozen 0.4.12 source. The test changes
  are not in this release; this is not a claim that the original suite passed.
- New publication task graph: 263 tasks, no tests or Lint; eight publication
  modules compile, package and generate metadata. Actual isolated publication
  passed in 23.130 seconds; 16/16 artifacts and 341 classes audited.
- New CLI clean-package verification and exact CLI/Web archive parity passed.
- Public Maven: first build passed in 131 seconds, with eight modules and
  16 public POM/AAR/JAR files verified. All 341 class files match the local
  publication bytes, and all internal versions are 0.4.13. No tests or Lint
  ran on the publication service. Public download transport failures are
  retained separately; each final artifact came from a verified HTTP 200
  response, without a private/local repository substitution.
- npm: CLI and Web packages, both `latest` and `next`, are 0.4.13. Downloaded
  archives match the frozen bytes, SHA-256, registry SHA-512 and SHA-1.
  GitHub's public release and all three assets also match the frozen files.
- Pub: both packages are publicly downloadable at 0.4.13; all 60 SDK and six
  helper files match their frozen source. A normal hosted consumer resolves
  the official registry and passes analyze, without path overrides.
- SwiftPM: exact public tag resolution and all 143 source-file hashes match;
  a new unsigned generic iOS consumer builds from that public dependency.
- POS, Reader, Duo and MeasureDevice: seven Gradle checks and six APK integrity
  checks passed. Eight actual SDK/plugin resolutions match the public Maven
  artifact hashes. Total build wall time was 81.504 seconds, with at most two
  projects in parallel. Branches, index, staged changes and unrelated files
  were preserved; no consumer commit, push or device installation occurred.
- Installed CLI: all 238 packaged files match the public npm archive; both
  installed skill files match. A fresh MCP and CLI share a 0.4.13 Runtime;
  JavaScript concurrent calls and Python Script pass. The Web smoke project
  also installs the public package and passes its import check.
- Actual Codex connection: `doctor` reports client and shared Runtime 0.4.13,
  identical code/config fingerprints, `compatible: true` and zero issues.
  Runtime ID `6543e891-4e17-403a-a77a-1ed88e377725`, PID 58574. After the user
  authorized a shared restart, reinspection found this new Runtime already
  running; it was verified rather than stopped again. The old process had
  ended. This task's empty temporary handover Runtime was separately stopped.

## Recorded artifacts and remaining boundaries

The evidence root contains `maven/jitpack/PUBLIC_REPORT.json`,
`npm/{cli,web}-public-integrity.json`, `github-public/report.json`,
`sdk/SDK_RELEASE_REPORT.md`, `consumers-four/closeout.json`,
`local/global-install-parity.json`,
`local/public-install/global-mcp-report.json` and
`local/connected-codex-mcp.json`.

The earlier Android startup timeout was investigated independently: 60 checks
across 20 independent JVMs and 1,100 checks across five randomized full suites
passed. Blocking the real writer for 6.5 seconds reproduced the original
five-second assertion timeout; releasing it let the original test pass.
This demonstrates one sufficient cause, not the actual remote cause. The
remote failure remains UNKNOWN and is not relabeled as fixed. The tests use
ordinary JUnit4 and the AGP mockable Android jar, not Robolectric.

Physical-device evidence remains the bounded 0.4.10/0.4.11 supplement; there is
no new device-installation or whole-App speed claim. Windows normal CLI
installation remains unsupported as documented in
[the Windows plan](WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md).

Consumer work preserves existing branches, staged state and unrelated changes.
The K2 cashier is excluded. Published tags and archives are never replaced.
