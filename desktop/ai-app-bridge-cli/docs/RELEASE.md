# 0.4.17 coordinated release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.17 together. This release removes unrelated prerequisites from execution
and includes the pending macOS power-readiness and power-status corrections.

## Changes

A client whose ANDROID_HOME, Python path, cache profile or code fingerprint
differs from a healthy shared Runtime can use its supported commands without
restarting its tasks. The wire protocol still must match. Differences identify
the actual owner and appear as diagnostics. Explicit conflicting Android routes
are checked only for new Android I/O; original-operation recovery retains its
route and ownership. Read-only diagnosis can locate a Runtime with an invalid
client cache profile; creating that cache still validates the profile.

Android device inventory failure no longer suppresses independent probes.
iOS runtime/WDA operations try their actual endpoint instead of refusing stale
Developer Mode, DDI or tunnel readiness summaries. Flutter preparation accepts
prerelease and future version strings and lets Pub/build constraints decide
compatibility. Android preview/AGP estimates are advisory; real build errors and
their diagnostic preflight are retained. APK verification accepts any absolute
installed package path while keeping exact package bytes and split limitations.

Web compares identity fields without depending on JSON key order. Flutter
references tolerate text/value/semantics changes while retaining actual Element,
controller, focus, scroll and view identities. iOS native actions tolerate label
changes on the same UID/type. H5 input permits same-editor focus formatting and
H5 scroll permits disabled controls. Android traversal reaches enabled children
of disabled containers. UIA references expire on eviction/replacement rather
than an arbitrary 60-second age; the eight-snapshot capacity remains.

macOS power confirmation takes a fresh OS sample even after event-loop delay
exceeds the polling budget. Foreign or absent assertions still fail. A stored
lease failure remains `leaseError` in successful status/release replies rather
than changing the new command's outcome.

## Validation and limits

See the repository's 0.4.17 release-verification report and validation audit for
current test, build, package and public-registry evidence. Host fixtures and
unsigned iOS builds do not establish physical iOS or Windows sleep acceptance.
No POS login, checkout or printing flow is claimed by these changes.
Native FactStore binaries, Node-API 8 and the v1 storage format are unchanged.

## Release procedure

Freeze reviewed source and exact archives after applicable checks pass. Publish
a new immutable Git tag and verify all public Maven artifacts before publishing
the other channels and upgrading Android consumers. Verify npm, Pub, GitHub
downloads and SwiftPM resolution against frozen inputs. Preserve unrelated
consumer changes and use public coordinates. Check installed files and resident
MCP/Runtime processes separately; installation does not reload a live process.
