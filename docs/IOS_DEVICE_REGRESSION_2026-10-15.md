# iOS device regression and power verification — 2026-10-15

This is the historical pre-publication candidate session. After publication, the
user reconnected the same iPhone and authorized the omitted checks on `0.4.10`.
That separate session is tracked in sibling
`ai-app-bridge-release-evidence/0.4.10-device-supplement-2026-10-15/ACCEPTANCE_MATRIX.md`.
Its new results do not change the failed or not-run outcomes below.

This records the tested **0.4.9 source candidate**, including the uncommitted
power and observed-evidence assertion changes. A later version bump does not
turn these records into a second device run. Evidence root:
`../ai-app-bridge-release-evidence/optimization-next-2026-10-15/`.

The selected device was iPhone 18 Pro Max, iOS 27.0.1 (24A446), UDID
`00008160-001465A81E400036`. Development pairing, Developer Mode, device-specific
signing and developer trust completed. Only the independent test bundles
`io.github.mobileaidev.aiappbridge.iossample`,
`io.github.mobileaidev.aiappbridge.wda.xctrunner` and
`io.github.mobileaidev.kiwix.sample` were installed. No existing user App was
removed. No cashier device was used.

## Results

| Function | Result and evidence |
| --- | --- |
| iOS SDK display power | **12 checks passed** on the physical sample App; `ios-device/power-real-report.json`. Two overlapping leases, independent platform renewal, last-owner restoration, work expiry, expired-lease rejection, CPU-mode rejection, Host SIGKILL/SIGSTOP, and foreground exit. This covers the selected SDK App's idle timer, not external Apps or background CPU protection. |
| Native sample | Real WDA click and Chinese replacement input observed. First visible click: `17-visible-native-tap.json`. The initial Script `script-1792033589241-1` failed an assertion because WDA tree completeness was unknown; the actual replacement was visible in `sample-visible-js/call-3.json`. This initial Script is retained as failed. |
| WKWebView sample | Chinese H5 input and the resulting `Web button tapped` text were read back; all nine calls succeeded and `sample-h5-continuation/visible-result.png` was captured. Script `script-1792033728393-2` nevertheless failed its last test-code check: it expected `outFile`, whereas the screenshot command returned `destination`. This is not reported as a successful Script. |
| Kiwix Intent | **Completed**, original ID `intent-1792034174602-1`, revision 16. Native archive/search → article → save bookmark → H5 Greenhouse gas link → cancel adding that second bookmark → return and observe saved Climate change bookmark. `33-kiwix-intent.json` through `50-kiwix-intent-complete.json`. About 424 seconds of interactive work, including agent decision time; not a throughput benchmark. |
| Kiwix JavaScript | **Completed**, original ID `script-1792034651753-1`, 73.885 seconds wall time, 34 device calls, 18 passed assertions, four screenshots. Existing bookmark removal → native search → save → actual H5 navigation → cancel second bookmark → close WDA session → actual App restart, PID 867→877 → reopen the persisted bookmark and read its article DOM. `kiwix-js-1/report.json`. |
| Evidence archive | Original JS terminal result retained; exported recording and recorded payloads verified successfully in `kiwix-js-1/archive/`, `verify.json` and `report.json`. This is archive verification, not device unknown-action recovery. |
| Independent database oracle | **NOT_RUN**. The phone was unplugged before the quiescent Core Data copy. UI-after-App-restart persistence is proven; exact SQLite row count/fresh timestamp is not. |
| iPhone Python Script | **NOT_RUN**. Source prepared, no execution started. |
| iPhone Flutter/Flexify | **BUILD_ONLY / NOT_RUN**. Current-SDK Debug artifact signed for this UDID and strict/deep codesign verified. No installation, launch or Flutter business action. See `profile/ios-flutter-handoff/HANDOFF.md` and its artifact/source manifests. |
| iPhone Script cancel / askAgent / unknown original identity recovery | **NOT_RUN** in this device session. The Kiwix bookmark-sheet cancellation is a business UI cancellation, not Script cancellation. Web recovery evidence must not be presented as iPhone recovery acceptance. |

## Assertion correction and preserved failures

