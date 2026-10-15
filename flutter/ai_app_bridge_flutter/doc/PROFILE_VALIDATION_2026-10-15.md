# Android profile candidate validation — 2026-10-15

Status: experimental opt-in source candidate. All 32 predeclared samples ran; 31 passed their business oracles. Limited emulator benefit is observed, but the full performance acceptance gate is not met. Keep this opt-in and do not advertise a general speedup. Published 0.4.9 remains debug-only. No release, commit or push was performed.

Evidence root: `/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/optimization-next-2026-10-15/profile/`. Old evidence was read and copied, never edited. This report covers Android emulator `emulator-5596` only; it does not establish physical Android or iOS profile support.

## Contract and packaging

There is one build option: `--dart-define=AI_APP_BRIDGE_PROFILE=true`. Dart initialization and the Android plugin's profile dependency both consume that option. Default debug remains enabled, unset/false profile remains disabled, and release remains disabled even with true. The Android Gradle reader rejects duplicate or non-boolean definitions. iOS profile stays disabled because the bundled Swift runtime is behind `DEBUG`.

The unchanged 0.4.9 source was archived at commit `57a5ab3db3b109bcc877970daa075f714ef03673` in `baseline-source`. Its real profile APK reports `AAB_INITIALIZE_PROBE={ok: false, error: flutter_runtime_shutdown}` and has no bridge endpoint or `AiAppBridgeInitProvider`. See `baseline/` and `baseline-profile.apk.manifest.txt`.

Final packages were built with `/Users/macbook/sdk/flutter` (Flutter 3.47.7, Dart 3.13.5). `final-artifact-inventory.json` records hashes, size, provider and AOT/kernel contents. Both profile=false and release+true were installed, app data cleared and launched on 5596; both report shutdown. Their merged manifests omit the provider. This includes a clean release build, without skipping lint. The earlier Flutter 3.44.8 release-lint failure remains in `candidate-release-build.*`.

The older commerce sample needed a current Gradle/AGP/KGP template for Flutter 3.47.7: 9.3.1/9.1.0/2.4.0. Its evidence-only project consumes published Android SDK 0.4.9 because the SDK's local Gradle source uses an older DSL. Rejected 8.13, AGP 8.9.1 and local-SDK/AGP 9.1 attempts remain in `final-debug-*-rejected.*`. Product Android SDK sources were not changed.

For add-to-app, the define was supplied to `flutter build aar --no-release --target-platform android-arm64`, generating both debug and profile artifacts from the same source. The Native Meituan host stays debug in both arms, preserving Native OkHttp instrumentation. Its normal Gradle exclusions retain one Android SDK and Kotlin runtime. `meituan-aar-build.*`, generated POMs and both Native host build logs record this packaging path. A later Native-host property cannot change an already compiled Dart AAR.

## Observations and action contracts

`app.mode` and public `buildMode` distinguish debug and profile. Profile returns explicit `flutter_diagnostics_unavailable_in_profile` / `debug_build_required` for widgetInspector and widgetDump. On the tested harness, Semantics reports `no_root_semantics_node`; this is not replaced with an empty successful tree. Operable nodes, target references and action lifetimes remain available.

Final profile source checks pass in `diagnostics/final-profile/report.json`: operable-only availability, manual log/network/state/event records, automatic debugPrint and FlutterError. Real commerce HTTP capture is separately verified in `automatic-network-verification.json`: both modes captured four post-restart business requests with `source: flutter-httpclient-auto`, HTTP 200 and redacted authorization; three have action IDs. A startup request has no fabricated action ID. The manual network fixture is not counted as automatic HTTP evidence.

The final debug full tree exceeded the public 96 KiB delivery budget and was persisted. Its source ref is in `diagnostics/final-debug/tree.json`; `diagnostics/final-debug-extracted-valid/report.json` verifies the saved tree through explicit extraction plus current operable nodes and capture fixtures. Debug widgetInspector/widgetDump are available. An initial extraction emitted undefined optional fields and was rejected; that attempt remains. This is a delivery/extraction result, not an unavailable framework source.

Both Flutter 3.44.8 and 3.47.7 ran all 81 package tests successfully (`flutter-tests.log`, `flutter-tests-3.47.log`). The added initialization test checks debug diagnostics, mode metadata, reinitialization identity and the default disabled UI-observation lease. Real APK gates cover profile/release rather than simulating their compile-time constants inside widget tests.

## Real workflows and recovery

The full commerce fixture uses real HTTP, Native address entry, H5 coupon acquisition, Flutter search/SKU/cart/checkout, payment and refund. It is separate from the Meituan hotel's empty-result query.

