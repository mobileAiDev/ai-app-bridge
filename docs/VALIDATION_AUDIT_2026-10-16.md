# Execution validation audit — 2026-10-16

Requirement: unrelated environment and presentation differences must not stop
usable commands. Keep a gate only when dispatch without it can use another
route/target, violate an explicit operation contract, or misreport execution.
The scope is the shared Host and Android, iOS, Flutter, H5 and Web entrypoints.

| Area | Decision and reason |
| --- | --- |
| Shared Runtime | Remove global build/config equality; keep authenticated endpoint, protocol and OS-held owner lock. Different fingerprints do not prove a request cannot run. |
| Provider configuration | Check explicit conflicting ADB routes only at new Android dispatch. A serial can identify different phones on different servers. Other platforms and original recovery are independent. |
| Cache/dependencies/cwd | Locate/diagnose owners without validating unrelated cache choices or requiring the client to have every execution dependency. Open/build/file operations enforce their actual prerequisites. Absolute request cwd remains part of path interpretation. |
| Android inventory | Unknown inventory does not mean disconnected; independently try requested diagnostics. Known offline/unauthorized devices remain reported. |
| iOS readiness | Stale readiness summaries are advisory; descriptor identity and actual endpoint responses decide. |
| Build preparation | Flutter stable-version regex and Android preview/AGP preflight estimates cannot reject an otherwise successful build. Pub constraints, Gradle metadata, module/variant/artifact identity and actual errors remain authoritative. |
| Installed APK | Remove directory/filename assumptions. Preserve exact SHA and unsupported multi-split identity reporting. |
| UIA | Remove age-only expiry; keep bounded snapshot retention, original accessibility source, window, boot/runtime epoch and actual operability. |
| Android native | Disabled parent is not a disabled child. Keep selected-node enabled state, visibility, clipping and original window/object. |
| iOS native | Label/identifier drift on the same UID/type is advisory. Explicit selectors, session/app, original element and current operability remain enforced. |
| Flutter | Remove dynamic text/value/semantics from reference guards. Keep Element/controller/FocusNode/ScrollPosition/view and live editing/gesture prerequisites. iOS Intent sends the observed ref to the SDK rather than reselecting it at Host. |
| H5 | Permit focus formatting on the same editor and scrolling disabled controls. Keep DOM/document identity, replacement/navigation, editability, visibility and hit testing. |
| Web | Compare binding/target identity by field values, independent of JSON key order. Keep epoch, connection, target, action identity and cancellation/receipt rules. |
| Power | Confirm the owned PID's current OS assertions after scheduling delay. Historical errors do not overwrite successful status/release commands; missing/foreign assertions still fail. |
| Existing advisory behavior | Foreground-package mismatches and presentation drift already had advisory paths; these are not claimed as new. |
| Retained constraints | Required command fields and explicit permissions; unique selector choice; original target/runtime identity; device ownership and unfinished actions; cancellation/settlement proof; storage signatures, record/chunk/archive consistency; actual platform minimums and WDA patch-source contract. Removing these can misdirect work or produce false success. |

The audit changes existing ownership layers rather than introducing a second
compatibility or policy framework. Tests pair tolerated variation with actual
replacement, ambiguity, wrong-route, invalid-protocol and missing-proof cases.
Two archival test fixtures were updated for the existing partition-retention
status/read contract; the production integrity checks were not relaxed.

This is a scoped source and regression audit, not proof that every future
platform version or business workflow is supported.