WDA does not establish completeness of the whole returned UI tree. The initial
sample assertion therefore became `inconclusive` despite a visible matching
input value. The Host now supports explicit `coverageScope: 'observed'` for
checks of the content actually returned. The default still requires complete
coverage. Stale, altered, failed or uncommitted evidence remains rejected.
The Kiwix JS run verified this correction on the phone: Native assertions retain
`coverage.status: 'unknown'` and `gap: true` while declaring their observed
scope. H5 DOM records keep their own complete coverage. No SDK tree was
relabeled complete.

Other preserved preparation failures include an old-device provisioning
profile, initial developer trust/lock readiness, a SpringBoard wireless-data
prompt, one Intent `text`/`value` argument mistake rejected before action, and a
Runtime source-fingerprint mismatch while code was changing. Corrected
preparation is not counted as business success or performance benefit.

## Stop and cleanup

The user disconnected both phones and explicitly ended device work. The last
already-issued close request (`51-kiwix-js-close.json`, 11:30:03.564–11:30:04.012
Asia/Shanghai) returned `ios_tunnel_unavailable`, `dispatched:false`,
`ambiguous:false`. It did not confirm device-side session closure and was not
retried. No database copy, Python execution or Flexify installation followed.

The owned Host Runtime PID 78962 was identity-checked and killed locally to
stop observation and automatic renewals without any further device call.
Owned WDA Host PID 66425 had already exited. Root task caffeinate PID 20918
was preserved. `ios-device/cleanup-after-user-unplug.json` records the cleanup.
The final device assertion was not queried after unplugging; its short platform
TTL remains the release bound. Test Apps and the test Kiwix bookmark remain on
the disconnected phone; no deletion was attempted.

## Power implementation review and remaining limits

The implementation separates logical work deadlines from native assertion
renewal, owns one assertion/process or SDK UUID per lease, and reports failed
or unconfirmed release without claiming success. iOS `/v1/power` preserves
existing runtime authentication and epoch binding, runs UIKit work on the main
thread, restores the prior idle-timer setting after the last owner, and drops
protection on foreground loss. Canonical and Flutter Swift sources are tested
for parity. This review found no additional must-fix product defect.

`power/final-host-targeted.tap`: 36/36 focused Host checks passed after the
device stop; fake adapters/child workers only, with no device access.
`power/swift-mirror-test.log`: 5/5 power and source-parity checks passed earlier.
The root task owns broader integration, packaging and release gates.

macOS actual assertion ownership, replacement, parallel release, Host crash
and timeout were tested (`power/macos-report.json`); the root's existing
assertion prevented an isolated whole-Mac sleep comparison. Android was
tested on isolated API 36 emulator 5600, including unplugged/plugged display,
CPU-only display-off behavior, negative sleep control, exact screenshots and
unchanged draft/order state, crash/stall/transport loss and setting restoration
(`power/android-report.json`). It is not physical OEM/Doze acceptance. The
final Android helper adds coverage-description fields after that device run;
the final jar was rebuilt and hash-manifest checked, but those metadata fields
were not re-read from a device. Windows is implemented and protocol/lifecycle
tested with injected workers on macOS; **Windows system API execution remains
unverified until the agreed post-release Windows test**.

No adapter injects business input or changes global security/power policy.
Explicit manual sleep/lock, lid behavior, device management, background iOS
CPU execution and arbitrary external-iOS-App protection remain outside scope.

## Subsequent authorized physical supplement

The stop above is the original publication checkpoint. The user later reconnected
the phones and authorized the omitted checks. Kiwix Python, cancellation,
interactive decisions, original-action crash recovery and the independent
bookmark oracle completed. Flexify's real workflow, deliberately wrong expected
value, independent SQLite oracle and real process-restart persistence completed.

This new run exposed a real Host renewal-context bug that the earlier direct SDK
and substitute-worker checks did not cover. The unpublished timer repair passed
75.017 seconds without touches. A combined candidate then recovered one ended SDK
assertion after one actual Kiwix restart, kept the original deadline, and passed
75.012 seconds without touches. These results supersede the earlier claim that
the narrower review found no additional defect; they do not change public 0.4.10.

Actual permission handling completed, but its 423.582-second takeover remains a
usability gap, and the 95.607-second Flutter workflow is not a new speedup claim.
Root retains separate work-level leases beyond subtask completion. Windows still
has only implementation/protocol review, with native API execution deferred.
See [the physical supplement](PHYSICAL_DEVICE_SUPPLEMENT_0.4.10_2026-10-15.md)
for exact evidence, scopes, retained failures and remaining release gates.
