# 0.4.17 release verification — 2026-10-16

Scope: [validation audit](VALIDATION_AUDIT_2026-10-16.md), shared Runtime
admission, provider/target checks and the two pending power fixes. The base is
`9d1f7466df44e84eb89ddb4b0f89f743a4a3fe68`; POS source was not changed.

## Prepublication verification

- Host functional: 1,925 passed, 23 platform-conditioned skips, 0 failed.
- Host isolated performance/timing suite: 50 passed, 0 failed.
- Android SDK unit tests: 221 passed; UIA JVM tests: 50 passed. Runtime bundle
  rebuilt and all eight Android Maven modules published to a local staging repo.
- Flutter: 82 passed and analyzer clean. Swift: 82 passed. Web: 43 passed,
  including key-order tolerance and actual target/connection mismatch rejection.
- Canonical H5 renderer: all four generated platform copies match.
- Unsigned generic iOS SDK consumer, Flutter CocoaPods consumer and prepared
  WDA Runner build-for-testing all succeeded. No physical iOS acceptance claimed.
- CLI tarball: clean npm install without compilers/Python, bundled native addon,
  126-command discovery, CLI/MCP continuation, execution and recovery contracts
  verified. WDA clean tarball preparation verified 193 runtime files and eight
  WDA source files. Both package checks used SHA-256
  `3e753e4e2296f924ff99a705ae3425f485f6175f897cb5d9849e9b1b1189a270`.
- macOS delayed polling: public 0.4.16 reproduces missing-confirmation failure
  with the controlled clock; the candidate confirms a fresh owned-PID sample
  and still rejects foreign assertions. Real macOS acquire/renew under repeated
  event-loop stalls also passed. The original long-history data-copy harness
  was unavailable; that exact historical run is not claimed as repeated.

The first full run exposed stale expectations and two archival test fixtures
missing the already-required partition status. Those fixtures now implement
that contract. A 35 ms deadline test could count a started read after its last
successful result; its assertion now directly verifies that guidance performs
no extra I/O. No production evidence-integrity check was removed for these tests.

## Publication

Published source is immutable tag `0.4.17`, commit
`2cbe03a785c843acb198e88e0640074b5f9fc74d`, including power commit `6ac2e1c`.
All public channels and local upgrade checks below are complete.

- JitPack built the exact tagged commit. All eight modules' 16 POM/AAR/JAR
  artifacts and both relocated Gradle plugin markers are public HTTP 200.
  Coordinates and internal dependencies are 0.4.17; all 341 class hashes match
  the local reference build.
- npm CLI and Web archives were downloaded anonymously and match the frozen
  archives byte for byte. Both `latest` and `next` are 0.4.17. CLI SHA-256 is
  `3e753e4e2296f924ff99a705ae3425f485f6175f897cb5d9849e9b1b1189a270`;
  Web is `b636186580e21e9ceb4bbbaadcc16abb627fb2883028b03d62d522d24221a132`.
- Both Pub packages are public at 0.4.17. Their 61/6 archive files match the
  frozen exports. A hosted consumer resolves both from pub.dev, its lock hashes
  match those public archives, and Flutter analysis passes. The first consumer
  resolution saw a cached 0.4.16 version list; refreshing that metadata resolved
  the published version without changing its dependency constraints.
- A fresh public SwiftPM consumer resolves exact 0.4.17 to the tagged commit;
  its unsigned generic iOS build passes and source hashes match the frozen SDK.
- The [GitHub release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.17)
  is public and latest. Both downloadable npm archives and SHA256SUMS match
  the frozen files.
- [Linux x64/arm64 and Intel macOS CI](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38876855013)
  passes. [Windows CI](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38876859250)
  passes on an unchanged second attempt. The first attempt failed only in the
  temporary-directory cleanup hook with EPERM after the assertions completed;
  that initial failure log is retained.

## Installed and resident verification

The global CLI was installed from npm at 0.4.17; all 250 archive files match the
public tarball. The installed skill matches its packaged source. The user
explicitly authorized interruption of shared work for this upgrade. The old
Runtime was stopped, and old MCP processes were reconnected to the new package.

The actual Codex MCP reports Runtime 0.4.17 and `compatible:true` with the
original differing configuration fingerprints (`e23f4f8c…` versus `2fdd4eae…`).
An actual MCP Script completes a Runtime query with that same compatible
version. All 410 pre-upgrade retained Script IDs remain queryable in inventory;
the verification Script adds one new ID. Original operations were not replayed.

The OPPO UIA executor was explicitly restarted to load the rebuilt bundle.
Actual MCP UIA observation then reports complete source coverage, with its
20-node projection intentionally limited by maxNodes. A 1080×2414 display
screenshot also succeeds. K2's separate sample returned no accessible windows
and an Android power-worker failure; it is not claimed as device acceptance.

## Common consumer projects

Seven dependency references were updated to public 0.4.17 across POS, Reader,
the current Duo `clone-master` checkout, and MeasureDevice. All seven
resolution/build checks pass, producing six debug APKs:

- POS `sitDebug`;
- Reader and Duo `debug`;
- MeasureDevice app and receiver `debug`;
- MeasureDevice protocol-lab `debug`.

All eight resolved Bridge dependency occurrences match the public artifact
hashes. The Bridge Web smoke consumer also installs public 0.4.17 and passes its
load check. Consumer heads, branches, staged patches and unrelated dirty or
untracked files remain unchanged. These dependency updates remain in the
consumer working trees; no consumer APK was installed and no business-flow
acceptance is inferred from compilation. The previous Duo worktree path no
longer exists; the current checkout was inspected before editing.

The native FactStore binaries, Node-API 8, disk format and WDA upstream version
are unchanged. Windows physical sleep, physical iOS, UIA refs retained longer
than 60 seconds on a phone, and POS business acceptance are not newly established
by this release.

Detailed logs and frozen package evidence are under the local release-evidence
folder `0.4.17-2026-10-16`, adjacent to the repository. Public artifacts,
installed files and resident execution were verified separately.
