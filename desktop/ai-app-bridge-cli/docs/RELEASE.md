# 0.4.15 coordinated release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.15 together. This release corrects evidence queries and uses a new immutable
version for public Android publication after the 0.4.14 dependency-download
failure. Existing tags and published archives are preserved.

## Changes

- Read Script/Intent evidence only from its `action` and `ui` partitions. When
  unrelated network records have been evicted, retained evidence can still be
  listed, recovered and archived across internal pages. Actual evidence gaps,
  cursor scope mismatches and changes during archive export remain explicit
  failures; previously missing history remains unknown.
- Correct installed guidance to describe the Windows x64 Host support already
  implemented in 0.4.14. Physical Windows display/sleep testing remains deferred.
- Advance the coordinated package versions. Android/iOS/Flutter/Web behavior
  and native binaries otherwise retain the implementation validated for 0.4.14.

## Validation and limits

The evidence-query fix passes 165 related checks, including multi-page retained
history, large payload chunks, actual partition loss, cursor signatures and
archive consistency. An independent review confirms the scope matches the
existing writer. No native format or low-level retention rule changes.

The 0.4.14 Windows x64 implementation covers the native FactStore, durable file
publication, literal process arguments, UTF-8 Python transport, cancellation,
completed daemon lifetimes and Runtime shutdown. Linux and Intel Mac support
predate that release. The v1 store format and Node-API 8 interface are unchanged.

Native format/recovery/golden tests and installed package checks passed on
Windows x64, macOS arm64/x64 and Linux glibc arm64/x64. The final Windows Host
run passed 206 cases, failed none and skipped two POSIX-only cases. Cancellation
passed 20 immediate-completion repetitions and three nested-process stress
repetitions. Each existing Intel Mac/Linux target passed 369 shared Host cases,
failed none and skipped one platform-specific case. These are inherited 0.4.14
results, not newly repeated 0.4.15 runs. Detailed source and artifact identities
remain in `docs/WINDOWS_HOST_VALIDATION_2026-10-15.md`.

Windows power API and lease lifetime tests ran on a Windows CI runner. Physical
display/sleep testing on the user's Windows computer remains deferred. An idle
assertion cannot unlock a password-protected screen or override manual sleep.
WDA and iOS build tools still require macOS/Xcode. Windows ARM64 and Linux musl
are outside the validated native matrix.

This release makes no new whole-App speed claim. Host/package checks do not
replace Android/iPhone business-flow acceptance. Device outcomes retain their
original identity and uncertainty; actions with unknown results are not replayed.

## Release procedure

Freeze reviewed source and exact archives after applicable checks pass. Publish
a new immutable Git tag and verify public Maven artifacts before proceeding
with the other publication channels and Android consumer upgrades. Verify npm,
Pub, GitHub downloads and SwiftPM resolution against their frozen inputs.
Upgrade consumers from public coordinates while preserving unrelated changes.
Check the installed CLI and actual resident MCP/Runtime separately. The user
requested root-device regression only after public Maven verification passes.
