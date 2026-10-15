# 0.4.11 coordinated patch release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.11 together. Device/Web protocols and the private FactStore version are
unchanged. SDK changes only align version identities and dependencies; the
execution repairs are in the Host.

## Changes

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

The repository records detailed evidence in
`docs/PHYSICAL_DEVICE_SUPPLEMENT_0.4.10_2026-10-15.md` and publication checks in
`docs/RELEASE_VERIFICATION_0.4.11_2026-10-15.md`. Public 0.4.10 remains immutable.

## Release procedure

Freeze reviewed source and exact archives; run package/version checks and publish
the matching Git tag. Independently compare public npm/Pub/Maven/Swift contents
and upgrade consumers from public coordinates. Preserve historical evidence,
private component versions and unrelated consumer changes. Verify the installed
CLI and a fresh MCP process separately from any already connected desktop process.
