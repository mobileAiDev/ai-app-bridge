# Mixed workflow sample

This is one acceptance target for AI App Bridge, alongside the native sample and
the SDK-free NotallyX build. It is not evidence of complete real-app coverage.

The app includes merchant search, repeated product names and SKU selection, cart
quantity edits, checkout validation, stacked coupons, payment queries and refunds.
It uses actual HTTP requests to `../workflow-lab/server.mjs`. Campaigns run in an
embedded WebView; address entry runs in a native Android Activity with a real
location permission request. A separate inspection route receives a work order
from the native sample after its H5 approval.

Build with `flutter build apk --debug`. For emulator runs, start the workflow
server and use `http://10.0.2.2:PORT` as the device URL. The CLI validation runner
creates an isolated server run, launches the correct route, executes real UI
commands and checks the server ledger:

```sh
node desktop/ai-app-bridge-cli/scripts/validation/run-lab.js \
  emulator-5564 /absolute/server-evidence /absolute/run-evidence city
```

`native-city` runs the corresponding Android Views commerce target.
`native-h5-flutter '{"firstSave":"lost-response"}'` runs native work-order entry,
queries a committed response-loss result, completes H5 approval and hands off to
Flutter for verification. Install both sample APKs before that flow.

Run three complete mixed journeys in one continuous JavaScript Script with:

```sh
node desktop/ai-app-bridge-cli/scripts/validation/run-long-commerce.js \
  emulator-5564 /absolute/server-evidence /absolute/new-run-evidence normal mixed
```

The cases are normal checkout, a real HTTP 401 with retained checkout fields,
and a committed payment whose response is lost. The last case observes the
failure and uses the App's order query before refunding; it does not repeat
payment. Sources are frozen in the output directory, and all three isolated
server ledgers are checked. The current prepared run completes **201 commands
in 62.334 s** including server verification: one Script operation, two external
calls (start and wait), 7479 response bytes, and 16 passing checks. Each case
has exactly one order/payment/refund and restored stock. This is three prepared
journeys, not first-use discovery or whole-App coverage. `crash` and `cancel`
are available boundary-fault modes; the mixed target's corresponding modes
still need their own runtime acceptance.

The `recovery` route supplies a separate process-loss fixture. Its Flutter button
callback appends and flushes an App-private journal before an eight-second
synchronous block. The validation runner kills only the verified App PID, once
before the counter is committed and once after it is committed but before the
action receipt returns. It preserves the original unknown action, restarts the
App, queries the original completion, and checks a new explicit action without
replaying the old callback. The default run then completes the mixed commerce
journey with a lost payment response and an independent server-ledger check:

```sh
AI_APP_BRIDGE_FACT_STORE_DIR=/absolute/development-facts \
node desktop/ai-app-bridge-cli/scripts/validation/run-flutter-executor-loss.js \
  emulator-5564 /absolute/server-evidence /absolute/new-run-evidence business
```

Use an emulator reserved for these process-loss tests. `fixture` in place of
`business` runs only the two fault points. Timing, source hashes, process
identities, original receipts/archives, journal rows, screenshots and the server
state are retained together. The independent oracle describes observed App
effects; it never converts a missing SDK completion into a successful receipt.

Use a full Android system image for visual acceptance. ATD images disable native
hardware drawing even when the emulator is configured with a host GPU. Keep
failed runs, startup time, screenshots and server state with the timing report.
See `../../docs/WORKFLOW_PERFORMANCE_PLAN_2026-10-12.md` for the required matrix
and remaining acceptance gaps.
