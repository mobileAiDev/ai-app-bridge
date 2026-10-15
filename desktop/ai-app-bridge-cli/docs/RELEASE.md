# 0.4.16 coordinated release

CLI/MCP, Android SDK/plugin and optional executors, iOS, Flutter and Web use
0.4.16 together. This patch corrects fresh retained-history pagination when
the action and UI partitions have different retention boundaries.

## Changes

Previously, a fresh Script inventory or long operation-history read could
return `cursor_expired` on its second internal page even when no evidence had
been evicted during the read. The first mixed page could end before another
selected partition's already-existing retention boundary.

Evidence lists and archive exports now scan each selected partition with its
own signed continuation, retain the initial sequence boundary and merge facts
in order. Actual eviction during the read, bad cursors, missing chunks and
archive consistency failures remain explicit. Missing history and unknown
device outcomes are preserved; no action is replayed by this change.

Android, iOS, Flutter and Web changes align release metadata. Native binaries,
the v1 store format, low-level retention semantics and Node-API 8 are unchanged.
The explicit Maven mirror configuration validated for 0.4.15 is retained.

## Validation and limits

The correction passes 211 related regressions. Independent review includes
asymmetric retention, a newly appended-facts counterexample, actual eviction,
cursor signatures, large-record chunks, recovery and archive boundaries.

On a consistent copy of the real long-lived store, public 0.4.15 reproduces the
failure; the candidate matches all 14,682 retained action/UI facts and recovery
views for 401 original Script operations against independent retained facts.
On the completed OPPO test store, four inventory pages, ten original Script
IDs and recovery views, and ten offline-verified archives also match. The
original unknown action and missing Host receipt remain visible after a
successful verification-only continuation. These are correctness checks,
not a new throughput claim.

Public 0.4.15 root OPPO acceptance covers eight Native/H5/Flutter, JavaScript,
Python, Intent and fault-recovery scenarios. Those device results are inherited
within the unchanged SDK/execution boundary, not claimed as newly repeated
0.4.16 business flows. Five final screenshots retained transition frames;
complete UI login, booking, payment/refund and whole-App coverage were not
established. See the repository's release-verification reports for exact
package, device and evidence identities.

Existing Windows x64, macOS arm64/x64 and Linux glibc arm64/x64 Host acceptance
is inherited from 0.4.14 within its unchanged native boundary. Windows physical
display/sleep testing remains deferred. Windows ARM64 and Linux musl are
outside the validated native matrix. WDA and iOS build tools require macOS.

## Release procedure

Freeze reviewed source and exact archives after applicable checks pass. Publish
a new immutable Git tag and verify all public Maven artifacts before publishing
the other channels and upgrading Android consumers. Verify npm, Pub, GitHub
downloads and SwiftPM resolution against frozen inputs. Preserve unrelated
consumer changes and use public coordinates. Check the installed CLI and the
actual resident MCP/Runtime separately; fresh installed files do not prove that
an existing process has reloaded.
