# 0.4.14 coordinated release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.14 together. This release adds Windows x64 Host implementation and repairs
Host process lifetimes.
Linux and Intel Mac were already supported in 0.4.13; their checks are regressions.

## Changes

- Add a Win32 implementation of the embedded FactStore's platform boundary:
  Unicode paths, mapped-file flushes, kernel locks and file publication. Preserve
  the v1 record format, commit order, corruption recovery and Node-API 8 interface.
  Ordinary installation loads a verified bundled binary without compiling it.
- Publish Host ownership and evidence files through a flushed, write-through
  rename on Windows. Exclusive creation remains exclusive. Removing an owner
  first retires its active name; interrupted cleanup may leave inert retired
  bytes. Required I/O failures remain visible.
- Execute Windows command shims and Gradle wrappers with literal arguments.
  Python Script's protocol uses UTF-8 independently of the console code page.
  A missing executable, a created shell and a lost completion receipt retain
  their distinct dispatch and ambiguity facts.
- Attach unfinished Windows Script and command workers to individual Jobs before
  starting requested code. Cancellation and Host death own those unfinished
  trees. A complete ordinary-command receipt releases tool daemons, including
  after a nonzero exit. Script release requires a returned result and normal SDK
  exit. Independent controllers survive long enough to persist their result.
- Check the process creation identity through the same handle used for a forced
  stop. On cancellation, seal the owned Job against new children and wait for its
  process handles to signal before reporting cleanup complete. Keep original
  cleanup errors alongside the command's primary failure without replaying work.
- Finish and send a Runtime stop reply before closing outstanding connections,
  so an idle request cannot keep the stopped process alive.
- Mirror the C platform header into the iOS, Flutter and WDA source packages.
  Swift/Flutter test maintenance checks accepted records and actual action
  phases instead of assuming offered records were accepted or a timeout always
  happened after DOWN. Production queue limits and action deadlines are unchanged.

## Validation and limits

Native format/recovery/golden tests and actual installed package checks passed
on Windows x64, macOS arm64/x64 and Linux glibc arm64/x64. The final Windows Host
run passed 206 cases, failed none and skipped two POSIX-only cases. Cancellation
passed 20 immediate-completion repetitions and three nested-process stress
repetitions. Intel Mac and both Linux targets each passed 369 shared Host checks,
failed none and skipped one platform-specific case. Detailed results, prior
failures and source identities are recorded in
`docs/WINDOWS_HOST_VALIDATION_2026-10-15.md`.

Windows power API and lease lifetime tests run on a Windows CI runner. Physical
display/sleep testing on the user's Windows computer remains deferred. The
adapter prevents idle sleep while its assertion is active; it does not unlock a
password-protected screen or override explicit manual sleep.

The device/Web behavior from 0.4.13 is inherited within its original acceptance
scope. This release makes no new whole-App speed claim and does not substitute
Host/package checks for new Android/iPhone business-flow acceptance. WDA and iOS
build tools still require macOS/Xcode. Windows ARM64 and Linux musl are outside
the validated native matrix. Existing unknown device outcomes, iOS permission
usability limits and earlier Android remote-test failures retain their recorded
boundaries.

## Release procedure

Freeze reviewed source and exact archives after the applicable gates pass.
Publish a new Git tag and matching npm/Pub/Maven/GitHub artifacts; verify public
downloads and SwiftPM resolution independently. Upgrade consumers from public
coordinates while preserving their unrelated changes. Verify the installed CLI
and actual connected MCP process separately from any older process. Existing
tags, packages and historical evidence are not replaced.
