# 0.4.13 coordinated release verification

Status: preparing public publication and consumer verification.

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
  Public channel downloads and four consumer builds remain pending.
- Local CLI, installed skill, default Runtime and actual Codex MCP: pending.

Physical-device evidence remains the bounded 0.4.10/0.4.11 supplement; there is
no new device-installation or whole-App speed claim. Windows normal CLI
installation remains unsupported as documented in
[the Windows plan](WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md).

Consumer work preserves existing branches, staged state and unrelated changes.
The K2 cashier is excluded. Published tags and archives are never replaced.
