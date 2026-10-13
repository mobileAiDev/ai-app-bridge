# 0.4.8 coordinated release

This patch reduces avoidable discovery and delivery costs while keeping the
existing Intent, ordinary JavaScript/Python Script and individual command
interfaces. CLI/MCP, Android, iOS, Flutter, Web and optional Bridge executors are
released together as 0.4.8. Device/Web protocols are unchanged; SDK changes in
this release align version identities and dependency metadata.

## Changes

- Optional Android/Flutter executor preparation uses the exact SDK dependency
  declared as `sdkReleaseVersion` in the Host package. Host and SDK/helper are
  both 0.4.8 in this coordinated release; preparation reports both versions.
  Regression coverage verifies that artifact resolution follows the declared
  SDK dependency while preserving the actual Host identity.
- Automatic lossless formatting handles optional fields in real Web controls.
  Formatting is considered above 8 KiB without lowering the 96 KiB default
  complete-response budget. Every control, identity and missing/null distinction
  is retained. One replay of the same 13 real responses used 40.69% fewer bytes;
  this is delivery savings, not an execution-speed claim.
- Delta observations keep their compact full baseline when a response also has
  heterogeneous diagnostic arrays. A public-reply regression verifies the full
  baseline, next patch, checksum and original saved response.
- Script discovery accurately describes optional extraction and the call
  envelope, includes executable JavaScript/Python examples, and avoids repeating
  the authoring catalog for lifecycle operations.
- The optional editable `web-steps.js` module reuses reads, explicit observed
  bindings, actions and waits. Business branches remain ordinary JavaScript;
  existing commands and `askAgent` remain available. Failed calls retain their
  full replies and report short diagnostics.
- The sample startup probe reports display/session, frontmost process, App Nap
  and emulator CPU facts independently. Environment warnings are advisory and
  do not change business success. An unbundled frontmost process can be
  identified by its observed PID.

## Prepared execution measurements

The primary clock starts with a prepared Intent/Script submission and ends with
verified business completion, including page loading, network waits and recovery.
Initial business-program authoring is recorded separately. Explicit agent waiting
is separate while the total elapsed time is retained.

| Scenario | Measured result |
|---|---|
| Native HTTP login | One Intent: 1.689 s; launch/readiness and server check included: 3.406 s; one server session |
| Native/H5 three full commerce journeys | 45.087 s, 187 commands, 2 external calls; child-process interruption and same-operation checkpoint continuation, price change and payment-response loss; independent order/payment/refund/stock checks passed |
| Web registration, five JS journeys and one Python journey | Public 0.4.7: 8.703 s; candidate: 9.097 s; unchanged candidate repeat: 9.023 s; final SQLite check included |

The Android check reused the installed sample APK with Native SDK **0.4.6**,
without installation or data clearing. It verifies candidate Host compatibility
with that exact installed build. Web used the same 0.4.7 SDK source across all
three runs. Each Web run passed 83 Script assertions and included 102 captured
business-period network requests; no interactive `askAgent` wait occurred in
that fixed program. Its business source was unchanged across runs.

The Web candidate was not faster in this small comparison. The result supports
execution and reuse stability, not an additional engine speedup. Those normal
Web runs did not inject faults; explicit document rebinding and `askAgent`
continuation were validated separately. The Android commerce run includes its
actual interruption and recovery time.

## Final coordinated build verification

The final 0.4.8 Host and Native SDK ran the original login Intent in 1.983 seconds
(4.238 seconds including launch/readiness and the independent server check),
followed by three Native/H5 commerce journeys in 46.299 seconds: 187 commands,
15 independent business checks, and continuation of the original operation
after an injected child-process exit. The final 0.4.8 Web package also passed
the original registration, five JavaScript journeys and one Python journey:
184 calls, 83 assertions and all six records independently checked in 9.327
seconds. These final-version traces were collected during concurrent release
work and are not a new controlled speed comparison.

The coordinated release passed 1,660 Host functional and 50 performance checks;
Android SDK, UIA and plugin checks; Web source and installed-package tests;
Flutter analyzer checks and 80 tests; and an unsigned iOS generic-device build.
Public npm/Pub archives match the validated packages, and all eight JitPack
modules were verified. iOS runtime acceptance remains unavailable. The earlier
measured version identities and timing comparisons above remain unchanged.

See the [release verification](RELEASE_VERIFICATION_0.4.8_2026-10-13.md) for
publication and local/consumer integration status.

## Scope and remaining limits

These are representative prepared workflows, not complete coverage of arbitrary
apps. First-use authoring/discovery time remains visible as a separate usability
measurement and is not treated as prepared execution latency. Some historical
Android startup outliers align with host App Nap throttling; the diagnostic work
does not establish a new SDK speedup or explain all delays. No new iOS device or
Simulator runtime acceptance is claimed.

See [the detailed validation record](WORKFLOW_PERFORMANCE_0.4.8_CANDIDATE_2026-10-13.md)
for source fingerprints, retained failures, full timing boundaries and evidence.
