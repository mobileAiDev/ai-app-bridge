# Intent / Script real-workflow acceptance

Status: **in progress**. Small prepared-flow results do not establish whole-product acceptance.

For the post-0.4.7 first-use comparison, response-delivery corrections and Native
startup diagnosis, see [the current candidate report](WORKFLOW_PERFORMANCE_0.4.8_CANDIDATE_2026-10-13.md).

## Complex-app reference and platform matrix

The acceptance target is the complexity of a local-services super-app, not a
sequence of isolated form controls. The user explicitly requested Meituan as a
reference. Official activity descriptions include multiple business channels,
search-led campaigns and coupons; the test workbench must exercise comparable
navigation and interaction structure. References:
https://source.meituan.com/activities and https://i.meituan.com/client/homemt.
The downloaded official Android package currently advertises only `armeabi`;
it has not been run on the arm64-only development emulator. Do not represent
official web research as an observed real-Meituan test.

Required platforms are **pure native Android, Flutter, same-package native +
Flutter + WebView, UIA-only apps without the SDK, and independent desktop Web**.
Run the equivalent business outcomes through Intent, JavaScript and Python; a
passing Flutter run does not satisfy the native, UIA, Web or execution-language
rows. Existing open-source apps remain required independent acceptance targets.
The user explicitly excludes the K2 Mini cashier and requires all other supported
platforms to be checked. Physical iOS is unavailable; inspect iOS Simulator
availability separately and report any untested capabilities without borrowing
Android results. The current Mac returns no available iOS Simulator devices.

The city workbench adds image-heavy merchant lists, repeated shop names with
branch identity, paginated queries, horizontal campaign cards, category filters,
SKU sheets, a fixed cart bar, H5 coupon dialogs, native address editing, actual
permission prompts, stacked discounts and payment/refund reconciliation. Each
scenario uses a separate server run and verifies durable commits independently.

Failures remain part of the record. Complex mixed-flow testing exposed that H5
waits rejected a not-yet-created WebView and incorrectly treated a disabled
completion label as unobservable. Both cases need regression tests and actual
reruns. GPU-disabled emulator runs also showed large startup/frame stalls; keep
them separate from host-GPU runs and record the graphics configuration.

## Required outcome

Once the agent has enough information, existing Intent and real JavaScript/Python
Script must execute continuously, wait for observable outcomes, branch locally,
and ask the agent only when a new decision is needed. Information and recovery
choices should replace unnecessary admission failures. Unknown submitted effects
remain identifiable and inspectable; they are not silently repeated.

## Workloads and evidence

| Workload | What must actually happen | Independent check |
| --- | --- | --- |
| Login | Welcome, fields, agreement, submit, delayed success/error/challenge | Visible result, submit counter, HTTP server journal |
| Commerce | Search/category, product variants, cart edits, address validation, coupons, checkout, payment query, cancellation/refund | Independently calculated prices, stock, order/payment/refund test ledger |
| Native workflow | Search, duplicate labels, scoped selection, replaced controls, validation, dialogs, retry, history, settings | App journal and server records |
| System boundaries | Deny/allow actual runtime permissions, switch windows, reopen after process restart | OS permission state, app state, preserved operation IDs |
| Embedded H5 | Real loaded HTTP document, editable form, dialog, asynchronous fetch, failure and retry | DOM and server commits |
| Flutter | Navigation, dynamic list, edits, validation, overlays, real requests and native/H5 transitions | Flutter observation and server commits |
| Existing open-source app | Real business navigation and persistent mutations in a separately identified test build | App database or preferences; retained upstream attribution |
| Dynamic intervention | Program asks the agent, answer resumes the same live operation | Before/after markers; exactly one committed effect |
| Repeated observations | Unchanged, small change, replaced node, window and runtime changes | Fresh capture time, complete delta reconstruction and valid action references |
| Long execution | Hundreds of ordinary commands without model round trips | Counts, receipts, memory/response growth, cancellation and continuation |

Use the dedicated full Android emulator `emulator-5564`
(`ai_bridge_workflow_visual_api36`, Google APIs API 36, host GPU) for visual
acceptance. Do not use the K2 Mini cashier or unrelated attached phones. A brief
K2 attempt was stopped on the user's instruction and is excluded from acceptance.
Its newly installed sample could not be confirmed uninstalled because the device
had disconnected; retain that cleanup status without reconnecting for testing.
Desktop Web uses an isolated browser profile and local test backend, with its own
execution, response size, persistence and recovery evidence.

The original `emulator-5562` used an AOSP ATD image. Inspection found
`debug.hwui.drawing_enabled=0`: native screenshots were black, and Flutter/H5
composites could show outdated or missing native content. Android explicitly
documents that ATDs disable hardware rendering and do not support screenshot
tests that depend on it:
https://developer.android.com/studio/test/managed-devices#enable-atd.
All earlier ATD timings below are **diagnostic measurements, not visually
validated completion times**. They must be rerun on the full image. Enabling the
emulator host GPU alone does not turn ATD drawing back on.

The integrated workbench must include both existing complex open-source apps and
purpose-built common internet-app flows. Reusing an inspection fixture alone is
insufficient. Commerce uses an isolated test ledger: real HTTP, persistence,
idempotent orders, stock reservations and payment/refund state transitions, with
no external payment provider. Faults include response loss after commit, stale
prices, expired sessions, concurrent edits, process restart and duplicate taps.

## Timing and comparison

- Measure submission through visible/independently verified completion. Record
  startup separately and retain the total; do not discard cold startup.
- Keep prepared execution, first-use discovery/planning, recovery, and external
  verification times separate. A prepared 6-second run does not explain away a
  historical multi-minute interaction.
- Compare the same source/inputs/device/app conditions across old and new CLI;
  when the SDK changes, include a comparison with the same SDK as well.
- Record actual external calls, internal commands, observation count, bytes,
  expected negative cases, unexpected failures, and server commit counts.
- Repeat successful flows and their fault variants. Report every failed run,
  samples, median and range; do not call a small-sample maximum a measured P95.
- Known login aims for 3–5 seconds under the declared app/network conditions;
  the composite prepared workflow aims for under 60 seconds. Slow injected
  network time remains part of the result and is identified explicitly.

## Completion criteria

All applicable rows must have current execution evidence, not just mocked unit
tests or historical reports. A discovered correctness defect must be reproduced,
fixed and rerun under its original conditions. Source, package fingerprints,
scenario and fault configuration must accompany each run. Broad untested
capabilities remain unverified rather than being counted as a pass.

Process outputs, screenshots, recordings, logs and databases are stored outside
the source repository. Reusable tests, scenario sources and fixture applications
are source files. This plan is a task-specific acceptance scheme; no prescribed
four-round skill process is being applied.

## Full-image runs, October 13

