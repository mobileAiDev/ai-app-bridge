# 0.4.10 coordinated release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.10 together. Device/Web protocol identities and the private FactStore
component version remain unchanged. Public-channel verification is recorded
separately in `docs/RELEASE_VERIFICATION_0.4.10_2026-10-15.md` in the repository;
source version numbers alone do not establish publication or device acceptance.

## Changes

- Script recovery exposes command names, optional caller labels, original
  dispatch markers and receipts through `ctx.recovery()` and the public
  `recovery` operation. `inventory` lists retained work needing inspection.
  Read-only queries preserve unknown outcomes and do not replay effects.
- Checkpoint recovery supports independent recording attempts. Repeated Host
  or program crashes retain the original recovery boundary until the program
  commits a new checkpoint; retained unknown receipts remain discoverable even
  when their earlier markers have expired.
- `ctx.assert({coverageScope:"observed", ...})` explicitly tests returned values
  from partial/unknown observations. Default complete-source checks and
  identity/freshness checks remain; this cannot prove whole-App absence.
- Bounded work power leases use native Host/device mechanisms. Actual activity
  owns a ten-minute idle window; workflows additionally own their deadline.
  Clients may disable automatic protection or acquire/release explicit leases.
  Failure is diagnostic and does not veto App operations. iOS scope is the
  foreground SDK App, and Windows physical validation remains outstanding.
- Android Flutter profile initialization and its native dependency are enabled
  explicitly with `--dart-define=AI_APP_BRIDGE_PROFILE=true`. Debug defaults stay
  unchanged; release initialization remains disabled.
- Web DOM failures retain their known diagnostics instead of being turned into
  unknown execution. Usage guidance routes ordinary screenshots/ADB/tree work
  through Bridge without unnecessary second UiAutomation connections.

## Acceptance boundaries

Detailed evidence and retained failures are in the repository documents
`docs/OPTIMIZATION_EXECUTION_2026-10-15.md`,
`docs/IOS_DEVICE_REGRESSION_2026-10-15.md`, and the external
`optimization-next-2026-10-15/` evidence directory. This release does not claim
universal speedups or one-minute coverage of unfamiliar applications.

Android mixed workflows, actual OPPO flows, Web Memos and Host crash/recovery
were exercised. Some Android capture experiments used an isolated candidate
APK/CLI and are kept distinct from the shipping package. Flutter's 32-run matrix
completed 31 business flows; one debug network failure remains unexplained,
while all 12 profile runs passed. A separate explicit timeout-and-retry workflow
passed and does not replace the failed sample.

On iPhone, SDK Native/H5 actions, Kiwix Intent and a continuous JavaScript flow
ran; the latter took 73.885 seconds for 34 device calls, 18 assertions and four
screenshots. Twelve physical iPhone power checks passed. The user disconnected
the phones and requested release closeout before iPhone Python, Flutter,
independent database and unknown-effect recovery tests completed. Those scopes
remain unverified. No cashier device was substituted. Windows implementation,
review and automated protocol checks are included; real Windows testing was
explicitly deferred by the user.

Console screenshots, portable visual readiness, persistence group commit,
general exploration export and device UI mirrors are not shipped in this
release. Their experiments and adoption limits remain documented. Existing
0.4.9 Host speedups retain their original evidence and are not recounted as new
0.4.10 gains.

## Release procedure

Freeze the reviewed source, run automated and clean-package checks, then
publish the exact archives and matching Git tag. Independently compare public
npm/Pub/Maven/Swift contents and update current consumer dependencies from
public coordinates. Preserve historical test versions, private component
versions and unrelated consumer changes. The installed CLI and a newly started
MCP must be checked separately from an already connected desktop process.
