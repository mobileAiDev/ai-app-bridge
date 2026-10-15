# 0.4.12 release verification

Status: preparing and validating the coordinated recovery release. The user
authorized a new unified version after the third public Maven build of 0.4.11
failed. No public 0.4.12 channel is claimed available yet.

Evidence root: sibling `ai-app-bridge-release-evidence/0.4.12-2026-10-15/`.

## Scope and cause

The third public 0.4.11 build reached compilation and tests. Its release unit
suite failed the log-pressure test's assertion that disk usage must strictly
increase with offered record count. The same test explicitly allowed bounded
queue rejection, and preallocated segments also make disk usage stepwise. The
new deterministic case pauses the real mapped-store writer: both higher tiers
can fill the same byte budget and occupy the same disk space. Verification now
uses accepted records and checks their content, partition and sequence after
closing and reopening the real store. Queue limits and production behavior are
unchanged.

The public build also reported Lint heap exhaustion under the default 512 MiB
Gradle heap. The root build now explicitly budgets 2 GiB heap, 512 MiB metaspace
and two workers. A local single-module 512 MiB Lint run passed against an isolated
Android 35 SDK view; that local result does not reproduce or explain away the
public failure. The new full build and public result remain separate gates.

The earlier Host power/WDA repairs and their bounded physical-device evidence
are carried forward from 0.4.11. There is no new whole-App speed claim or
device-execution behavior change in this patch. See
[the physical supplement](PHYSICAL_DEVICE_SUPPLEMENT_0.4.10_2026-10-15.md) and
[0.4.11 publication evidence](RELEASE_VERIFICATION_0.4.11_2026-10-15.md).
Windows normal CLI installation is still not implemented; see
[the Windows plan](WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md).

## Required gates

- Android deterministic old-assertion failure reproduced; eight corrected
  regressions passed, then 10 independent JVMs passed 80/80 checks and verified
  60,907 accepted records after reopening the store.
- Original Android AGP/Lint full build using the Android 35 SDK view: passed in
  173.680 seconds; 498/498 unit tests, Lint zero errors/13 warnings and no heap
  exhaustion. Eight Maven modules/16 artifacts and 341 classes were audited.
- Host functional 1,857/1,857, performance 50/50, Web 38/38 and clean CLI package
  checks passed. Swift/Flutter and generic iOS validation continue independently
  of the Android public build.
- Reviewed source and immutable tag, public Maven 16-artifact parity: pending.
  This gate precedes the remaining 0.4.12 public channels.
- npm, Pub, GitHub assets and remote SwiftPM content/integrity checks: pending.
- Local CLI, installed skill, actual Codex MCP and Web smoke dependency: pending.
- Four consumer projects: seven version references now target 0.4.12; public
  dependency resolution, seven Gradle checks and six APK checks remain pending.

Consumers retain their branches, staged state and unrelated changes. No consumer
commit, push or device installation is included. The K2 cashier is excluded.

The first concurrent SDK run exposed separate test assumptions: Swift pressure
tests expected every offered record to be accepted despite the bounded queue,
and one Flutter deadline fixture expected DOWN/cancel even when its 20 ms budget
expired before DOWN. These failures are retained and are being diagnosed in an
isolated validation snapshot. They are not attributed to the Maven service and
are not silently removed from the frozen source. Runtime findings and any later
test-harness changes must be reported with their own source identities.