- `functional/final-profile-normal` passes the no-delay, no-response-loss full commerce workflow with all four Script assertions and seven server-state checks. It is a functional run, not a selected performance sample.
- `functional/final-debug-delayed-loss-death` and `functional/final-profile-delayed-loss-death` both pass: 180 ms server delay, payment response lost after commit, App process death, new Flutter epoch, immutable Host original receipt, query of the existing order, one payment, one refund and restored inventory. Ten Script assertions plus an independent server-state oracle pass per mode. These were functional runs under shared host load, not performance samples.
- `recovery/final-debug-executor-loss` and `recovery/final-profile-executor-loss-unoccluded` pass both death points. Before-effect death retains zero effects; after-effect death retains one. The original missing completion remains unknown, its archive/checksum is preserved, a new epoch is observed and a separately authorized new action runs once. No original callback is replayed.
- `cancellation/final-debug` and `cancellation/final-profile` pass. A read-only phone witness first observes admission of the original scroll action; public Script cancel settles it as cancelled. Its original action ID and stop reason remain visible, the Native active slot clears, and the scroll position is unchanged one second after settlement. Prior partial scroll is allowed; no rollback is claimed. Retained event pages are not an assertion that every partial substep emitted an event.

These App-death tests keep the Host Runtime alive. They do not prove Host checkpoint recovery or cross-attempt recording. The existing recordingDir+checkpoint entry guard was respected by using restartPolicy none. Parent work on recording attempts is outside this Flutter change.

## Existing Android receipt gap

In `android/ai-app-bridge-android/src/main/kotlin/io/github/mobileaidev/aiappbridge/android/FlutterActionExecutor.kt`, line 23 declares the in-memory `lastResult`; lines 77–84 query that value or an active operation; lines 146–153 clear active, assign lastResult and reply. No completed receipt is durably restored there. After App death, querying an already settled old action returns `flutter_action_not_active` in both build modes.

Keep two cases separate:

1. Host received and recorded the original settled receipt: preserve the old action ID, epoch, response and immutable recording bytes. The new epoch does not rewrite it. A business query can independently establish payment state.
2. Host never received completion: retain unknown even when the business ledger shows an effect. Query the original business identity; do not replay payment or synthesize a device settled receipt.

A future Android change could persist validated completion by action ID and epoch before releasing admission, restore that record after restart, and expose explicit missing/corrupt/evicted results. It must cover death between effect, receipt persistence and delivery, without converting missing completion into success. That requires Android SDK design/tests and was not implemented here.

## Retained failures and limits

- The first normal launch used a wrong relative Activity class. The shell dispatch completed but the intended Activity was absent. The corrected full class is recorded; no business mutation occurred in that attempt.
- `functional/profile-delayed-loss-death` stopped at `flutter_target_not_operable` on a moving cart control, before any order or payment. One debug control did not reproduce this point. The candidate is not claimed to remove readiness races. Subsequent same-source debug/profile scripts require an enabled tap target with unchanged observed identity/bounds over three reads; they still use route text and server effects as the business verdict. Geometry alone is not business readiness.
- The first debug post-death payment test incorrectly expected the Native receipt to survive the process. The failure remains in `functional/debug-original-delay-control`; later tests explicitly check the actual boundary above.
- A final profile recovery attempt was obscured by the prior diagnostic harness overlay. The 15-second wait correctly reported Runtime harness labels. Closing that overlay, then running a new attempt, passed. Both attempts remain.
- After the final emulator restart, a diagnostic call made before relaunch encountered a closed old endpoint and was not dispatched. A recorded explicit Activity launch and route-readiness wait preceded the successful diagnostic run; no action was replayed.
- The first cancellation controller requested the obsolete TCP port file. It failed before starting a cancellation action. The current controller requires the actual localabstract endpoint descriptor; no transport guessing was added to the product.
- Before formal measurement, the first Meituan profile smoke was rejected at a Native privacy-sheet tap with `native_target_replaced`, dispatched false, while home data was loading. A later smoke was rejected at a Flutter hotel input with `flutter_target_replaced`, dispatched false, when asynchronous account loading inserted a row above the inputs. Neither rejected action was replayed. The shared script now waits for the public home data and the exact logged-in phone before these actions. `preformal-readiness-amendment.json` records both source-based explanations, unchanged sample plan and old/new hashes; all original smoke failures remain. These are readiness requirements, not profile speed benefits.
- A warm setup smoke sent CLI repeated `--extra` strings as one JSON string and the app reported missing run parameters. The controller was corrected before formal trials; nested Script extras were already valid. Native process warming is checked by matching pre/post PIDs, not inferred from successful launch dispatch.
- No physical Android measurements, broad plugin compatibility, iOS profile, or full hotel transaction claim is made.

## Formal comparison plan and reproduction

`predeclared-plan.json` fixes four debug/debug A/A pairs and twelve interleaved debug/profile pairs before measurement: seeds 6121, 9037 and 17077; delay 0/180 ms; response-loss cases; Native process cold/warm states. Warm means Native prelaunch before timed clear-task launch, not a retained/warmed Flutter engine. Every hotel Activity creates a fresh Flutter engine. No failed or slow trial is substituted.

