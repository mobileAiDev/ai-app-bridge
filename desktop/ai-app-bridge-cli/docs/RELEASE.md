# 0.4.13 coordinated patch release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.13 together. Device/Web protocols and the private FactStore version are
unchanged. This release carries the Host execution repairs prepared in 0.4.11
and separates Android Maven publication from the regression suite.
SDK execution behavior differs from 0.4.11 only in version identities.

## Changes

- Build Maven publications through `clean publishToMavenLocal`. Gradle still
  compiles and packages each publication and generates its metadata, but the
  publication service no longer also runs the unrelated `build` lifecycle.
  Tests and Lint retain their independent commands and results; a successful
  publication does not imply that a previously failed test passed.
- Verify log-pressure persistence against records actually accepted by the
  bounded queue. Higher offered load can legitimately produce more rejected
  records and equal disk usage. The tests retain resource measurements and now
  check persisted payloads, partitions and sequence numbers after reopening the
  store, including a deterministic paused-writer case. Production queue limits
  and persistence behavior are unchanged.
- Give the Android build an explicit 2 GiB Gradle heap, 512 MiB metaspace budget
  and two-worker limit. The previous public build used the default 512 MiB heap
  and produced incomplete Lint results after a heap-space failure.
- Keep power renewal outside the asynchronous scope of a completed command.
  Previously, iOS renewal could fail with `runtime_stopped` while the logical
  work lease was still live.
- Add explicit `recovery:"reacquire-ended"` for a selected iOS SDK target.
  Automatic work chooses this policy; explicit leases default to manual.
  A confirmed ended assertion gets one replacement on the normal heartbeat,
  preserving the target and original deadline. Transport, identity and
  foreground failures remain visible; there is no action replay or unlock.
- Reflect a confirmed power-worker exit immediately, retain its original
  cause, and prevent an old handle from invalidating a replacement. Preserve
  normal release and expiry outcomes.
- Bound Android power-helper uploads even when the selected ADB transport
  ignores SIGTERM. After the existing ten-second deadline, terminate only that
  owned transfer process so it cannot hold acquisition and shutdown indefinitely.
- Supply concise, schema-valid WDA session and transport diagnosis for the
  original connection. Unknown effects first query their original action ID
  and epoch; guidance does not start sessions or replay actions.
- Document parent-task ownership of explicit power leases across command
  return, analysis and subtask completion.

## Validation and limits

The execution candidate passed 1,855 functional tests, 50 performance tests
and clean-package CLI/MCP/Script/recovery checks. A physical iPhone confirmed
one App restart, one heartbeat assertion replacement in 479 ms, and a further
75.012-second foreground interval without touch input; release restored the
prior idle setting. The later worker-exit repair passed actual child-process
tests on macOS. These scopes have separate source identities in the evidence.

The unchanged device SDKs also received post-0.4.10 physical supplement checks:
Kiwix Python/native/H5 and recovery, Flexify persistence and restart, and OPPO
Native/H5/Flutter-search workflows with independent business-state checks.
Those are bounded workflows, not whole-App or universal speed claims. iOS
permission takeover remains a usability gap; this patch does not claim a new
fast permission workflow or protection for arbitrary external iOS Apps.

Windows full Host support is not implemented: the bundled native store rejects
Windows installation. The Windows power adapter source and protocol tests do
not establish a working Windows CLI or real Windows API behavior.

The unchanged Host/Web implementation also passed the 0.4.12 source checks:
1,857 functional tests, 50 performance tests, 38 Web tests and clean-package
verification. The Android local full build passed 498 tests and Lint, while
the public 0.4.12 build failed a five-second capture-attachment test wait.
That remote failure is retained and investigated separately from publication.

The repository records detailed evidence in
`docs/PHYSICAL_DEVICE_SUPPLEMENT_0.4.10_2026-10-15.md` and publication checks in
`docs/RELEASE_VERIFICATION_0.4.13_2026-10-15.md`. The partial 0.4.11 publication,
its three Maven attempts, the failed 0.4.12 Maven build and earlier release evidence are retained. Existing
public tags and packages are not replaced.

## Release procedure

Freeze reviewed source and exact archives; run package/version checks and publish
the matching Git tag. Independently compare public npm/Pub/Maven/Swift contents
and upgrade consumers from public coordinates. Preserve historical evidence,
private component versions and unrelated consumer changes. Verify the installed
CLI and a fresh MCP process separately from any already connected desktop process.
