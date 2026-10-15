# 0.4.15 coordinated release verification

Status: candidate preparation in progress. No public 0.4.15 publication or
root-device acceptance is claimed yet. Public Maven must pass before the other
channels and consumer upgrades proceed; root-device regression follows the
public Android artifacts, as explicitly requested by the user.

Evidence root (sibling of this repository):
`ai-app-bridge-release-evidence/0.4.15-2026-10-15/`.
The final immutable tag commit will be recorded after the candidate checks pass.

## Scope

All package versions advance together. The Host query correction limits evidence
reads to the `action` and `ui` partitions used by their writer. It prevents
unrelated network retention from invalidating retained operation history during
internal pagination. It does not relax the global FactStore cursor contract,
actual evidence retention checks, archive consistency or unknown outcomes.

Windows help is corrected to reflect the implementation already validated in
0.4.14. Native binaries and their platform boundary are unchanged; Android,
iOS, Flutter and Web implementation changes are version metadata only.
Inherited Windows and existing POSIX acceptance is recorded in
[0.4.14 verification](RELEASE_VERIFICATION_0.4.14_2026-10-15.md) and
[Windows validation](WINDOWS_HOST_VALIDATION_2026-10-15.md).

## Completed preparation

- Coordinated version checks: 39 pass across 28 changed version files.
- Initial isolated Maven publication: 26.239 seconds, eight modules, 16 main
  artifacts and 341 class hashes verified. Its 263-task graph excludes the test
  and Lint lifecycle. The snapshot contains 168 files; this is a local packaging
  result, not a successful public build.
- Evidence-query correction: 165 related tests pass, none fail or skip, including
  six new regression/negative-control cases. An independent read-only review
  confirms legitimate evidence and large payload chunks remain covered; actual
  evidence gaps, cursor signature errors and concurrent archive changes still
  fail explicitly. The unfiltered FactStore query contract remains unchanged.
- CLI: the exact 0.4.15 tarball passed the complete clean-package gate, including
  compiler/Python-denied installation, first/repeated npx, CLI/MCP sharing,
  JavaScript/Python, original-operation recovery, controlled UIA/ADB and
  cancellation/Runtime shutdown. All 248 packaged files and modes match source.
  The gate used controlled devices only.
- Web: all six tarball files and modes match source.
- SDK: 160 inputs frozen; 31 canonical iOS/Flutter and three WDA mirror checks
  passed. Both Pub dry runs completed without warnings; unsigned generic iOS
  consumers built from SwiftPM and Flutter CocoaPods exports in 21.654 and
  26.656 seconds. These builds compiled the private platform header. Prior
  82-case Swift and 82-case Flutter tests are reused within their verified source
  boundaries, not claimed as newly rerun device tests.
- Four Android consumers remain at their previous public dependency versions.
  Their repository/index/unrelated changes were preserved. Public artifact
  verification is a required gate before dependency updates.
- The remote Web example remains on the already verified public 0.4.14 package
  until public 0.4.15 can update its manifest and lockfile together.

Public download verification is recorded separately as each channel finishes.
The explicit JitPack mirror candidate passed an isolated build with a new Gradle
user home and no dependency/transform cache: 351.274 seconds, 352 observed Aliyun
Central downloads and no HTTP 429. Eight representative POM/JAR files match
the canonical inputs byte for byte. The official Gradle distribution was reused;
this was a cold dependency-cache build, not a new wrapper download. Final output comparison passed: the 16 main artifacts preserve the eight POM
contents and 341 compiled class hashes from the normal build. Logs contain no
direct Central URL; Google and Plugin Portal remain configured separately.

The source now accepts an explicit `aiAppBridge.centralRepositoryUrl` property
in both build settings. Without it, the original `mavenCentral()` configuration
is retained. `jitpack.yml` explicitly selects the Aliyun Central caching mirror;
there is no failure-driven repository substitution. The public JitPack build is
still a separate gate and must prove availability from its own network.

## Why a new version

The 0.4.14 public Maven build failed while downloading dependencies: Maven
Central returned HTTP 429 before project source compilation. Its published
npm/Pub/SwiftPM/GitHub artifacts remain intact. A new version triggers a new
immutable build, but does not itself remove an upstream download limit.
The 0.4.14 failure log and partial publication status are retained.

## Remaining gates and limits

- Freeze and review the final candidate; tag without changing older releases.
- Verify the new public Maven POM/AAR/JAR bytes and source identity.
- Publish and verify the other channels, then upgrade local CLI/skills and
  consumer dependencies using public artifacts.
- Check the actual shared Runtime and resident Codex MCP version separately
  from the installed files.
- Run the requested root Android regression against the public release.

Windows physical display/sleep behavior remains deferred by the user. Earlier
iOS timing/permission usability limits, Android remote-test uncertainty and
deferred optimization experiments retain their original evidence boundaries.
This release does not introduce a new whole-App speed claim.