Both arms record the same Script and screenshots. Total Script time includes launch, readiness, HTTP, screenshots and the test OTP control pause. `afterOtpMs` is secondary. Install, clear-data and warm prelaunch are excluded and separately recorded. Hardware/lock/load snapshots are retained. Numeric materiality was declared as median paired reduction at least 5% or 250 ms; A/A variation, uncertainty and correctness still govern interpretation.

Run from the evidence root with the owned emulator and appropriate local backend:

```sh
python3 build-final.py
python3 run-flow.py new-profile-loss '{"delayMs":180,"focusInputs":false,"stableTargets":true,"paymentResponseLostOnce":true,"processDeathAfterPaymentLoss":true}'
python3 run-recovery.py new-profile-recovery
node run-cancel.js new-profile-cancel
python3 check-sources.py profile new-profile-sources
python3 run-matrix.py aa
python3 run-matrix.py ab
python3 analyze-performance.py
python3 analyze-blocks.py
```

Controller directories intentionally reject reuse. Install the corresponding recorded APK before each functional command. Matrix controllers install the predetermined APK themselves and stop if unresolved ownership prevents safe advancement. The predeclared 32 samples are complete. User-prioritized iOS work interrupted the quiet window after 18 samples. The remaining 14 were run under shared host load, after restarting the owned emulator. `formal-block-1-summary.json`, `formal-block-2-start.json` and `formal-window-complete.json` retain this change. No sample, including the failure, was deleted or replaced. Two brief iPhone display-lease operations occurred between measured windows; WDA compilation began after the first block had ended.

| Group | Result | Paired total Script time | Interpretation |
| --- | --- | --- | --- |
| Debug/debug A/A, four pairs | 8/8 pass | Absolute difference median 1392 ms / 12.68%, range 160–1528 ms | Material baseline variation |
| First coordinated A/B block, five pairs | 10/10 pass | Profile reduction median 1744 ms / 15.13%; exploratory paired median interval 1058–1856 ms | Limited emulator signal; only five pairs, not all seeds/conditions |
| Shared-load A/B block, seven pairs | 13/14 pass; six complete passing pairs | Successful-pair reduction median 2444 ms / 23.45% | Descriptive only; shared CPU load, emulator restart and one failure prevent a pure causal claim |

`performance-blocks.json` is the authoritative separated interpretation. One-minute host load ranged about 10.10–19.72 in the first A/B block and 22.72–38.18 in the shared block; all recorded Mac lock readings were false. All twelve profile trials passed. Eleven of twelve debug A/B trials passed. Combined successful-pair numbers in `performance-summary.json` are mixed-condition descriptions, not a release speedup. The failed pair remains represented with its 24.804 s failed Script cost and no fabricated reduction. Numeric materiality alone does not satisfy adoption, especially with A/A variation and missing physical Android evidence.

The shared-block failure `ab-06-1-debug` occurs in Native food-list loading, before Flutter: the UI reports network failure and offers Retry. The backend records homepage/pulse HTTP 200, no injected HTTP status, no channel-list receipt, and zero orders. That original run recorded tree/tap/launch/screenshot evidence, but no network/log diagnostic read before app data was cleared for the next sample. Its concrete client exception class remains unknown. Do not relabel it as a timeout or shared-load cause. See `shared-block-failure.json`.

A separate required functional check, `functional/network-retry-debug`, intentionally adds 25 s service delay. Native `okhttp-auto` records `java.net.SocketTimeoutException: timeout`, statusCode -1 and 10004 ms duration—about a 10 s socket read timeout, before the configured 20 s overall call cap. After the visible failure, the controller explicitly restores zero delay and taps the observed Retry control. The new GET returns HTTP 200 in 3 ms, then the original business flow completes with one independent order, response-loss query, shared H5 account/cart and the Flutter empty-result query. After the late first server response, a further state/oracle read still passes. This check is outside the 32 performance samples and does not retroactively identify the original failure. Its full failed-wait-plus-recovery Script time is 20.869 s.

Recommendation: retain the explicit source candidate and its honest diagnostic tradeoff; keep debug as default. This does not establish general AOT performance, full hotel business, physical Android acceptance, or combined gains with the parent's Host/capture changes. The Host/native SDK used here are frozen 0.4.9, so product-wide combined performance is unmeasured.


## Separate iOS build assistance

At the user's request, this agent also prepared the pinned Flexify 2.1.109+394 source with a frozen current Flutter SDK copy and signed it for the explicitly assigned iPhone/team. The isolated `ios-flutter-handoff/HANDOFF.md` records its app path, source/lock diffs, full package hashes, codesign verification, observed provisioning-device membership and visible-workflow/SQLite instructions. Signed build time was 63.310 s after dependency/config preparation. No iPhone operation was performed by this agent; live iOS acceptance belongs to the device-owning agent. This is an iOS Debug build and supplies no iOS profile evidence.
