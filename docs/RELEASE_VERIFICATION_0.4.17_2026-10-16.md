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

Prepublication checks above are complete. Public tag, Maven, npm, Pub and GitHub
verification will be recorded here after publication; no registry success is
inferred from local builds. The native FactStore binaries, Node-API 8, disk format
and WDA upstream version are unchanged. Windows physical sleep, physical iOS,
UIA refs retained longer than 60 seconds on a phone, and POS business acceptance
are not newly established by this release.

Detailed logs and frozen package evidence are under the local release-evidence
folder `0.4.17-2026-10-16`, adjacent to the repository. Public artifact identities
and installed/resident versions must be checked separately during closeout.
