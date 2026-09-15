# Native window regression

## Complete sample regression through Instrumentation

Run the application's preinstalled matching debug/test APKs through the public
Bridge Script API. This suite uses Espresso, UI Automator and Espresso-Web in
one Instrumentation session, then a Compose-rule session driven by Python:

```sh
node examples/android-native-sample/validation/run-instrumentation-regression.cjs \
  --serial DEVICE --output build/sample-instrumentation-NEW_RUN
```

Use `--cli /absolute/path/to/bin/ai-app-bridge.js` to test an installed CLI package.
The output directory must be new. The runner is restricted to
`io.github.mobileaidev.aiappbridge.sample`; it does not target cashier packages.
It does not record the screen or capture screenshots.

The suite covers the native form and counter, log/event/state/network buttons,
dialog confirmation/cancellation, nested Dialog/PopupWindow selection, saved and
cancelled edits, child Activity results, embedded H5 input/click/fetch/iframe,
system permission responses, login success/validation/invalid credentials/network
failure/timeout/OTP/already-authenticated scenarios, and Compose input/state.
Network and login responses in this application are test fixtures, not production
backend acceptance. OTP only records a submission attempt in the fixture.

The permission chapter requires camera access already granted and microphone
access denied but requestable. It uses the real system dialog, including the
one-time grant, and reads PackageManager afterward. Incompatible initial state
is reported explicitly; the runner does not change global device settings.

`report.json` lists every chapter, assertion, action mechanism, timing, persisted
Script operation ID, missing chapter and cleanup result. Window values are also
checked against the application's private JSON file. Capture assertions require
a complete suffix from a Host-issued pre-action cursor. The total timer includes
session startup, UI execution, checks and cleanup; package build/install time is
separate. A completed run with failed checks is a failed regression, not a pass.

## Existing SDK window regression

`WindowContractFixtureActivity` creates real Android Activity, Dialog and
PopupWindow instances. Background and foreground controls deliberately share
the text `Choice`. The fixture writes independent counters and saved input to
`files/window-contract-fixture.json` so a successful Bridge receipt alone cannot
make the workflow pass.

Build the sample with the workspace SDK:

```sh
./gradlew -p examples/android-native-sample :app:assembleDebug
```

Install the APK with `ai-app-bridge install-apk` and wait for its installation
verification to finish. The script requires a fresh fixture Activity with zero
counters; after a previous run, exit the fixture before reopening it. It does
not clear app data or rewrite counters to manufacture a passing result.

Run from the repository root with an unused Host port and a new evidence path:

```sh
AI_APP_BRIDGE_FACT_STORE_DIR="$PWD/build/window-regression-facts" \
  python3 examples/android-native-sample/validation/window-contract.py \
  --serial DEVICE --port 17845 --output build/window-regression-evidence \
  --cli node "$PWD/desktop/ai-app-bridge-cli/bin/ai-app-bridge.js"
```

The checks cover:

- Dialog text selection despite duplicate background labels and independent
  application-window tokens.
- Input, confirmation, saved-value readback, reopening and cancelling an edit.
- Nonfocusable popups belonging to both the Activity and the Dialog.
- Rejection of background taps and input while the popup is foreground.
- A child Activity returning to the parent without a background click.

UI actions use the public Bridge commands. Read-only ADB calls capture screenshots
and the fixture's persisted state. State waits repeat observations only; actions
are never automatically repeated. Trees, receipts, images and `report.json` stay
in the selected output directory. Stop the isolated Host runtime after collecting
the result, using the same `AI_APP_BRIDGE_FACT_STORE_DIR` and CLI entrypoint.

For a before-fix comparison, install a fixture APK built with the old SDK and
run with the old CLI plus `--expect-bug`. That mode requires both original errors
(`native_selector_ambiguous`, `native_selector_not_found`) with `dispatched:false`
and zero background/dialog/confirm clicks. It is not a success mode for the fixed
SDK. The current SDK publishes `foregroundWindowId`; SDK and Host must be updated
together because missing window metadata is rejected instead of inferred.