Evidence root on this workstation:
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.6-2026-10-12/k2-live-demo-1791808027918`.

These are prepared flows on `emulator-5564`. Times include the flow's own launch
and readiness calls where present. They exclude earlier app discovery, script
authoring, installation and debugging; they are not a claim that an unfamiliar
app can be discovered and fully tested within a minute.

| Target and run directory | Observed result | Time / calls |
| --- | --- | --- |
| Native HTTP login, `intent-network-visual-2` | One autonomous Intent, exactly one server session | Intent 4.523 s; 9.150 s including launch/readiness, 3 external calls |
| Native commerce, `native-city-visual-2` | H5 coupon, SKU/cart, checkout, refund/history; ledger checked | 32.764 s, 60 commands, 1 external call; launch alone 13.923 s |
| Native commerce response loss, `native-city-visual-4-loss` | Query reconciles the committed payment, then refund; one payment attempt | 16.751 s, 62 commands, 1 external call; warm process, new Activity |
| Mixed commerce, `city-visual-2` and `city-visual-3` | Flutter merchant/SKU/cart + real H5 campaign + native address + checkout/payment/refund | 26.740 / 33.155 s, 63 commands each, 1 external call each |
| Native Python, `python-native-visual-1` | 11 stages, replaced-control rejection, validation, failed-save retry, history/settings, 9 checks | 15.735 s including process stop/relaunch, 36 commands, 1 external call |
| Native → H5 → Flutter, `native-h5-flutter-visual-loss-1` and `-2` | Native response lost after save; query, H5 approve, Flutter verify; one commit per stage | 18.887 / 21.962 s, 51 commands, 1 external call each |
| SDK-free NotallyX, `notally-uia-visual-3` | UIA + wrapped ADB input: create/edit/pin/archive/restore/trash/restore/restart/reopen; exact SQLite check | 26.713 s, 55 commands, 1 external call |
| Real permission recovery, `address-permission-resume-1` then `address-permission-resume-2` | Script pauses twice for Agent decisions; actual deny/allow dialog actions. Parser failure after allow repaired; same draft resumed, one address commit | First attempt 79.042 s including Agent waits and failure; final continuation 2.107 s, 6 commands. Not a speed benchmark |
| Native/H5 long JavaScript, `long-native-visual-1` | Three complete checkout/payment/refund/history journeys: normal, server price change, lost payment response. Three isolated real HTTP runs, exact ledger/stock checks | 50.557 s, 187 commands, 1 external call, 2703 returned bytes |
| Native/H5 checkpoint crash, `long-native-crash-1` | Deliberate child exit after case 1; same operation resumes cases 2–3. Each run has one session/order/payment; no replay of case 1 | 49.555 s total, 187 commands, 4 external calls. 141565 returned bytes exposed a real control-history duplication problem; this is the before-fix measurement |
| Native/H5 checkpoint crash, `long-native-crash-2` | Same program and fault, with concise control delivery and waiting resume; original operation continues from case 2 | 50.190 s, 187 commands, 2 external calls, 4422 returned bytes; no repeated order or payment |
| Native/H5 cancellation, `long-native-cancel-2` | Cancel at an Agent question after verified case 1, then explicitly start the remaining cases from saved program state | 48.941 s, 187 commands, 3 external calls, 6820 bytes; cancel 131 ms; cases 2–3 had zero orders/payments at cancellation |
| Mixed commerce, `city-dispatch-reuse-3` and `-4` | Latest navigation deduplication and one-capture Flutter text dispatch; complete native address/H5 coupon/Flutter checkout journey | 28.014 / 25.934 s, 63 commands, 1 external call, 1486 bytes each; four server checks passed |
| Native expired login, `native-expired-session-1` and `-2` | HTTP 401 during checkout, reauthenticate, retain address and both coupon fields, then order/payment/refund/history. One order/payment/refund and restored stock | 27.390 / 22.611 s, 70 commands, 1 external call each; second run adds explicit server expiration and retained-address checks |
| Mixed expired login, `city-expired-session-4` and `-5` | Native address, H5 campaign and Flutter checkout; injected 401, retained draft, reauthenticate and complete refund | 39.508 / 29.373 s, 70 commands, 1 external call each, six server checks each |
| Real keyboard visibility, `keyboard-insets-visual-4` | Open the Android IME, observe its nonzero inset, explicitly hide it, observe zero inset and all four navigation destinations, then enter H5. Emulator keyboard preference restored | 5.294 s, 23 commands including setup/restoration and diagnostic reads, 1 external call; five checks |
| SDK-free NotallyX, `notally-uia-advice-after-1` | Single foreground-advice probe per semantic tap, same 27 taps and independently checked SQLite result as the prior successful baseline | 26.018 s, 55 commands, 1 external call; baseline 25.600 s. Tap time totals 11.968 vs 12.845 s, without a whole-flow speedup |
| SDK-free NotallyX, `notally-uia-advice-after-3` | Same note journey; the Script briefly reobserves only selector failures that explicitly report no dispatched effect | 27.059 s, 57 commands, 1 external call; two no-effect menu lookup retries, four UI checks and exact SQLite check |
| Final debug APK keyboard flow, `keyboard-current-apk-cold-2` | First actual launch of this installed APK, real keyboard show/hide, login and H5 entry; all five checks and preference restoration pass | 40.104 s, 19 commands, 1 external call, 1628 bytes; initial Flutter readiness wait 21.524 s. Functionally passed, performance target missed |

The native address title overlapped system bars in `city-visual-2`; the inset
fix is visually verified in `city-visual-3`. The cross-app H5 header had the same
fixture issue; its inset fix is visually verified in `native-h5-flutter-visual-loss-2`.
Different startup conditions make these unsuitable
as uncontrolled old/new speedup ratios. Two mixed-flow successes do not measure
P95 reliability.

Retained failures include `native-city-visual-1` (GET failure after H5),
`native-city-visual-3-loss` (test launch reused the old task), `city-visual-1`
(cold start timeout), `notally-uia-visual-1` (Host coordinate guard before a
semantic UIA click), `notally-uia-visual-2` (harness asserted before editor
transition completed), and `city-permission-visual-1` (harness confused an overlay
package with the permission controller). The permission continuation then found
the real numeric-flag parser defect. Failed results remain failed in their files.

Repairs demonstrated by this expanded matrix include bounded SDK endpoint reuse,
fresh lightweight Flutter captures, exact compound editor selectors, local
keyboard dismissal, nonblocking launch acceptance, retained failed-Script
diagnostics, UIA package filtering before node limits, semantic UIA clicks without
coordinate gating, configurable UIA readiness waits, and numeric Android
permission flags as nonblocking information.

### Repeated observation and control delivery work

`extract:{mode:"delta"}` is opt-in on existing commands. The first call supplies
a complete baseline; subsequent calls name that saved response ref. Fresh
captures and current bindings are retained. RFC 6902 changes address the complete
representation, including metadata. Column paths avoid shifting all columns when
one checkbox changes. Invalid/evicted bases and uneconomical patches return a
complete new baseline; they do not block execution.

Measured development iterations, full replies including control metadata:

| Run | Baseline / repeated / small-change bytes | Observation wall time | Independent validation |
| --- | --- | --- | --- |
| `delta-native-visual-change-1` | 5926 / 2061 / 2203 | 281 / 159 / 165 ms | Exact reconstructed original value; actual switch true → false |
| `delta-uia-visual-change-2` | 4308 / 2424 / 2732 | 254 / 296 / 189 ms | Exact reconstruction, fresh per-node refs; actual switch false → true |
| `delta-flutter-state-visual-1` | 19127 / 2044 / 2269 | 515 / 533 / 199 ms | Exact reconstruction; same label checked false → true after SDK state fix |
| `delta-uia-bound-reference-1` | 4309 / 2424 / 2652 | 250 / 266 / 198 ms | Click uses the full targetRef reconstructed from the second reply, then checks the updated tree |

Each three-sample run uses three observation calls and one mutation. Three saved
response reads are separate validation oracles, outside the observation timings;
they collect no additional trees. These measurements show response/context byte
reduction, not elimination of collection time or full-app acceptance. They were
recorded before the final explicit `encoding` marker was added to distinguish
application JSON from the column representation.

Final-wire repeats use that marker and independently reconstruct every complete
saved source: `delta-native-final-1` returns 5944 / 1999 / 2224 bytes in
246 / 159 / 165 ms; `delta-uia-final-1` returns 4327 / 2522 / 2750 bytes in
307 / 299 / 192 ms. Their switch states change true → false and false → true,
respectively; the UIA action uses the ref reconstructed from the preceding patch.
`delta-flutter-final-after-1` returns 19123 / 2062 / 2291 bytes in
831 / 347 / 194 ms and observes checked true → false. That Flutter run precedes
the navigation deduplication APK below. Mutation timing/bytes are also recorded
separately; oracle reads do not recapture the screen.

The earlier Flutter small-change probe (`delta-flutter-visual-change-2`) did not
expose checkbox state at all. It verified byte reconstruction only, not the
business change. The SDK now reports explicit checked/toggled/selected/enabled
state from controls and Semantics in its existing lightweight traversal. The
follow-up state run above observes the actual checkbox change.

The first long crash run revealed that `resume` returned all old events/history
and `wait.eventLimit` did not bound history. Current development code defaults
control replies to the latest event and ledger entry (with an explicit omitted
history marker), supports explicit full-history reads, includes ready results
in attention waits, and supports `resume.waitMs`. Regression work also found and
fixed idle status reads flooding heartbeat events and cancellation during the
single foreground probe escaping as an exception.

`long-native-cancel-1` is a failed harness attempt: its cancel request supplied
an unsupported `reason` field; the pending operation eventually timed out. It is
not a cancellation pass. The fresh `long-native-cancel-2` and
`long-native-crash-2` runs above pass. They establish recovery at verified case
boundaries, not cancellation of a payment with an unknown in-flight outcome.
The concise reply contract also
requires audit consumers to request history explicitly and decision consumers
to use `pendingQuestion`. Audit tests preserve their ledger, decision and
persistence assertions. Bounded history pages advance with
`history.lastSequence`; event pages advance with the last returned event's
sequence. The live `eventSequence` watermark is for progress waits and must not
skip undelivered audit records.

### Flutter dispatch and navigation regression

The public HTTP fixture exposed three Host captures for one `tap-flutter-text`.
The Host now captures once and sends that exact bound reference; Intent reuses
its existing observation. Live SDK epoch/Element/guard checks still reject
replacement or changed controls before input. Reusing foreground advice also
removes duplicated probes. One same-screen measured click changed from 2391 ms /
23221 returned bytes (`delta-flutter-final-before`) to 1050 ms / 11647 bytes
(`delta-flutter-final-after-1`). These are individual observations, not a stable
whole-workflow speedup estimate.

Real commerce then exposed a separate regression: control-state metadata made
a navigation label and its Semantics descendant become duplicate tap targets
(`city-dispatch-reuse-1`). The existing hit-region deduplication now merges
additional state into the one target. A real NavigationBar widget test clicks
the bound target and verifies selected state, while two separate same-label
buttons remain distinct. All 73 Flutter SDK tests pass. The installed updated
APK passes the two mixed commerce journeys above.

`city-dispatch-reuse-2` remains a failed cold-start attempt after installation:
the Flutter handler was unavailable throughout its 10-second readiness budget.
The process subsequently became ready; retained process logs show skipped-frame
bursts of 367 and 471. Those logs do not establish the cause. Cold startup must
be measured and fixed separately rather than hidden by a successful warm retry.
The latest whole-flow timings have not demonstrated a stable large improvement
over the earlier 26.740 / 33.155-second mixed runs.

### Keyboard, expired login and ANR findings

`city-expired-session-1` and `-2` failed before reaching the injected 401: the
screen showed the four navigation destinations and Android reported a hidden
IME, but Flutter retained a 336.38-logical-pixel bottom inset. SDK clipping made
the navigation disappear from the operable tree. Repeating a no-effect semantic
selection did not fix it. Explicit Flutter keyboard dismissal now asks Android
to redispatch real window insets; it never synthesizes a zero inset or removes
keyboard coverage validation. The dedicated real-keyboard test above observes
the hide animation's nonzero intermediate insets before zero. The receipt now
reports `dismissalRequested`, because dispatch completion does not prove that
native animation has finished. The Flutter SDK suite passes 75 tests, including
continued exclusion of a still-covered control after a hide request.

The native fixture now retains checkout fields on a real HTTP 401 and returns
to that draft after reauthentication. Mutation replay is explicit in the
program only after the rejected quote; committed order/payment work is checked
against the independent server ledger. Native and mixed expiration runs above
retain screenshots of the expired session and restored draft.

`city-expired-session-3` is another failed first launch after APK installation
(14.327 s, no session created). `keyboard-insets-visual-1` is a failed fresh
Activity launch (13.646 s). This latter run triggered a real system ANR. The
Android trace at 02:27:07 reports a focus event waiting 5000 ms. Its main-thread
native PCs symbolize to Dart `CallSpecializer::ApplyClassIds`, the compiler pass
pipeline, and `Compiler::CompileFunction`. The local unstripped Flutter library
has the same Build ID as the trace: `11d3d8669bdb9673e761f4f140c1ec267b5e4a29`.
This establishes JIT compilation on the main thread at the sampled ANR; it does
not identify the Dart function or prove that all cold/input stalls share one
cause. Flutter's [architecture documentation](https://docs.flutter.dev/resources/architectural-overview)
describes the merged Android platform/UI threads.

The ANR dialog persisted across app changes. It invalidated keyboard attempts
`keyboard-insets-visual-2` and `-3`, and later blocked the independent NotallyX
run `notally-uia-advice-before-1`. A UIA click on the observed system “Wait”
button temporarily allowed the keyboard test to complete, but the dialog
recurred. A wrapped ADB force-stop of the Flutter fixture removed it; this was
targeted process recovery, not a data reset. The successful NotallyX baseline
`notally-uia-advice-before-2` then took 25.600 s, 55 commands, one external call,
with the exported SQLite database independently checked. Cold-start/ANR behavior
remains a correctness/performance gap.

Failed text waits now return a bounded preview of the last successful read and
executable UIA/doctor hints, with no extra collection during failure formatting.
This makes a system dialog visible in the failure itself when UIA saw it. The
SDK's Flutter tree still cannot establish global native-window visibility by
itself. Successful waits omit the preview. A separate UIA dispatch regression
also confirmed two identical foreground probes per semantic tap; the Host now
collects advice once, retaining device-side target/epoch validation.

`delta-flutter-current-apk-1` repeats the final encoding on the navigation/inset
APK: 18485 / 1990 / 2214 bytes, 444 / 507 / 195 ms, exact independent
reconstruction for all three samples and an actual checkbox mutation. The
mutation took 822 ms. This precedes the receipt-only `dismissalRequested`
clarification; the APK build identity is retained separately.

### Final dispatch and validation follow-up

`notally-uia-advice-after-2` failed after 20.491 s at the restore menu. Its
semantic lookup reported `uia_selector_not_found`, `dispatched:false`; a new
snapshot 75 ms later contained the menu item. The Script now briefly retries
only this explicit no-effect condition, with a 1500 ms bound and 50 ms pause.
It never retries a dispatched or ambiguous click. The passing `-3` run includes
two such lookup retries; because the program changed, it is not a controlled
speed comparison with the baseline.

`keyboard-current-apk-cold-1` failed in 22.902 s before login. The launch command
itself took 18.023 s and returned an unknown completion. The original device job
contained its identity, command and worker source, but no launch marker,
admission marker or worker log. The screen remained in NotallyX, and the system's
last ANR timestamp still referred to the earlier 02:27 incident. This attempt
does not measure Flutter startup and is not evidence of a new ANR. The exact
dispatch stall remains unexplained. The subsequent `-2` run above actually
launched the APK and passed the UI checks, but missed the speed target.

Shell errors now retain their original identity and the phase, preparation
duration, phase duration and query count. They offer status, filtered archive
and UIA inspection commands. A separately reproduced bug classified cancellation
after preparation but before submission as an unknown effect. It now reports
the known non-dispatch without querying or restarting a never-submitted job.
All 34 focused shell, ownership and archive tests pass. This improves
classification and recovery information; it does not establish that the observed
live transport stall has been fixed.

The latest full CLI functional suite passes 1575 tests in 152.331 s, including
the final shell change; the Flutter SDK suite passes all 75 tests. The isolated
performance suite passes 50 tests in 20.124 s. An earlier attempt failed one validation consumer that
looked for child-start events in a latest-event-only reply. The consumer now
requests and advances explicit event pages; timing thresholds are unchanged.
The latest tarball clean-install and CLI/MCP reconnection verification also passes
in `package-current-development-3`, including the final shell change. That validation
now uses `pendingQuestion` for decisions and explicitly requests audit events.
`current-development-2026-10-13` preserves the dirty source snapshot, tracked
diff, final APK bytes, runtime fingerprint and verification logs. The package
tarball SHA-256 is
`9b907d6c70d8f8254e180213dfe77a43011126783023099ca98a007e8c0a297c`.
These are development artifacts, not a published release or overall acceptance.

### Explicit Flutter field preparation

`input-flutter-text` and the existing Flutter Intent `inputText` action accept
`focus:false`. This updates the observed editor through Flutter's normal input
formatters and `onChanged`, without tapping it, taking focus, or opening the
IME. The default still taps and focuses the field. Direct mode is suitable for
preparing form values; keyboard, tap and focus behavior must use the default.
The receipt identifies `inputMode:direct|tap` and omits invented coordinates for
direct input. Target identity, read-only state and native action permission are
still checked. The SDK suite passes 78 tests and the focused Host suite passes
31, including Android/iOS transport and JS/Python forwarding. The iOS checks
here are controlled protocol tests, not new real-device acceptance.

`direct-input-validation/report.json` retains a same-APK warm comparison on
`emulator-5564`, in order: default 30.277 s, direct 21.450 s, direct 21.638 s,
default 24.747 s. All four runs complete the same 63-command native/H5/Flutter
commerce journey in one external Script call, including seven screenshots and
independent server checks for address, coupons, one payment, one refund and
restored stock. The six Flutter inputs total 8.688 / 2.511 / 2.341 / 5.245 s.
The direct configuration also omits the keyboard-dismiss request; this compares
two supported input workflows, not a single isolated await. Two warm samples
per mode do not establish a general percentile. Prepared-flow timings exclude
discovery, authoring and build work.

The shared debug APK SHA-256 is
`57a278499865b453f40dc928269d78847c8e61869b769dcc31880f9c1e9b6849`.
Its first cold default attempt failed in 13.957 s while waiting for Flutter
readiness, before any login/session mutation. That failure is retained with the
comparison and is not resolved by the warm input improvement.

### UIA reads and normal version recovery

UIA snapshots now read current windows directly after clearing the accessibility
cache, without the unconditional global `waitForIdle(100,1000)` call. Readiness
continues to use the requested state predicate, and device-side node identity
and operability are checked before dispatch. The 50 UIA runtime unit tests pass.

The same SDK-free NotallyX Script completed before the change in 33.437 / 27.287 s
and after it in 26.520 / 27.234 s, each with one external call and independent
SQLite verification of the edited, pinned, restored note. Comparable warm totals
are essentially unchanged; this change is not a substantial whole-flow speedup.
The old/new bundles, code and command timings are retained in
`uia-idle-before-build` and `uia-idle-validation`. The new DEX SHA-256 is
`ce597f87b0dd360cbcff7ff7e1427198db818c2411f4b6059d92f0e5a0722516`.

The live bundle switch exposed misleading `uia_runtime_version_mismatch`
guidance: it suggested another start, which repeated the failure. This now
offers status, normal stop, then start, preserving history. The actual emulator
upgrade used this sequence without force-reset. All 28 focused UIA lifecycle,
selector and public-guidance tests pass.

The separately pinned Flexify Android checkout initially built and installed
under `com.presley.flexify.bridge_sample`. Its Dart Bridge was current, but a
later dependency audit found the native Android SDK still resolved from published
0.4.6. All 160 upstream locked
dependencies retain their versions. A comparison of all 1457 original files
finds changes only in Bridge initialization, pubspec and the added lock entry.
This is preparation evidence; its Android business workflow was not accepted by
that build. The corrected integration and later full result are recorded below.

### Shared lock false-positive reproduction

The next full functional run passed 1575 of 1576 tests. Its five-process device
ownership election admitted no owner. Forty ordinary synchronized elections
did not reproduce that timing-dependent failure, so the precise failed
interleaving was not captured.

A controlled SQLite-reader case does reproduce a definite false occupancy:
with no device owner and only a reader of the lock file, all five contenders
were rejected in all 40 rounds. The lock databases contain no application data;
they previously demanded an exclusive transaction, which excludes readers too.
They now reserve the sole writer with `BEGIN IMMEDIATE`. This preserves one
owner while allowing readers, as described in SQLite's
[locking model](https://www.sqlite.org/lockingv3.html). Device, Host Runtime,
project preparation, WDA preparation and browser preparation use the same mode.
No lock inode is replaced and no polling delay is added.

After the change, all 40 reader-contention rounds and all 40 ordinary rounds
admitted exactly one owner. The focused suite passes 47 tests, including old
exclusive-mode compatibility, real process death/unknown-action recovery and
preparation reuse versus an active preparer. Evidence is retained under
`ownership-lock-validation` and `ownership-lock-*-before/after.json`. This proves
the reader false positive is fixed; it does not establish the exact cause of
the original five-process failure.

The independent Flexify cold discovery failed after 35.078 s: launch took
2.969 s, then 39 failed reads exhausted the 30 s Flutter readiness wait. The
captured screenshot shows the real History screen. Later reads in the same
process succeeded with 24 operable nodes. This is a retained startup/observation
failure, not a passing cold-start result or evidence of a new ANR.

### Independent Android workout failures and persisted results

The Flexify Android debug APK is
`e100aaa56fccd5a5e6f09caa24e6dd00dd5b78539f2df755755943982891f027`.
The first workout stopped at the real notification permission dialog. After
observing and allowing that exact system prompt, the original Save completed;
it was not submitted again. Explicit continuations exposed two authoring errors:
the editor label is `Weight (kg)`, and Android uses the observed Back control.
Both failures and the partial continuations remain recorded.

The next full run took 57.670 s and 47 commands. Creation, editing, cancelling
deletion and History passed, but the Script incorrectly assumed Volume was the
initial graph metric; Android starts on Best weight. The corrected next run
took 55.643 s and 44 commands, then failed before tapping Graphs because its
Flutter observation timed out. Neither attempt completed the Android
workout/graph journey. These are measured failed attempts, not sub-minute passes.

The latter failure also revealed a Host diagnostic defect: `tap-flutter-text`
turned `flutter_observation_timeout` into `observed_flutter_tree_required`.
The Host now retains the original error, message and observation details without
another read or action dispatch. The reproducing regression fails before the
change; all 13 focused semantic/Flutter wire tests pass after it.

After stopping only this sample, the independent quiescent SQLite snapshot
passes all 11 checks for each of the three unique plans: exact two sets,
14 repetitions, 625 kg, edited value and preserved cancelled deletion. Records
are under `flexify-android-db-final-3` and `flexify-android-db-check-1/2/3`.
Two earlier recursive archive attempts timed out and remain recorded; copying
the observed database and any matching journals directly succeeded. The DB
proof does not make the incomplete UI journeys pass.

### SDK integration audit and latest native/UIA reruns

The latest Host functional suite passes **1581/1581** in 154.182 s, including the
lock changes and preservation of Flutter observation errors. The native Python
workflow then passes in 14.520 s from public submission: 36 commands, one
external call, 1924 response bytes and all nine checks. These results are retained
under `post-lock-and-observation-validation` and `python-native-post-lock-1`.

`flexify-android-observation-profile-3` retains a Dart VM CPU sample window for
20 read-only observations. Seventeen reads fail; only three return nodes. The
profile contains `_snapshot`, `_layoutSnapshot`, `_widgetDump` and extensive
diagnostic text rendering despite the Host requesting `scope=operable`.
Gradle `dependencyInsight` confirms the first integration resolved published
Android SDK 0.4.6; only the Dart plugin used current source. Those failures are
therefore also compatibility/integration evidence, not acceptance of the current
native SDK. Profiling adds overhead and is not a benchmark sample. The VM's two
main isolates were recorded; this alone is not a demonstrated cause of failure.

The corrected preparation accepts a freshly built, hashed Android debug AAR and
adds it to the sample while excluding the plugin's published Android dependency.
Directly including the SDK Gradle project failed against Flexify's AGP 9 DSL;
the AAR preserves each project's declared build toolchain. The new package is
`ad3010ce2087206d53f36ebc5200af31cc741133d9a3f65646662fa44f1f1dc1`.
Its source census changes only pubspec/lock, Bridge initialization and the two
Gradle dependency declarations. No workout or persistence source changes.

The latest SDK-free NotallyX run failed because a previously visible note was
outside the restored list viewport. Search found the exact saved edit and pinned
state. The regression now uses the observed Search control when the target is
not visible, opens the exact returned reference and handles the editor's search
mode before inspecting its regular toolbar. An explicit continuation retains
the original note ID; it never creates a replacement note or retypes the edit.
One continuation encountered an observation timeout and a 24 s screenshot; a
later one passed persistence checks but exposed the search-toolbar assumption.
Both failures remain under `notally-uia-post-lock-recovery-1/2`. The second
quiescent DB snapshot independently contains the exact edited note in NOTES
with pinned=1; it does not turn that failed UI continuation into a pass.

### Current-layout reads and four-target continuation

Operable Flutter reads now inspect the displayed, committed layout without
requesting a new frame while the scheduler is idle. A read during build/layout
waits for that frame, and full diagnostics still prepare Semantics. The new
real-widget regression fails on the prior implementation: a read never finishes
without pumping an extra frame. It now finishes without scheduling one, sees the
old displayed layout before a pending build, and the new layout after the build.
All **79 Flutter SDK tests pass**. Frame-wait failures retain scheduler/lifecycle
diagnostics; native channel timeouts remain distinguishable by their absence.

The rebuilt independent Flexify APK is
`c6cd6875020b51a223067e295179a1fa24ee463cfa70e1e8f17d0826888c3dbb`;
native AAR is `c4ba04be1fbb1bf3767f73221c37685c92e6e0842c2bbe23883e529ae45157b9`.
This change has **not** solved cold readiness: corrected-SDK discovery took
24.812 s before and 24.225 s after, with 14 and 17 failed reads respectively.
These individual samples are not a demonstrated speedup. A separate 20-read
probe took 17.968 s including launch: the first read reported runtime change,
the second a native-channel observation timeout, then 18 reads succeeded.
Later reads took 197–370 ms. Evidence is in `flutter-current-layout-build`,
`flexify-android-current-layout-discovery-1` and `flutter-current-layout-cold-reads-1`.

`flexify-android-current-layout-workout-1` is the first complete independent
Android workout/graph pass: **34.941 s**, 50 commands, one external call,
1475 bytes. Launch plus initial readiness consumes 16.579 s of that total.
This recreates the Activity in an existing process; it is not a cold-process
benchmark. There are no business-step continuations in this run. The initial
readiness budget is explicitly 30 s and its entire duration remains included.
The stopped-process snapshot takes a further 1.365 s in a separate Script.
`flexify-android-current-layout-oracle-1` passes all 13 independent SQLite
checks: one new Friday plan, exact two sets, 14 repetitions, 625 kg per plan,
the edited value, cancellation preservation and 2500 kg in the observed day.
The graph screenshot shows Volume and 2.5K. The data check does not establish
broader graph-layout correctness or whole-App coverage.

SDK-free `notally-uia-post-lock-2` exposed a transient duplicate visible note
after returning from the editor. The harness now briefly observes again without
choosing either target. `notally-uia-post-lock-3` captures two distinct references
in the same UIA window, followed by one unique note; its independent SQLite
query confirms one matching record. The complete create/edit/pin/archive/restore/
trash/restore/restart flow passes in **35.377 s**, **102 commands**, one external
call and 1901 bytes; including the external oracle takes 35.429 s. The extra
search path handles a long existing list, verifies each opened title and exits
in-note search mode before checking the normal toolbar. Ten UI checks and exact
edited body/NOTES/pinned=1 persist after restart. This is a more involved scenario
than the earlier 55-command flow, not a controlled before/after speed comparison.
The earlier failed `recovery-3` and its explicit Restore remain recorded too.
Selector retries are bounded and require a receipt proving no dispatched effect;
unknown mutations and stored target references are never replayed by this case.

The native Python result remains the separately measured **14.520 s / 36 commands**
pass above. The mixed app is rebuilt with the same Dart change as APK
`760d4c531756d17efbb3410d92892b47d21ee2e2b539ece5f980d5ff7a12aece`.
Its first post-install flow, `city-current-layout-1`, fails in 13.615 s at the
10 s observation deadline, with `flutter_action_handler_absent` as the last
recorded error. The server has zero sessions, orders or mutations. That cold
failure is retained and is not replaced by a subsequent warm result.

`city-current-layout-2` subsequently completes the same mixed city flow in
**24.989 s**, 63 commands, one call and 1486 bytes. All four independent
server checks pass: H5 coupon/native address persistence, two discount types,
exactly one payment and refund, restored stock. This is not a demonstrated
whole-flow speedup over the earlier 21.450/21.638 s direct-input warm samples.
`native-h5-flutter-current-layout-1` completes the real response-loss variant in
**19.997 s**, 51 commands, one call and 1524 bytes. All four checks pass:
Native, H5 and Flutter each commit once, the same record/form survives Activity
recreation, the lost response is reconciled without resubmission, and the final
revision spans all three providers. Server state records exactly one save,
approval and Flutter update. Both runs freeze their Script and helper sources
alongside screenshots, command timings and the server journal.

Public diagnostics now add valid read-only next calls for Flutter observation
unavailability and UIA reference/selector mismatch. Existing dispatch and
ambiguity facts are preserved, including unknown outcomes; formatting a hint
does not execute or replay anything. Both reproducing guidance tests failed
before this fix. All **25 focused guidance/semantic/Flutter wire tests pass**.
The subsequent current Host functional run passes **1583/1583** in 153.314 s;
`current-host-validation-2026-10-13` freezes hashes for all 176 Host source files.

### Observation cost investigation

`flexify-android-current-sdk-profile-1` samples the corrected integration.
Twenty reads include seven failures (timeouts and no root Element), followed by
thirteen successes. The 1007 CPU samples include operable traversal and hit
testing, with no captured full widget-dump path. Profiler overhead means this
run is diagnostic, not a latency baseline. The registered Bridge can precede
the App's `runApp`: the pinned main function awaits CrashLogger and its settings
database first. This explains why a missing root is possible, but does not
establish the cause or duration of every startup stall.

A candidate reused hit paths within one synchronous observation. Its real-widget
test reproduces eight hits at the same point before the change, requires one
afterward, and verifies that adding/removing an overlay changes the next read.
All 80 Flutter tests pass. The first implementation copied each path into an
identity Set. Actual warmed-page medians were 325.5 ms before and 350.5 ms after
(30 reads each), so that version is **not an accepted speedup**. The final
implementation retains the original hit result without constructing those Sets.
These candidates never reuse a prior observation's hit result for a new read or
for action validation. Their build/test evidence is under `flutter-hit-reuse-build`
and `flutter-hit-path-build`.

The Set candidate's `flutter-hit-reuse-cold-1` fails a 30 s readiness budget,
41.079 s overall. Its screenshot remains on the launch screen; scoped logcat
records Flutter resource extraction, database initialization and skipped frames.
This does not prove that the small hit-path change caused the startup stall.
`flutter-hit-reuse-cold-diagnostics-1` retains the actual process log and identity;
later reads in that same process succeed without data reset.

With 30 warmup reads before each measured group, the original implementation
has a 308 ms median and the final implementation 211.5 ms for the following
30 reads each (**31.3% lower in this page sample**). Both groups succeed and
return 61 nodes; the two changed labels are the App's relative-time strings.
`flutter-hit-path-comparison` retains every sample and visible-fact difference.
This is one-page read latency, not a whole-App speedup or a P95 estimate.

The control installation also experiences a failed launch/screenshot before any
Flutter read: launch 15.040 s, screenshot 30.011 s. The first summary incorrectly
called its second command `readinessMs`; the source now selects timings by
command name. Frozen evidence is unchanged and the correction is stored in
`flutter-hit-path-comparison/control-cold-timing-correction.json`. Subsequent
ADB/device ownership/UIA checks are healthy; App SDK status alone times out.
An explicit fresh discovery then succeeds in 30.371 s. No reset or data clearing
was needed; neither the failure nor this recovery counts as a cold-speed pass.

The current CLI tarball passes `current-package-validation-9`: fresh installation,
native prebuild loading with compiler/Python unavailable, and controlled CLI/MCP
execution. Its SHA-256 is
`8bf4740a6e478322b43545138feebb26dc3669105333698d8f2818f1a6a76c98`.
The first package-verification invocation omitted the required output directory
and performed no validation; the corrected invocation above is the passing run.

The final hit-path implementation passes the complete independent workout again
in `flexify-android-hit-path-workout-1`: **37.433 s**, 47 commands, one call,
1475 bytes. Launch/readiness consumes 18.307 s. Graphs already have Volume
selected, hence three fewer commands than the earlier 50-command case.
`flexify-android-hit-path-oracle-1` independently passes all 13 SQLite checks,
including the new exact two sets, 625 kg per plan and 3125 kg for the graph day.
The App APK is `a16eaecef490cbec0b1940f10201474a7c2fbe9d81521e36e0f56f4bab8f0c01`.
This passing whole-flow time is slower than the earlier 34.941 s sample;
the one-page read improvement must not be presented as a whole-flow speedup.
The mixed APK with the same Dart code is
`287a5bf0c14c133db60c06910ea177198a1354fbdb257e7c22595a8213a9324b`.
The shared lab helper now allows 30 s for initial readiness and 10 s for later
page predicates; every actual wait remains included, and there is no fixed sleep.

`city-hit-path-1` completes the current mixed SDK's full commerce flow with a
real HTTP 401 at quote: **24.054 s**, 70 commands, one call and 1648 bytes.
All six independent checks pass. The saved native address, both coupon types
and checkout fields survive reauthentication without refilling; the server
records exactly two sessions, one order, one payment and one refund, with stock
restored. This repeats recovery across Native, H5 and Flutter with the final
Dart implementation, not only a Flutter-only page. Full timing includes launch,
the initial readiness wait and the expired-session branch.

The final native HTTP login rerun, `native-intent-final-1`, passes with one
autonomous Intent in **1.522 s**; launch/readiness plus that Intent takes
**2.473 s** and three external calls. The Intent executes two field inputs,
agreement, submit and a result predicate, then observes the authenticated merchant
response. The isolated server records exactly one session. The already installed
and previously running native App is reused; this is a prepared, warm-process
case, not first-use discovery or installation. Intent response size is 27,525
bytes (57,396 bytes including separate launch/readiness). Its agent and runner
sources are frozen beside the actual replies and server state.

Still required before completing the overall goal: repeat/fault coverage across
the richer commerce paths, independent real Flutter repeats, in-flight ambiguous-mutation
recovery, longer mixed/UIA execution, cold startup/first-input stalls, and full
discovery-to-result wall time. iOS/Web real-device acceptance and current K2 hardware acceptance have
not been established by these Android emulator runs.

### Bounded observation failure and current cold launches

`observation-watchdog` reproduces a real Android SDK fault: blocking the Android
main thread also blocked the Flutter observation's 2-second timeout, ending in a
socket read error instead of an observation result. The regression uses the real
SDK local socket and Android main queue, with a controlled Flutter channel peer.
After moving the deadline to an independent scheduler, the same blocked-main
case replies in **2.028 s** with `phase: android-main-queue`; an unresponsive
channel replies in **2.131 s** with `phase: flutter-channel`. Expired queued reads
never execute later, and an old callback cannot overwrite a subsequent successful
snapshot. All **7 device fault tests and 200 Android unit tests pass**. This proves
bounded failure delivery, not faster App initialization or real Dart behavior in
the controlled channel tests.

The rebuilt real App APKs include this scheduler. `flexify-watchdog-workout-1`
completes all 47 commands in **48.352 s**, one call and 1475 bytes, on the first
launch after APK replacement. Launch/readiness accounts for **29.986 s**. All
13 independent database checks pass, with exactly two new sets, 625 kg for this
plan and 3750 kg for the graph day. `city-watchdog-1` completes 70 commands in
**51.906 s**, one call and 1648 bytes, including **28.345 s** for launch/readiness.
Its six server checks pass for the native address, H5 coupon, actual HTTP 401,
retained checkout fields, exactly one payment/refund and restored inventory.
These slower cold samples are retained alongside the earlier warmer samples;
neither is evidence that cold startup is fixed.

The final Host change retains provider observation details in `wait-text` instead
of replacing them with only a generic message. The reproducing test fails before
the fix; all **44 focused wait, semantic-target and guidance tests pass** afterward.
Actual public Script discovery in `flexify-watchdog-discovery-1` takes **30.282 s**
and retains `flutter-channel`, 2000 ms, and 44 failed reads in the successful
wait's diagnostic summary. The wait itself takes 24.616 s. This identifies the
last failed boundary without another diagnostic read; it does not establish the
cause of all startup delay.

`native-intent-watchdog-1` verifies the same current Host against the native HTTP
login: **2.420 s for one autonomous Intent**, **8.167 s including launch/readiness**,
one server session, and three external calls overall. Earlier 1.522 / 2.473 s
results remain separate samples. `latest-four-target-results` collects the latest
native, SDK-free UIA, independent Flutter and mixed results and explicitly keeps
overall acceptance false. Full discovery/planning, longer fault runs and startup
performance remain work in progress.

The preceding Host revision passes all **1583 functional and 50 performance
tests**, with source hashes in `current-host-validation-2026-10-13`. The final
wait-diagnostic revision passes all **1584 functional tests** in 153.920 s;
`current-host-validation-watchdog` freezes the full output, runtime identity and
176 Host source hashes separately from the preceding build.

### Cold-start controls across SDK and UIA

`cold-start-contrast` compares the pinned upstream Flexify with no Bridge against
the integrated APK on the same emulator, package and retained business data.
The original archive's 1457 source files remain byte-identical in the baseline;
each APK replacement uses `install -r`, and each measured launch stops the sample
process first. The baseline APK has no Bridge dependency in its lockfile or DEX.

Two baseline UIA waits for the exact visible `Add` control take **22.502 s** and
**21.322 s** including launch. The integrated UIA cases take **31.734 s** and
**34.498 s**; Flutter-provider cases take **30.660 s** and **30.940 s**. These
are startup comparisons, not business-workflow results. A discarded baseline
predicate waited for `Plans` although the actual UIA description was
`Plans\nPlans`; its 45-second timeout is retained as a harness failure, not a
measurement of startup. Exact `Add` was observed through both providers before
the corrected comparison.

Controls with no early UI/SDK polling show Android first frames at **17.170 s**
without Bridge and **27.305 s** with Bridge. Tagged diagnostic builds then locate
a **13.140 s** retained fact-store open, overlapping App initialization, whereas
the Flutter plugin's repeated `start` calls take milliseconds. The Android
provider also initializes WebView before an Activity; measured overhead varies
from 0.422 s to 1.997 s in the diagnostic processes. These measurements identify
startup work, not independent costs that can simply be added together.
Temporary instrumentation is retained only in clearly named diagnostic source
copies/APKs; the repository and normal integration sources are restored.

### Mapped fact-store I/O and cross-target reruns

`MappedSegmentedFactStore` now transfers payloads, zero padding, CRC input and
commit-marker scan input in bounded 8 KiB chunks instead of repeatedly crossing
the direct-buffer boundary for individual bytes. The portable file format,
CRC32C, aligned commit-marker checks and corruption detection remain unchanged.
The new tests compare CRCs against an independent implementation across heap
and direct buffers, preserve buffer state, and reject cleared committed headers
around chunk boundaries without modifying the corrupt files. All **202 Android
unit tests pass**. The device probe reopens eight retained partitions and reads
all 64 exact 24 KiB records; it passes with the final implementation.

The first candidate used an allocation-heavy predicate inside the marker loop.
Actual device testing rejected it: its first recovery took **30.595 s CPU**.
That failed candidate remains under `fact-store-bulk-io`; it was not installed
in the business App. Current artifacts are specifically in
`fact-store-bulk-io/attempt-2`, whose AAR SHA-256 is
`6a63cacbe6a38a189eb7e58124817ad3842b37796a04b2afba23cf0c114107c9`.

Warm recovery CPU samples change from **267/309/347 ms** to **31/25/33 ms**.
However, the isolated fresh-ART-process control changes from **141 ms** to
**180 ms** CPU, and does not reproduce the App's 13-second store opening.
The microbenchmark therefore supports reduced warm scanning cost, not a claim
that all cold startup cost is fixed.

The first full-App launch with the final candidate times out at 45 seconds;
reinstalling the original APK immediately afterward also times out. Both failed
records remain in `cold-start-contrast`. Host inspection then finds about 77 MiB
free RAM and three idle Gradle daemons from this task's own builds. Their build
directories and idle logs are verified before orderly termination. This frees
about 8.9 GiB; unrelated processes are untouched. Subsequent builds disable the
daemon. This is a test-environment correction, not a product speedup.

After that correction, original-SDK launch plus first visible `Add` takes
**33.689 s**. The current SDK takes **24.816 s** and **25.529 s** in the next two
process-cold runs, each one public Script call. APK replacement and sample order
are retained; this small sequence is not a distribution or a general speedup
guarantee. Startup remains slow. `cold-start-contrast/comparison.json` retains
all controls and failures instead of selecting only successful measurements.

Current business reruns cover more than Flutter:

| Target | Current result | Timing boundary |
| --- | --- | --- |
| Native HTTP login, `native-intent-bulk-1` | One autonomous Intent; exactly one server session | 5.075 s Intent, 13.584 s with launch/readiness; 3 external calls overall |
| Native actual Python, `python-native-bulk-1` | 36 commands, 11 pages, all 9 checks; replaced control rejected and recovered | 14.015 s, 1 call, 1928 bytes, including stop/relaunch |
| Native + Flutter + H5, `city-bulk-1` | 70 commands; actual quote HTTP 401, retained draft, reauthentication, one payment/refund, restored stock; all 6 checks | 40.579 s UI, 40.583 s with server oracle; 1 call, 1648 bytes; launch/readiness 18.477 s |
| Independent Flutter, `flexify-bulk-workout-2` | 50 commands; plan, sets, edit, cancelled delete, History/Volume; all 13 SQLite checks | 41.764 s, 1 call, 1499 bytes; cold launch/readiness 23.327 s; external snapshot/oracle separate |

The latest independent Flutter repeat (`flexify-bulk-workout-1`) reveals a
retained-data harness failure: the new plan is saved once but its row is below
the viewport. Waiting for its text expires after 10 seconds. The attempted
search continuation fails too: upstream searches days/exercises, not titles,
and the input's own value falsely satisfies a text-only presence check. The
stopped-process database confirms one saved plan. Both failed runs remain
failed. The corrected harness reveals the actual list row and resumes the
existing plan without repeating Save. `flexify-bulk-plan-recovery-2` takes
44.835 s including its own cold launch, and its independent oracle passes all
13 checks. The two earlier attempts took 46.673 s and 16.868 s. First attempt
through recovery, including agent investigation and source correction,
takes **420.038 s**. This is evidence that a wrong discovery assumption can
still make the real task take minutes; it must not be replaced by the later
prepared-script timing. The separate fresh run in the table passes with the
corrected list handling and the same retained business data.

`long-mixed-bulk-1` then executes three complete Native + Flutter + H5 journeys
in the same JavaScript Script: normal checkout, HTTP 401 with retained checkout
fields, and response loss after payment commit. The last case observes the
transport error, uses the App's order query and refunds without submitting
payment again. **201 commands finish in 62.326 s**, or **62.334 s** including
the independent server oracle. There are two external calls (start and wait),
one operation ID, 7479 response bytes, and no agent intervention. The individual
program cases take 26.005 s, 18.454 s and 17.580 s; all 16 checks pass. Each
server run records exactly one order, payment and refund and restored stock.
These are prepared repeated journeys. The run establishes longer mixed
execution and HTTP-result reconciliation, not recovery from Host/worker death
while a dispatched mutation remains unresolved.

### Explicit Script recovery after a submitted payment

`payment-interruption-1` reproduces a missing recovery choice in the old Host:
the worker receives the real Flutter payment-tap receipt, then exits before
committing its next program checkpoint. The App's HTTP payment request finishes
after the worker stops, and the server deliberately loses its response. Ordinary
resume reports `checkpoint_precedes_action`; replaying the old program state
would submit payment again. The first server assertion sampled before commit
and failed; that failed sample remains alongside the later committed state.

Script `resume` now accepts explicit `recovery.checkpoint:{name,state}`. It
persists the Agent's chosen entry state before starting the frozen original
source; old receipts, missing receipts and unknown effects remain unchanged.
New action IDs continue forward. Concurrent recovery starts once; a failed
checkpoint write starts no child. A settled cancelled program can also receive
an explicit continuation. Live pause/resume and completed-operation semantics
remain distinct. This is a continuation choice in the existing Script API.

After replacing the development Host, the original operation
`script-1791847936911-29` resumes at its order query and refunds exactly once.
Recovery takes **5.109 s**, but first attempt through investigation, implementation
and recovery takes **898.283 s**; the latter is the actual first-use wall time.
`payment-interruption-2` repeats successfully in **43.513 s**, including the
manual gap between the two runner invocations, with 8.805 s for recovery itself.

The fully chained repeat, `payment-interruption-3`, takes **26.625 s** from
setup through checkout, deliberate worker crash, ordinary-resume diagnosis,
explicit order-query continuation, refund and independent server assertions.
There are **65 commands, three public Script calls and 5244 response bytes**;
recovery itself takes **2.839 s**. The payment request starts at
1791849170175, the failed child result is returned at 1791849170272, and the
server records the payment at 1791849170400. Thus the payment is actually in
flight across worker termination. The final ledger has exactly one 4100-unit
payment and one matching refund, one original order, and restored stock.
The App stays running; this does not prove termination/recovery of the App or
an unknown phone-side UI action. The fixture uses its isolated test ledger.

The Host functional suite passes **1597/1597**, the performance suite **50/50**,
and the expanded explicit-recovery suite **14/14**, including actual JavaScript
and Python child processes, live/restored Hosts, missing receipts, cancelled
programs, concurrent recovery and checkpoint-storage failures. CLI-to-MCP
recovery is exercised separately through the public runtime.
`package-explicit-recovery-1` also passes a clean npm tarball install, npx,
installed CLI/MCP contracts, shutdown/restart checks and the explicit recovery
entry. The tarball SHA-256 is
`c2af92ab41ce1d87df7c2f95bf8f9c65ad585f8eb09cc939cc8430caaa70b0d9`;
this is a local package validation, not a publication.

### Long execution in an SDK-free native App

`notally-uia-long-1` runs three complete NotallyX journeys in one JavaScript
operation: create, edit, pin, archive/unarchive, delete/restore, stop the App,
copy its database and reopen the exact note. UIA and wrapped ADB drive the
SDK-free build; no Bridge-instrumented controls participate. **321 commands
take 103.498 s**, or **103.635 s** including the independent SQLite checks,
with two external calls and 8933 response bytes. Individual cases take
41.366 s, 31.242 s and 30.569 s. All 30 UI checks pass, and successive database
snapshots contain exactly one of every earlier note, with the exact edited
body, Notes folder and pinned state. This is a three-journey endurance result,
not a claim that the entire App or all three journeys finish within one minute.

`notally-uia-long-crash-1` then exits its actual JavaScript worker after the first
verified checkpoint. Ordinary resume continues cases two and three under the
same operation ID: **308 commands, 104.357 s UI / 104.476 s with SQLite checks,
two calls and 6439 response bytes**. Continuation takes 58.729 s. All 30 UI
checks and three cumulative database snapshots pass; the first note is not
created again. The App itself is not killed at the Script interruption point;
each case separately verifies its own App stop/reopen persistence.

### Host loss during an admitted Native gesture

`native-host-loss-1` and `native-host-loss-2` use the Native sample's real
`Native Increment` control. The runner starts an eight-second long press,
confirms its exact action ID in both SDK status and Host ownership, and sends
SIGKILL to the verified development Host. It never kills an unrelated installed
runtime. A new Host reads the original Script and observes the device result.
Only after SDK status confirms the gesture has finished does reconciliation
retrieve its original completion receipt; this test does not cancel an active
gesture or replay it.

The second run takes **11.540 s**, including the deliberate eight-second gesture,
Host restart, result query, continuation and independent state verification.
There are 16 public calls and 56849 response bytes, including fault-injection
polls. Explicit continuation takes **1.469 s**. The App records counter 1
7.900 seconds after Host death, then counter 2 after the one newly requested tap.
The two screenshots, original Native completion identity and state records
agree; the original action is not replayed. This establishes Native SDK action
survival across Host loss on the emulator. It does not establish phone process
survival, UIA/Flutter executor-death recovery, or current K2 hardware acceptance.

The first run also exposes a diagnostic error: read-only Script status after
Host loss returns a top-level `ambiguous` failure when a completion receipt is
missing. The current Host separates query success from the interrupted program's
unknown outcome. `status`/`wait` now return the saved state and recovery facts
without starting a child or changing receipts; ordinary resume still preserves
the unresolved action. Actual Host-loss run 2 verifies this corrected public
response. The focused restore/recovery suites pass **52/52**, and the full
functional suite passes **1601/1601** in 161.209 seconds. The earlier full run
has nine failures and three cancellations during recorded Mac clamshell and
maintenance sleep. That log and its power events remain in
`current-host-validation-native-loss`; the passing rerun changes neither source
nor timeout thresholds. Current Host fingerprint is
`590eed6d9ffddc47c2491a9ae914e3fc91bb905524553d6ea91292a050e44232`.
The earlier package-validation tarball predates this read-only restore fix.

### Launch receipt and current startup controls

The default launch path still performs a synchronous window-manager query after
Android has accepted the start request. A new regression supplies a successful
launch followed by a failing foreground service; the old implementation loses
the success and throws `provider_timeout`. Default `launch-app` and
`launch-activity` now return the original start receipt immediately. The caller
can wait for a business condition in the same Intent/Script. Explicit
`waitForLaunch:true` retains Android launch waiting and foreground observation.
The focused CLI, shell-settlement, feedback and Script-result suites pass 99/99;
the final full functional rerun passes **1601/1601** in 193.882 seconds. The
current source manifest and logs are in `current-host-validation-launch-receipt`,
with Host fingerprint
`43370727f8e414dc88619b45c55245c489b74f2871c3475d1f95ad0716c1dd2e`.
These worktree changes have not been published.

`native-intent-launch-receipt-1` passes a fresh isolated HTTP login run with one
autonomous Intent in **1.676 s**, or **2.895 s** including navigation, readiness
and the independent server assertion. There are three public calls overall and
exactly one server session. The Native App process was already warm; it is not
a cold-start comparison with the earlier 13.584-second run. Its launch response
retains the settled shell receipt and contains no foreground probe or warning.

The unchanged installed Flexify APK gives **4.801 s** and **34.565 s** process-cold
readiness before this launch change (`startup-current-awake-1/2`). Afterward,
`startup-launch-receipt-1/2` gives **4.096 s** and **3.939 s**, including the
launch request and the first exact visible `Add` observed through UIA. Launch
receipts take 483/481 ms. This sequence alone cannot establish causality for
the earlier stall.

`startup-foreground-control-1` then uses an alternating probe/no-probe/no-probe/
probe sequence on the same current Host and APK. Each case stops only the App
process, confirms it is absent, launches, and waits for the same visible label.
The explicit control adds the previous `dumpsys window -a` query through wrapped
ADB after the launch. First-screen times are **4.311/4.121/4.317/4.883 s**; the
two added queries take **66/56 ms**. Thus this correction removes unnecessary
work and the reproduced failure coupling, but this control does not explain
the 34-second startup. That outlier remains in the comparison and overall
acceptance stays incomplete.

`startup-profile-flexify-1` retains a 5 ms Java stack-sampling trace from the
unmodified APK, the frozen diagnostic and its parser. Profiling was explicitly
stopped before pulling the trace. Its reported ART wall-clock deltas are smaller
than thread CPU deltas, so the parser flags `wallClockConsistent:false`; those
clock values are not used to claim elapsed startup costs or speedup. The
instrumented launch is separate from the uninstrumented measurements above.

### UIA executor death in the SDK-free native App

`notally-uia-recovery-build` freezes the UIA-only NotallyX fixture source,
manifest, build/install receipts and APK. Its APK SHA-256 is
`30b2a12eb38b5cb1b84850e167a07cc8d70faf7813b6572b12f67055db340836`.
The APK defines the new plain Android recovery Activity and no Bridge Android
SDK classes. Normal NotallyX business code is unchanged by this fixture.

The fixture fsyncs a callback-entry record, deliberately blocks that callback
for eight seconds, then fsyncs its actual effect. A worker armed through public
wrapped ADB kills the exact UIA PID only after entry. Before killing it, the
worker matches the device boot ID, runtime epoch, PID start ticks and command-line
hash. This proves interruption during a real admitted accessibility action,
without terminating the App or Host. After restart, the same App process
finishes the original effect exactly once; a newly requested action increments
the counter from 1 to 2. The original UIA record remains `admitted` with no
receipt, byte-for-byte unchanged in the retained session or force-reset archive.
The App journal proves the effect; it cannot manufacture a missing executor
completion receipt.

All five public Script attempts are retained:

| Evidence directory | Recovery and scope | Wall time | Result |
| --- | --- | ---: | --- |
| `notally-uia-executor-loss-start-1` | Normal start, controlled fixture | 12.105 s | 28 commands, one call, counter and archive checks pass |
| `notally-uia-executor-loss-reset-1` | Force-reset, then business module loading | 27.714 s | Recovery checks pass; runner fails to resolve a sibling module from the temporary Script artifact |
| `notally-uia-executor-loss-reset-2` | Force-reset plus full note journey | 47.302 s | 136 commands, one call, ten UI checks and independent SQLite row pass |
| `notally-uia-executor-loss-guidance-1` | Normal start using returned recovery hints, full note journey | 47.863 s | 137 commands, one call / 2606 response bytes, ten UI checks and SQLite pass |
| `notally-uia-executor-loss-guidance-reset-1` | Force-reset using returned recovery hints, controlled fixture | 20.948 s | 30 commands, one call, counter and archive checks pass |

The business journey creates a unique note, edits and reopens it, archives and
unarchives it, deletes and restores it, and force-stops/reopens the App to verify
persistence. The external SQLite assertion requires exactly one matching note,
its exact edited body, `NOTES` folder and pinned state. This is a prepared native
UIA workflow, not a Flutter result or a claim that every App feature completes
within one minute. Durations include the deliberate eight-second stall, recovery
and verification. They exclude build/install and time spent implementing the
test or correcting its import path. The failed runner now loads its frozen
dependency by explicit absolute path; sibling `require` resolution is a separate
Script authoring issue, not a corrected runtime capability.

The live failure reveals two missing guidance paths: generic `command_failed`
with nested `uia_runtime_unreachable` receives no executable recovery hint, and
Script's ambiguous-result envelope drops guidance from its top level. Both are
fixed without changing the original error or uncertain dispatch. The response
now offers an exact retained-receipt query, UIA start, current-tree observation
and optional force-reset. Actual runs above use those hints, verify that the
original receipt is absent, and continue without replay. Ordinary start reports
unresolved history as nonblocking information; force-reset retains unknown
history in an archive. The two new regression tests fail before the fix; the
focused suites pass **75/75** afterward. Current Host fingerprint is
`d0a5bf2d5c752bb0a9735c5b7931e8a120d7c2481efa98c52f9ffc8ff308b794`.
The full functional suite passes **1603/1603** in 197.087 seconds; its logs,
two failing-before-fix regressions, exact source manifest and all five live
attempts are linked from `current-host-validation-uia-executor-loss/report.json`.
No package publication is implied by these local results.

This closes the actual UIA-process-death test on this API 36 emulator. Cold
startup variation, first-use discovery-to-result time, and equivalent
Flutter-executor recovery coverage remain separate acceptance work. The
source-file module-loading issue above was fixed in the following revision.

### Script module imports and durable working directory

Four real-child regressions reproduced JavaScript and Python sibling imports
resolving from the temporary artifact or SDK directory. Script now executes the
frozen entry bytes under the declared source identity: CommonJS sibling and npm
resolution, circular imports, Python packages, dataclasses, and relative assets
work using ordinary language rules. Inline source has a virtual filename in its
declared working directory. Imported dependencies remain normal filesystem
dependencies; only the entry is frozen.

Two additional regressions exposed that a supplied `cwd` contributed to Script
identity but was omitted from durable checkpoints, causing `script_hash_mismatch`
after Host restart. The checkpoint now retains and restores that exact directory.
The focused checks pass **42/42**. Full `npm run check` passes **1609/1609** functional
and **50/50** performance/stability tests. Current Host source fingerprint is
`e8118ed52e4be9c064e2455e10f74643bd4d61c4c5726275a11bb163185a7844`.
Sources, failing-before-fix logs and passing results are frozen in
`current-host-validation-script-modules/report.json`.

Actual API 36 emulator checks on that revision:

| Entry | Actual scope | Total elapsed | Evidence |
| --- | --- | ---: | --- |
| Intent | Native HTTP login, one session independently checked | 9.386 s including launch/readiness; 3.431 s in Intent | `native-http-intent-modules-1` |
| Python | Child crash, Host restart, same operation restored, then 36 commands across 11 native pages | 9.250 s including restart; 7.912 s in the workflow | `python-module-host-recovery-1` |
| JavaScript | Normal sibling import, actual UIA process death, force-reset, then full NotallyX note journey and SQLite check | 42.778 s including the deliberate eight-second callback | `notally-uia-module-recovery-1` |

The Python entry was deliberately replaced after its checkpoint; continuation
still used its frozen bytes and retained `cwd`. The JS runner now uses ordinary
`require('./uia-regression')`, replacing its temporary absolute-path workaround.
The original unknown UIA action is not replayed. All nine Native assertions, ten
NotallyX UI assertions, and the independent database result pass. These are
prepared scenario results, not first-use or whole-App acceptance. The slower
launch/readiness component of the latest login remains in its total.

### Independent desktop Web and retained waiting costs

Desktop Web now has separate evidence against an unmodified official Memos
0.30.0 server, an isolated Chrome profile, the current Web SDK, real HTTP and
independent SQLite checks. Android WebView results are not substituted for it.

On Host `ef7d7609b37aeecef27e82aa53ec251b62da385d10940631a82cc735f9f24d63`,
`web-memos-long-final-1` runs five complete create/search/edit/delete-dialog/cancel
journeys in one JavaScript Script: **153 commands, 69 UI assertions, one public
call, 4274 response bytes, 6.147 s through the reply and 6.208 s including the
SQLite oracle**. Each exact edited record, tag, private visibility and task state
matches; all preexisting records are unchanged. The five prepared cases take
1.112–1.180 s each. Browser setup, original discovery and script authoring are
outside this prepared measurement and must be reported separately.

The initial Python attempt (`web-memos-python-baseline-1`) failed after 15.442 s:
clearing Memos' search input did not remove its applied filter, so the newly
saved note stayed hidden. The sample strategy now explicitly clicks the observed
`Remove filter` control. The successful original JS/Python baselines are
1.462/1.495 s respectively; neither erases that initial failure. A registration
policy likewise now observes the original CreateUser network result and returns
a real 4xx/transport failure to the Agent rather than waiting for a success page.

`web-memos-response-loss-1` lets the real server commit a note and return HTTP 200,
then drops only the browser response. The Script preserves the draft and asks the
Agent; an independent database query proves exactly one saved note before
continuing the original operation without another Save. Program time is
**33.090 s including the Agent pause; the external lifecycle spans 52.943 s**.
Those elapsed times remain part of the evidence. They are not represented by the
452 ms it took to reach the initial question.

Actual Web disconnection and document replacement exposed missing recovery
guidance. Errors now provide provider/session discovery, an explicit retained
history read or the observed current document identity. The original action is
not replayed. A regression also covers session metadata expiring during an
asynchronous failed read: the diagnosis retains the identity captured at failure
instead of reading a subsequently removed session. The focused Web suites pass
16/16. Final response-loss validation then reproduced a separate rich-text
input misreport after a successful clear: CodeMirror temporarily collapses the
original editor to zero height. Post-input visibility was incorrectly treated as
a prerequisite for input that had already completed.

The Web SDK now returns the original element's observed value and post-input
state. Visibility, disabled state and focus changes after the last dispatch are
information; checks before remaining dispatches still apply. If the original
element or page is gone, the value remains unconfirmed and is never read from a
replacement element. Four red-to-green regressions extend the SDK suite to
**31/31**. The original real CodeMirror clear passes with `value:''`,
`inputDispatched:true`, `valueState:observed` and a state-change warning; the
independent database still contains exactly one save.

With SDK SHA-256
`765639bb64d21f50658186f74810ee436ee689284f7d99cb5bdef8a6e8fc0b82`,
`web-memos-long-final-2` repeats the five journeys: 153 commands / 69 UI assertions,
one call / 4274 bytes, **6.439 s externally and 6.504 s including SQLite**.
`web-memos-python-final-2` completes one journey in **1.494 s**, or **1.547 s**
including all twelve database checks. The response-loss recovery program still
takes 54.134 s including Agent/controller pauses and a retained erroneous wait
request; the full start-to-final-readback span is **79.021 s**. Correct recovery is
not represented as an uninterrupted subsecond run.

A new isolated instance verifies the registration failure path using a real
HTTP 400: Intent returns inconclusive in 363 ms, with one CreateUser request and
zero users, rather than waiting ten seconds for an impossible success page.
An explicit corrected username then completes in 723 ms with exactly one new
administrator. These observations occurred during package verification, not an
unloaded benchmark. The full error-to-corrected-result span is 54.887 s and
includes Agent evidence review and decision time.

The final screenshot also exposes a task-checkbox presentation discrepancy:
SQLite has the edited `[x]` source, while the current page shows an unchecked
box. The workflow assertions cover exact content, persistence and cancelling
deletion; they do not establish task-checkbox UI synchronization. One read-only
reload of that exact saved note then returns checkbox states `[true,false]`, and
the independent screenshot agrees (`web-memos-render-control`). No task was
clicked and no database row was changed. The difference is confined to the
post-edit current-page presentation in this observation; its source-level cause
is not inferred. Persisted task state and its fresh-page rendering are correct.

### Fresh-environment desktop Web control

The reusable `examples/memos-sample/validation/run-end-to-end.js` completes its
only full control attempt on the first run. System `/usr/bin/time` measures
**10.71 s for the entire command**, including a new Memos server and empty data
directory, isolated Chrome context, current SDK and Host startup, Intent signup,
five JavaScript journeys, one Python journey, independent SQLite checks,
screenshots, source verification, and normal shutdown. Controller time is
10.382 s before cleanup and 10.638 s including cleanup.

All seven public command calls are counted: three preparation calls, three
business calls, and one runtime stop. There is also one MCP initialize request
and one initialized notification. The run requires **zero additional model
turns**. Its JavaScript journey executes 153 commands and 69 UI assertions; the
Python journey executes 31 commands and 14 UI assertions. The database checks
confirm the exact user and saved content. Business actions use the public Bridge
commands; neither Playwright nor database writes perform the business workflow.

This is a **known strategy on a fresh local environment**, with the verified
Memos binary, browser and dependencies already available. It does not measure
discovery or strategy authoring for an unfamiliar App. The original 844.768 s
preparation-to-signup span and 79.021 s response-loss recovery span remain in
`current-host-validation-web/report.md`. The task-checkbox presentation
limitation above also remains. No source change to Memos or further product
change to Bridge is part of this control.

Evidence is in `web-memos-end-to-end-1/summary.md`, `report.json`,
`outer-verification.json`, and the 210-file `source-sha256.json`. Host and SDK
identities match the final validated revisions. Browser and server exit normally
with code zero, public runtime stop succeeds, and the server port is closed.
The sample README contains the complete repeatable command.

### Current source and local package verification

The final Host revision above passes **1617/1617 functional** and **50/50
performance/stability** tests. Its 188-file validation manifest is unchanged
through the run. A real tarball is installed into a new directory with Python
and compiler commands denied; the prebuilt native dependency loads, CLI/MCP
contract and explicit recovery checks pass, and all 217 installed package files
match the current source. This uses controlled ADB and is distinct from the
real Android acceptance evidence.

The separately packed Web SDK installs cleanly, all six packaged files match
source, and the installed SDK passes the same 31 tests. Reports are
`current-host-validation-managed-web-guidance/report.json`,
`package-managed-web-guidance/report.json`, and
`web-sdk-package-input-state/report.json`. These are **local validation packages**
with existing 0.4.6 metadata, not a new public release or an update to installed
project dependencies. A subsequent public release requires a new version.

The usage skill and CLI documentation now expose the existing autonomous Intent
path for known sequences, including module input, decision shape, same-call
completion and workflow-scoped module state. Eighteen existing usage/contract
tests pass, and the documented autonomous start validates against the current
public schema. The Runtime code fingerprint is unchanged. The updated local
package again passes clean installation and CLI/MCP checks; all 217 packaged
files, including the bundled native dependency, match source. See
`intent-autonomous-guidance-1/report.json` and
`package-autonomous-guidance-1/report.json`. This documentation change does not
itself establish a first-use speed improvement.

The response-delivery audit's v2 summary now links the matching 26-partial-view
measurement, while its v1 29-partial-view report remains intact. Both original
v2 reports were copied byte-for-byte out of temporary storage with SHA-256
provenance (`response-delivery-v2-archive`). No device actions or historical
response replay were repeated to correct the evidence index.

### Newly reproduced Flutter engine selection defect

The concurrent-edit UI acceptance attempt `commerce-concurrent-duplicate-1`
exposed a real multi-Activity/multi-engine failure. Within the same App process,
`launch-app` brought the old commerce Activity in task 101 forward, but the
Flutter SDK still returned the review tree from the stopped Activity in task 94.
The foreground screenshot, Android task state and returned Dart epoch disagree.
The attempted review action then timed out. Its confirmation dialog was later
observed when returning to the correct Activity; the original action was not
replayed. The failed 35.980-second attempt remains failed.

This is an open product defect, not attributed to Mac lock state. Returning
through the original Activity stack permits the separate business fault tests
to continue, but does not fix the launcher case. Required repair evidence must
repeat the original launcher navigation and prove that the current Activity,
engine epoch, observation and actual UI action agree, including return to an
older engine and late callbacks from a previously selected engine.

### Lock-state evidence and remaining startup uncertainty

`awake-unlocked-startup-1` records 112 consecutive `IOConsoleLocked:false`
samples, no observed sleep, a maximum sample gap of 634 ms and clock skew of
1 ms. Its current Flexify process-cold start receives a launch receipt in
3.510 s, then exhausts a 45-second readiness wait. The reported 48.520 s is a
**timeout**, not an observed first-screen completion. The last failed read reports
`flutter_observation_timeout` in `android-main-queue`; all 93 failed reads are not
assumed to share that diagnosis. Twenty historical controls were audited in
`awake-unlocked-startup-1/source-audit.json`. Passive runs also show slow startup
without early SDK observation, so neither polling nor lock state is established
as the sole cause.

The separate Flutter process-death attempt `flutter-executor-loss-4` has
45 consecutive locked samples, covering 25.141 s. Its post-relaunch 15-second
readiness timeout must **not** be presented as an unlocked performance failure.
Recovery guidance and unknown-record retention can be evaluated independently;
longer read-only waits used to complete functional coverage do not satisfy the
original 15-second performance threshold. No product deadline is enlarged by
that test arrangement.

### Flutter process death before and after the durable effect

`flutter-executor-loss-5` completes both real Flutter App process-death cases in
one Script, followed by the full Native + H5 + Flutter commerce flow. A durable
fixture journal identifies callback entry and the actual effect; the fault
controller kills only the exact App PID after checking its identity. Before-effect
death leaves zero original effects; after-effect death leaves one. Each case
restarts the App, retains the original unknown action and archive, executes one
explicitly new action, and confirms that the original action was never replayed.
The Host remains the same throughout.

The original typed Flutter failure now offers five executable choices: ownership
status, archives filtered by the original action ID, current Flutter observation,
App launch, and explicit force-stop. The error, ambiguous outcome, action ID and
runtime epoch remain unchanged. The same contract branch covers Android H5 in
unit tests; that is not a claim of an actual H5 process-death run. Four new
regressions and related focused suites pass **55/55**; evidence is in
`flutter-managed-guidance-validation`.

The complete run uses **128 commands, two external calls and 10,424 response
bytes; 63.270 s includes the independent server oracle**. Its commerce segment
takes 20.695 s / 68 commands and verifies one order, one payment despite response
loss, one refund and restored inventory. The first post-fault readiness wait
takes 18.794 s and exceeds the retained 15-second threshold; the second takes
2.670 s. `performanceBudgetMet:false` remains explicit. All 112 Mac lock samples
in this run are true, so this proves functional recovery, not unlocked speed.

Attempts 1–4 and the explicit continuation of attempt 3 remain in their original
directories. Attempt 1 times out before fault injection and lacks continuous
lock coverage. Attempt 2 catches a runner incorrectly equating Native and Dart
runtime epochs. Attempt 3 exercises a real unknown outcome but exposes missing
guidance and a runner reading an envelope field at the wrong level; its original
record stays unknown after continuation. Attempt 4 exercises the repaired hints
but exceeds its readiness deadline while locked. Attempts 2 and 3 have continuous
unlocked samples; their functional/harness failures do not measure cold-start
performance. No failed attempt is relabeled as a success.

### First-use Web cost and Script control corrections (2026-10-13)

`web-first-use-current-1` used fresh Memos data and a new agent context to discover
registration, two similarly named records, unique search, editing, delete-cancel
and reload. Eleven UI assertions and an independent SQLite read passed; all
45 inner public calls succeeded and summed to 1.334 s. This was still slow from
the user's perspective: first business request at 232.793 s, post-reload UI proof
at 470.291 s, cleanup at 530.310 s and correction of the local role assertion at
691.436 s. Supplemental file checks and report writing ended at 1008.568 s.
The two retained harness errors were dereferencing a null question and expecting
`HOST` instead of the actual first-user `ADMIN` role. The run was assisted with
environment paths and one root reminder; it is not an unattended benchmark.

Twenty-four outer RPCs returned 451,403 bytes. Seven question-to-decision gaps
totalled 198.063 s; these include reasoning, authoring and other tool work, not
just inference. The final empty `done` question was unnecessary and cost one
decide/wait pair plus 35.900 s. Existing paired controls were already issued close
together, so combining them alone cannot explain away the minutes of first use.
The earlier prepared 10.71 s workflow remains a different measurement.

Script `decide` now accepts the existing bounded `waitMs` convention, delivering
the next question or result in the same call. Invalid/stale answers do not consume
a question; a timed-out wait keeps the accepted operation running. Guidance now
shows inline ordinary source, local loading/network conditions and branches on
unfamiliar pages, focused questions and direct return on completion. MCP startup
instructions no longer falsely require `extract` or always prescribe another
`result` read. Script is not limited to fully discovered fixed workflows.

The observed main Script's old summary reported 200.093 s active and zero waiting
despite those real decision gaps. `script-timing-accounting` retains that original
receipt and fixes cumulative question waiting, overlapping waits, terminal freeze
and explicit resume. `startedAtMs` identifies the current Host execution segment;
a restored segment on another Host begins a new window. `activeMs` is wall time
excluding Agent waits, explicit pauses and stopped intervals, not CPU time.
Remaining unanswered questions stay visible after another answer or pause/resume.
Actual isolated MCP JS/Python and restart receipts agree exactly with their event
intervals. That frozen Host check passed **1628 functional + 50 performance
tests**, with all 529 captured source/test/doc files unchanged during validation;
see `current-host-validation-script-timing`.

### Activity-bound Flutter recovery and unlocked measurements

The newly reproduced wrong-engine defect is fixed by binding each Flutter
handler, snapshot and epoch to its owning Activity, selecting the actual resumed
Activity and rejecting a queued/late observation from a changed selection.
Action admission and Dart mutation permission use that same selection; receipt
queries and cancellation remain with the original channel. Existing public
legacy registration remains isolated; the new plugin does not silently downgrade
when the required Activity-binding API is missing. The internal executor has one
runtime-selection path. **31 focused JVM tests** and the original launcher path
pass; `flutter-multi-engine-summary` preserves the original failure and recovery.

After the user unlocked the Mac, `flutter-multi-engine-unlocked-2` passed all nine
checks with **53 commands, one Script RPC, 11.559 s UI / 11.607 s including the
independent oracle**. Continuous samples were unlocked throughout. Both retained
tasks kept distinct epochs, only two explicit fixture actions occurred and no
business POST was added. This is one measured repeat, not a percentile claim.

Unlocked startup/recovery speed still fails the intended budget:

- `awake-passive-current-1`: 193 unlocked samples, maximum gap 589 ms. With no UI
  or SDK reads during a deliberately passive 100 s interval, Android records the
  first frame at **26.292 s**. Readiness afterwards passes; the full 107.427 s
  diagnostic includes that deliberate waiting and is not a startup speed score.
- `flutter-executor-loss-unlocked-6`: both process-death cases and commerce pass,
  with original unknown effects preserved and no replay. The full 128-command
  run takes **67.501 s** including oracle. First post-kill launch/readiness take
  **4.323 / 21.178 s**; second take **0.465 / 2.601 s**. The 15 s readiness budget
  is still exceeded in the first case (`performanceBudgetMet:false`).

Lock state therefore cannot explain away these remaining cold-start outliers.
Startup timing/trace diagnosis continues; upstream, SDK and emulator costs are
not assigned by inference from unmatched historical controls. Overall acceptance
and publication remain incomplete.

### Web ancestor context and final local packages

Unlabelled Web controls now expose bounded text from their actual DOM ancestors.
The same optional observation survives the Intent summary; it does not become a
selector condition or part of the page/element identity. Real Memos records with
the same prefix were distinguished, the selected record was edited using its
original binding, and fresh observations plus SQLite verified the intended edit
and the unchanged second record. The raw ancestors can cover multiple records;
the retained first test incorrectly searched every ancestor as though each were
a business row. A separate invalid test username also remains in the evidence.
These are capability/cost checks, not first-use speed results.

`web-context-metadata-current-1` compares the same 62-control DOM over 50
alternating samples per version: nine controls gain context, adding 2,520 bytes
(9.71%); median collection time changes from 0.90 to 1.30 ms. Its recorded SDK
version precedes one final whitespace-sampling correction. That correction has
a failing fixture followed by passing regression; a new first-use run uses the
final SDK and must be reported separately, including discovery and mistakes.

The resulting Host check in `current-host-validation-web-context` passes
**1629 functional + 50 performance tests**, with all 529 captured source/test/doc
files unchanged. `package-script-timing-context-1` verifies a clean installed
CLI, all 217 packed files (including bundled native dependencies) matching
source, cross-client continuation and inline `decide(waitMs)` completion.
`web-sdk-package-context-1` verifies all six packaged Web files and **35 SDK
tests against the clean installation**. Both are local validation packages,
not a new public release.

### Final first-use run, observed-target correction and startup diagnosis

`web-guided-first-use-1` used the final ancestor-context SDK with fresh Memos data.
Registration, two records, precise edit, delete-cancel and reload passed the UI
and read-only SQLite checks. Agent dispatch to UI completion was **394.947 s**;
dispatch to the database oracle was **439.180 s**. Report freezing ended at
835.321 s, with cleanup/reporting recorded separately. Thirteen outer calls
transferred 234,835 response bytes. The 101 inner calls summed to 1.710 s, but
that sum excludes discovery and agent decisions and is not a completion time.
The retained mistakes include misplaced `recordingDir`, an overbroad search and
a real rejection of complete observed controls containing `ariaChecked`.

That rejection is fixed in `web-full-observed-target-1`: Web/H5 expected targets
accept additive observation fields while validating all required identity fields.
H5 renderer requests use one projection of the defined identity fields, including
raw Flutter commands. A real single-Script registration and note creation passed
all five dispatched/settled actions and both UI/SQLite assertions. **124 focused
tests** cover Web, Android/iOS H5, Flutter H5, identity replacement and guidance.
This short prepared functional check does not replace the first-use timing above.

`flutter-cold-start-diagnosis-1/final-summary` preserves the unlocked 21.178 s
readiness and 26.292 s first-frame outliers as **unattributed**. Bounded later
process-cold traces did not reproduce them. The isolated ART probe checked the
same 11,177 payloads, with identical CRC results and deliberate corruption
rejected by both algorithms. Cold CPU fell from 49.43 to 22.45 ms; warm samples
also improved. All 17 focused equivalence, bulk-I/O and store tests passed.

Actual post-kill recovery did not establish startup improvement: launch/readiness
were 649/2945 ms before and 623/3467 ms after the CRC change. Background browser
load and installation state differed; the complete runs retain those costs.
Original actions remained unknown without replay, and explicit new actions could
continue. The CRC implementation is shipped as an equivalent local optimization,
not proof of whole-App acceleration. The broader performance goal stays open
while verified fixes are prepared for coordinated version 0.4.7.

### Version 0.4.7 release checks

Final review found and fixed checkpoint recovery after an operation is evicted
from the bounded in-memory registry, including preserving the event cursor when
restoring into the same Host. Six new real-child-process regressions and their
related suites pass 69/69. Duplicate starts, terminal outcomes, corrupt evidence
and unknown effects retain their explicit handling. Both new reflected Flutter
binding APIs are also retained in the Android consumer rules and verified in
Debug/Release AARs.

The frozen 0.4.7 Host passes **1645 functional + 50 performance tests** with all
529 captured source/test/doc/runtime files unchanged. The final CLI tarball
passes clean installation, native prebuild loading, 125-command discovery,
cross-client continuation, recovery and inline decide completion; all 217 packed
files match source. The clean installed Web tarball passes **38 tests** and its
six files match source. Android build/lint and SDK Debug/Release **214 tests
each** pass; UIA 50 and plugin 8 reuse unchanged Gradle inputs. Flutter analyze
and **80 tests**, both zero-warning pub dry-runs, the four generated H5 copies
and the unsigned iOS build pass. These release checks do not change the actual
workflow limitations above. Evidence is stored in the sibling
`ai-app-bridge-release-evidence/0.4.7-2026-10-13/` directory.

## Earlier ATD diagnostic measurements

- Original prepared native workflow: 38.934 s, 94 lifecycle calls.
- Old CLI with the current fixed SDK: 28.901 s, 74 lifecycle calls, 160355 bytes.
- Development CLI with current SDK: 6.596 s, 1 call, 1948 bytes; all 9 explicit
  checks passed. This is a 36-command, 11-stage native fixture, not the complete
  acceptance scope above.
- Login autonomous Intent: prior 10.809/10.990 s versus 2.635 s in the current
  measured revision; app startup and total task time are recorded separately.
- These older ATD measurements must not be combined with the full-image table as
  a controlled performance comparison.
