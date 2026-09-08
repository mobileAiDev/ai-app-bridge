# LocalSend Bridge sample

This sample checks whether the Intent → frozen evidence → code Script workflow
works in a second complex application, using Flutter. It is a Bridge development
fixture. LocalSend's business behavior is supplied by the frozen upstream app.

`source.json` pins the upstream source archive, its SHA-256, Flutter 3.41.9 and
Rust 1.97.1. The upstream checkout lives in ignored `upstream/`; the original
license, source and generated files remain there. No upstream contribution or
release is made by this integration.

Preparation from the Bridge repository root:

1. Download `source.json.archiveUrl`, verify `archiveSha256`, and extract it into
   an empty `examples/localsend-sample/upstream` with one leading path removed.
2. Build `./gradlew :ai-app-bridge-android:assembleDebug`.
3. Run `python3 examples/localsend-sample/integrate.py` once on the fresh source.
4. From `upstream/app`, use the pinned Flutter SDK to run `flutter pub get` and
   `flutter build apk --debug --target-platform android-arm64`. The upstream
   `.fvmrc` also pins this SDK; `fvm flutter` uses the same version.

The integration changes only the Flutter dependency and initialization,
navigator observer, debug application ID and Android debug runtime dependency.
The Flutter plugin's published Android 0.2.8 dependency is explicitly excluded
in this sample and replaced with the AAR built from this working tree.
`build/integration.json` records its SHA-256 and each modified upstream file.
Rebuilding the Android AAR requires refreshing the integration manifest before
freezing a new test build.

The installed package is `org.localsend.localsend_app.bridge_sample`. Test runs
must freeze the APK SHA-256, device serial, settings and initial page. Device
actions use the current repository MCP, not an installed release server.

The intended scenario covers receive/send navigation, link receive and return,
about/licenses, system file-picker cancellation, theme/language changes and
restoration, and repeated navigation. Scripts must bind assertions to fresh
observations. `settings-oracle.py` independently reads a limited set of real
SharedPreferences fields over `run-as`; it does not trust Script verdicts or
store credentials. Compare a post-run snapshot with `--compare BASELINE.json`.

Each frozen revision must meet three same-source positive replays, a deliberately
wrong expectation, a cancellation run and portable evidence verification.
Timing is for this declared scenario, not every feature in LocalSend.

The 2026-09-08 Intent exploration and Bridge fixes are documented in
[`docs/LOCALSEND_INTENT_EVIDENCE_2026-09-08.md`](../../docs/LOCALSEND_INTENT_EVIDENCE_2026-09-08.md).
The frozen authoring inputs and acceptance conditions are in
[`SCRIPT_HANDOFF.md`](SCRIPT_HANDOFF.md). The independently authored source,
scenario manifests and provenance are in [`scripts/`](scripts/).

The validation controller fixes the OPPO serial, installed APK hash and baseline
preferences before using the public MCP Script entry. Starting from the frozen
Receive fixture, run from the repository root with a new output directory:

```sh
node examples/localsend-sample/validation/run-evidence-reuse.js \
  --out build/ai_app_bridge_artifacts/localsend-script-new-matrix --mode matrix \
  --apk-sha256 FROZEN_APK_SHA256
node examples/localsend-sample/validation/review-external-settings.js \
  build/ai_app_bridge_artifacts/localsend-script-new-matrix
```

`matrix` runs one core flow, three acceptance positives, one wrong expectation
and one cancellation while waiting at the declared control checkpoint. The
controller saves each failure and verifies exported archives after its live Host
exits. The companion review copies and validates independent preference reads
and complete public MCP execution events, including the controller replies;
these are separate companion files, not claimed as Bridge export payloads.
Pass an optional second output-directory argument to the companion reviewer to
preserve an earlier review while creating another bundle.
A completed cancellation leaves the phone on Settings before any setting change.
Fixture cleanup belongs to a separate, recorded controller operation.

Replace `FROZEN_APK_SHA256` with the digest of the explicitly frozen build. The
controller requires this argument and checks the installed APK before each trial.
It does not infer a build from the current worktree. The capture storage regression
can be run separately with `validation/check-capture-window.py --serial SERIAL
--port VERIFIED_FORWARD_PORT --apk-sha256 FROZEN_APK_SHA256 --out NEW_DIRECTORY`.
Its optional `--stress-records 2500` writes explicitly labelled synthetic capture
events; these exercise storage and are not LocalSend business evidence.

`report.ok` describes the declared UI, control, restoration and archive gates.
Read `fullAcceptance`, mobile assertions and open gates separately. The earlier
2026-09-08 v1.0.5 matrix passed those UI/control gates, while mobile capture
remained inconclusive due to bounded current-window HTTP timeouts and capture
gaps. This is not full-app or file-transfer acceptance. The actual
trial results and known Bridge gaps are recorded in
[`docs/LOCALSEND_SCRIPT_REUSE_2026-09-08.md`](../../docs/LOCALSEND_SCRIPT_REUSE_2026-09-08.md).

The subsequent Android capture repair reused the same Script in matrix-4:
all six control trials passed, and all 66 mobile read pages were complete.
That run left Flutter semantic action association and the full mobile acceptance
gate open; the following focused validation advances the route association gate. Build digests, timings and preserved failures are recorded in
[`docs/LOCALSEND_CAPTURE_REPAIR_2026-09-08.md`](../../docs/LOCALSEND_CAPTURE_REPAIR_2026-09-08.md).

## Flutter action scope validation

The current Android source SDK preserves the Flutter action ID on real capture
records. The focused root-authored Script uses public `tap-flutter` with logical
coordinates, validates actual route events and asks the external controller to
read persisted settings. It is separate from the independently authored frozen
`localsend-flow.v1.js`. See [scope and evidence](../../docs/LOCALSEND_FLUTTER_ACTION_SCOPE_2026-09-08.md).

```sh
node examples/localsend-sample/validation/run-action-scope.js NEW_OUTPUT_DIR FROZEN_APK_SHA256
node examples/localsend-sample/validation/review-action-scope.js NEW_OUTPUT_DIR
```

The controller requires the PGFM10 sample target, the matching source SDK APK,
the Chinese Receive page and exact baseline preferences. It does not repair
fixtures automatically. The iOS plugin still needs the corresponding ingress.
