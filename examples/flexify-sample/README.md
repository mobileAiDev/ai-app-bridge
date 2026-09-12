# Flexify iOS Bridge sample

This sample pins [Flexify 2.1.109](https://github.com/brandonp2412/Flexify/tree/9ae7a8b8f423cbd28fd5f22dc7ae14fded1fc604)
using `source.json`. The upstream source, MIT license and lockfile remain in
ignored `upstream/`. Its Flutter 3.44.8 SDK is isolated from the LocalSend SDK.

`integrate.py --archive <pinned-tar.gz> --team-id <Apple-Team-ID>` verifies the
original source before adding the local Bridge dependency, Debug startup and
route observer, and an independent iOS bundle/signing identity. It does not
change exercise, plan, calculation, notification or database behavior.

The intended business proof is creation of a training plan, recording and editing
sets, navigating history/graphs, cancellation and an intentionally wrong expected
result. Intent supplies fresh exploration evidence; a continuous Script repeats
the business task. The independent oracle reads the App's actual
`Documents/flexify.sqlite` and its associated journal after a quiescent snapshot.
Only synthetic test records are used.

Build preparation does not establish business acceptance. Flutter coverage does
not replace Kiwix native/H5, FreeOTP native or LocalSend transfer requirements.

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
