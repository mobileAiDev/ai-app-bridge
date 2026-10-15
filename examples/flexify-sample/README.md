# Flexify Bridge sample

This sample pins [Flexify 2.1.109](https://github.com/brandonp2412/Flexify/tree/9ae7a8b8f423cbd28fd5f22dc7ae14fded1fc604)
using `source.json`. The upstream source, MIT license and lockfile remain in
ignored `upstream/`. Its Flutter 3.44.8 SDK is isolated from the LocalSend SDK.

`integrate.py --archive <pinned-tar.gz> --team-id <Apple-Team-ID>` verifies the
original source before adding the Bridge dependency (`0.4.12`), Debug startup and
route observer, and an independent iOS bundle/signing identity. It does not
change exercise, plan, calculation, notification or database behavior.
Confirm that `ai_app_bridge_flutter` 0.4.12 is available on pub.dev before
running this published-package integration
and resolving dependencies. The local Android preparation below is separate.

The intended business proof is creation of a training plan, recording and editing
sets, navigating history/graphs, cancellation and an intentionally wrong expected
result. Intent supplies fresh exploration evidence; a continuous Script repeats
the business task. The independent oracle reads the App's actual
`Documents/flexify.sqlite` and its associated journal after a quiescent snapshot.
Only synthetic test records are used.

Build preparation does not establish business acceptance. Flutter coverage does
not replace Kiwix native/H5, FreeOTP native or LocalSend transfer requirements.

## Android preparation (2026-10-13)

`prepare-android.py --source <fresh-source> --archive <pinned-tar.gz>
--android-sdk <sdk> --flutter-sdk <sdk> --android-bridge-aar <current-debug.aar>
--output <new-report.json>` verifies the same pinned archive and unmodified
integration inputs. Build `:ai-app-bridge-android:assembleDebug` in the Bridge
repository first and retain a copy of that AAR. The integration records its hash,
adds it only to this sample's debug build and excludes the plugin's published
Android dependency. The local Dart plugin, debug startup and navigator observer
are also added. Using a built AAR keeps Flexify's AGP 9 build separate from the
SDK's AGP 8 build; no global repository override is needed.

Use the upstream build environment variables
`FLEXIFY_APP_ID_SUFFIX=.bridge_sample` and
`FLEXIFY_APP_LABEL="Flexify Bridge Sample"` to install the independent package
`com.presley.flexify.bridge_sample`.

The resolved Android checkout preserves all 160 upstream locked packages and
adds only `ai_app_bridge_flutter`. Preparation does not establish Android
business acceptance. The iOS results below are historical and must not be counted
as current Android measurements.

The first Android integration omitted the native dependency replacement. Its
Gradle resolution used published Android SDK 0.4.6 alongside the local Dart
plugin, so those measurements do not validate the current native observation
path. CPU samples exposed full diagnostic-tree generation during operable reads.
Both the failed integration and its measurements remain retained.

Run the Android cases with a fresh evidence directory:

```sh
node examples/flexify-sample/validation/run-android.js SERIAL NEW_OUTPUT_DIRECTORY workout
```

The runner freezes the source and retains the original Script operation across
wait/result calls. `discovery` measures startup and readable controls. `snapshot`
stops only this sample, verifies process absence before and after copying, and
copies the observed database and SQLite journals. Pass that database directory
and the workout's exact title/time window to `validation/read-workout.py`.

For process-cold startup comparisons, run `startup flutter` or `startup uia`
after the output directory argument. Each uses the existing Script API, stops
only this sample, verifies process absence, launches it and waits for the exact
`Add` control observed in both providers. Launch and wait time are reported
together; screenshots and the external call's total time remain separate.
`startup-passive` is a diagnostic control: after launch it sends no observations
for 45 seconds, then reads Android's `wm_activity_launch_time` event and verifies
the visible page. Its first-frame value comes from Android; the deliberate
45-second measurement window must not be quoted as App startup performance.
Replace the APK with `install -r` to preserve the same package and business data
when comparing pinned upstream and Bridge builds.

On macOS, `python3 validation/run-awake-startup.py SERIAL NEW_OUTPUT_DIRECTORY
--count 2 --keep-display-awake` records independent IOKit lock, CGSession,
display-sleep and frontmost-App observations throughout the runs. It compiles a
small Swift probe before measuring. A positive frontmost process ID also identifies
an observed unbundled app; its missing bundle ID stays null. Missing identity
remains unknown; a false
`IOConsoleLocked` value alone does not certify an active display or full emulator
CPU availability. Environment warnings never prevent App execution or change its
functional result. Inspect the separate `environment` report before comparing
timings, and retain slow samples. The optional process-scoped `caffeinate -di`
assertion prevents idle sleep until this runner exits; it neither unlocks the Mac
nor disables App Nap or changes system settings. Pass `--emulator-pid` with the
verified qemu host PID to retain active/hidden state, cumulative CPU time, scheduler
priority and RunningBoard's recorded App Nap / CPU-throttling transitions. A
missing initial scheduling state remains unknown. Showing the existing emulator
window and rechecking its state is an available recovery action; the runner does
not move windows or change system App Nap settings. `--passive-ms 45000` provides the same observation-free
control described above. Use `AAB_VALIDATION_CLI_PATH` to select an installed CLI
and independent `AI_APP_BRIDGE_FACT_STORE_DIR` / `AI_APP_BRIDGE_RUNTIME_HOME`
directories to keep the run separate from existing work.

The latest Android SDK and Dart plugin complete the workout, editing, cancelled
deletion, History and Volume graph in **41.764 s**, with 50 commands, one external
call and 1499 response bytes. This process-cold run includes **23.327 s** for
launch and initial readiness. The independent stopped-process database snapshot
passes all 13 checks, including exact per-plan values and the displayed day's
5000 kg total. The earlier 48.352 s / 47-command pass after APK replacement,
37.433 s / 47-command pass and 34.941 s / 50-command pass remain recorded
separately. Their startup conditions and graph selections differ; they do not
form a controlled whole-flow speed comparison.

Repeated runs exposed an offscreen plan after the retained list grew. The
harness now reveals the actual row with `scroll-flutter` before selecting it.
Upstream's search matches days/exercises, not the title; a failed attempt using
that search also matched the input's own text. Both failed runs are retained.
An explicit continuation completed the already-saved plan and passed all 13
database checks without creating it again. Its 44.835 s continuation is separate
from the 46.673 s initial failure and 16.868 s failed search attempt. Including
inspection and correction, first attempt through recovery took **420.038 s**;
that recovery is not counted as a fast full-flow pass.

Android performance/recovery acceptance remains **incomplete**. Earlier cold
discovery failures, the actual notification dialog, Android selector differences
and the Flutter observation timeout before Graphs are retained. The new light
observation does not yet resolve slow first startup. The failure records and exact timing boundaries are in
[the current performance plan](../../docs/WORKFLOW_PERFORMANCE_PLAN_2026-10-12.md).

## Current evidence (2026-09-11)

The isolated Flutter 3.44.8 archive is verified and extracted. Dependency
resolution retains every upstream locked package and adds only the local Bridge.
The iOS arm64 Debug build, including the Bridge Swift package, succeeds with
signing disabled. The first signed builds reported `No Accounts` and no
provisioning profile. After opening this workspace's Signing & Capabilities in
Xcode, the existing Personal Team generated the exact profile with this iPhone
included. `build-device-05-result.json` now records a successful signed build;
`install-06.json` records installation on `00008150-001005143A32401C`.
The fixed business Intent now passes the actual training workflow and all 11
independent SQLite checks. The accepted continuous JavaScript Script takes
116.478 seconds from public start to terminal, with 157 calls, 16 passed device
assertions, 5 screenshots and 13 independent SQLite checks. Keyboard visibility
and Script chart-label assumptions were corrected; all three failed runs remain
recorded. The timing excludes setup, external database copying and archiving.
Current acceptance and
limitations are recorded in [the business evidence report](../../docs/IOS_FLUTTER_BUSINESS_2026-09-11.md).

The targeted `validation/form-fields.js` now uses the real editor's `label`
metadata to distinguish Reps from Weight (kg), even when both values are `0`.
Its Intent-derived Script passes 6 device assertions in 12.199 seconds, changes
only the unsaved weight and returns without Save. Transparent skeleton text is
absent from operable observations while the grey placeholders remain visible.
The independent stopped-App database copy is byte-identical to the frozen
baseline, with all three business tables unchanged. This is a separate form
contract check, not a new timing for the full workout.

The first installation hit the free-team three-App limit. The completed FreeOTP
Bridge test sample was stopped and its Documents/Library copied and hashed under
`freeotp-backup-06/`; its signed App and original synthetic HOTP evidence remain.
The snapshot excludes Keychain and a failed tmp copy, so it is not claimed to be
a complete credential backup. Only `io.github.mobileaidev.freeotp.sample` was
removed. Kiwix and WDA remain installed. The original failed install is retained
in `install-05.json`. Flutter Debug startup uses the pinned Flutter tool with the
signed prebuilt App and its debugger (`flutter-launch-06.json`); this setup is
outside the timed business Script.

Preparation evidence is in
`build/ai_app_bridge_artifacts/flexify-ios-core-2026-09-11/` at the repository root.
`build-unsigned-03-result.json` records the successful unsigned build;
`build-device-02.log` retains the signing failure. `source-after-build-03.json`
and its diff compare every original source file: only Bridge integration,
independent signing identity, the local Bridge lock entry and CocoaPods tool
version differ. The App's existing Swift Package Manager setup is retained.

## Frozen workout and independent result

`validation/workout-case.json` defines a Friday plan using Barbell bench press:
42.5 kg × 8 and 45 kg × 6, then edit the second set to 47.5 kg. History and graphs
must reflect the result; cancel the existing set's Confirm Delete dialog. The
expected persisted result is two sets, 14 repetitions and 625 kg total volume.
Intent and Script use separate unique plan titles. `validation/workout-flow.js`
uses controls observed during Intent, fresh Element IDs, explicit keyboard
dismissal and stable post-action observations. A failed mutation is not retried.
`validation/workout-script-case.json` pins the current independently verified
baseline database. Each run uses a fresh title and output directory. The Intent
and second/third Script plans retain 1875 kg in the same day; the next frozen run
expects 2500 kg for the day and 625 kg for its own plan. Chart axis labels are
rounded; their range is UI evidence, while the database oracle verifies exact
per-plan and daily totals.

After the run, stop the exact App process, verify it has exited, and copy its
actual Documents database with any SQLite journals. Run
`validation/read-workout.py` with `--snapshot`, a new `--output`, `--case`,
`--plan-title`, `--started-at-ms` and `--finished-at-ms`. The time window comes
from that run, not the database's own record timestamps. The verifier checks
the plan/exercise relationship, exact sets, fresh records and independently
calculated totals in a separate read copy, preserving source hashes.

`validation/snapshot-workout.py` accepts the public `--runtime-result`, terminal
`--terminal-result`, recorded `--flutter-launch` metadata and a fresh `--output`.
It verifies the exact App/debugger identities and stops only that owned Flutter
launcher, then confirms the device App is absent before and after copying.
For daily volume verification pass `--day`, `--time-zone` and
`--expected-day-volume-kg` together to `read-workout.py`.

The verifier's synthetic WAL fixture proves it sees the edited value and rejects
an intentionally wrong volume. Separately, the real Intent snapshot now proves
the plan and exact persisted set values. This fixed task does not establish
whole-App coverage or graph layout quality.
