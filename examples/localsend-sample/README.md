# LocalSend Bridge sample

The current navigation/settings regression uses the shared public CLI runner:

```sh
node examples/device-regression/run-android-suite.js \
  build/ai_app_bridge_artifacts/localsend-focused-NEW b46093e6 localsend
```

Use a new output directory and the [pinned suite prerequisites](../device-regression/README.md).
The current v1.3.0 fixed navigation scenario passed in 132.939 seconds with
148 assertions, 14 screenshots, two independently verified no-peer network
fixtures and exact persisted settings restoration. Its archive verified offline.
The controller also passed an actual cancellation while the network fixture was
active and restored Wi-Fi. See [the current result and limits](../../docs/LOCALSEND_NO_PEER_2026-09-12.md).
This is one complete current-revision run; previous failures and older multi-run
results are preserved. It is not full-App or whole-device acceptance.

The real transfer validation now covers Android ↔ the unmodified official
LocalSend CLI, receiver rejection and sender cancellation before acceptance.
Both directions passed three runs of their respective frozen Scripts, with
independent destination byte comparisons. Receiver cancellation during an actual
1 GiB transfer also passed Intent and three same-source Script runs, including
full partial-file comparisons. See [the scope, failures and evidence](../../docs/LOCALSEND_TRANSFER_BUSINESS_2026-09-11.md).

From the repository root, after the Intent exploration has established the
exact two-file fixture and the phone is on the Chinese Receive page:

```sh
node examples/localsend-sample/validation/run-transfer-receive.js FIXTURE_DIR NEW_OUTPUT_DIR
node examples/localsend-sample/validation/run-transfer-send.js FIXTURE_DIR NEW_OUTPUT_DIR previous-received
node examples/localsend-sample/validation/run-transfer-decline.js FIXTURE_DIR NEW_OUTPUT_DIR reject
node examples/localsend-sample/validation/run-transfer-decline.js FIXTURE_DIR NEW_OUTPUT_DIR sender-cancel
```

`FIXTURE_DIR` contains `script-fixture.json` (explicit serial, APK hash, phone
alias/address and peer alias), `transfer-files.json`, original `send/` files,
previous verified `received/` files, the verified `peer/localsend-cli`, its
`peer-manifest.json`, and isolated `peer-config/`. The current evidence fixture
is under `build/ai_app_bridge_artifacts/localsend-transfer-20260911-01/`.
The send controller also accepts `empty` when the two destination paths must
be absent. Each run freezes the Script and saves evidence in a new directory.
Only hash-verified fixture files are removed for a repeat. Phone interaction
uses public Script calls; controller decisions automate the official peer and
independent file reads. The picker must already be authorized by its user.

For cancellation after bytes are actually transferring, use the separate
`localsend-inflight-20260911-01` fixture and its 1 GiB source file:

```sh
node examples/localsend-sample/validation/run-transfer-inflight.js FIXTURE_DIR NEW_OUTPUT_DIR BridgeInFlightScript20260911.bin
node examples/localsend-sample/validation/run-transfer-inflight.js FIXTURE_DIR NEW_REPEAT_DIR BridgeInFlightScript20260911.bin PREVIOUS_OUTPUT_DIR/partial-oracle.json
```

The optional previous oracle permits removal of exactly the preceding partial
file after checking the phone file and preserved copy against its hash. A final
optional expected-peer-alias argument changes only the Script expectation for a
negative test; the official peer retains its fixture identity. An omitted alias
expects the fixture peer. A failed Script is retained as failed even when this
is the intended negative result. The byte oracle supports Python 3.9 and newer.
This is App transfer cancellation, not cancellation of a pending SDK action.

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
2. Confirm `ai_app_bridge_flutter: 0.3.6` is available on pub.dev; its Android dependency resolves Bridge `0.3.6` from JitPack.
3. Run `python3 examples/localsend-sample/integrate.py` once on the fresh source.
4. From `upstream/app`, use the pinned Flutter SDK to run `flutter pub get` and
   `flutter build apk --debug --target-platform android-arm64`. The upstream
   `.fvmrc` also pins this SDK; `fvm flutter` uses the same version.

The integration changes only the Flutter dependency and initialization,
navigator observer and debug application ID. The published Flutter plugin
resolves its Android SDK from the matching public JitPack coordinate.
`build/integration.json` records the Bridge version and hashes of the modified
upstream files. Preserve the resolved pub lockfile and actual APK hash when
freezing a new test build.

The installed package is `org.localsend.localsend_app.bridge_sample`. Test runs
must freeze the APK SHA-256, device serial, settings and initial page. Device
actions use the current repository CLI/MCP shared runtime.

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

The original `run-evidence-reuse.js` matrix and companion reviewers are retained
for the earlier frozen evidence. That historical controller does not implement the current explicit network-fixture
protocol or the separate final assessment after terminal.
Use the runner above for current work; it retains inconclusive results, pins the
installed build and source, saves independent settings reads, and verifies each
archive offline. Earlier matrix passes below belong to their frozen revisions.

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
