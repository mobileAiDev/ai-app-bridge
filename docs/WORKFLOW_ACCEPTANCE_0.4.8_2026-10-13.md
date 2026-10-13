# 0.4.8 prepared-workflow acceptance

The remaining complete mixed-flow, Flutter recovery and concurrent-edit checks
now pass for the declared representative workloads. Publication, local upgrades
and updates to the four consumer projects are also complete. This is not a claim that any
unfamiliar app can be fully tested in one minute.

The main clock starts with a prepared Intent or ordinary JavaScript/Python
Script submission and ends with independent business verification. Page loading,
network requests and injected failures remain inside that clock. Initial script
authoring and explicit agent-decision waits have separate timing scopes.

## Final complete runs

All Android runs below use the dedicated host-GPU API 36 emulator
`emulator-5564`, not the K2 Mini or a physical phone. The new Flutter checks use
the installed public Host 0.4.8 and Bridge SDKs 0.4.8. Each repeated program uses
unchanged business source and a fresh isolated backend run.

| Prepared program | Submission through independent verification | Execution and result |
|---|---:|---|
| Native HTTP login | 4.238 s including launch/readiness; Intent itself 1.983 s | One server session, final Host/Native SDK 0.4.8 |
| Three Native/H5 commerce journeys | 46.299 s | 187 commands, two external calls; child-process exit and same-operation continuation; 15 business checks |
| Three Native/Flutter/H5 commerce journeys | 54.113 s; unchanged repeat 55.406 s | 200 commands per run, one external Script call each; 16 checks and three independent ledgers per run |
| Two Flutter process deaths followed by full mixed commerce | 30.860 s; unchanged repeat 31.114 s | 128/127 commands, one external Script call each; original unknown actions preserved, explicit new actions and complete order/payment/refund/stock verification |
| Concurrent edits, stale-revision rejection and duplicate confirmation | 24.926 s | 68 actual calls, one external Script call, five assertions and independent commit ledger |
| Web registration, five JavaScript journeys and one Python journey | 9.327 s | Final Host/Web SDK 0.4.8; 184 internal calls, 83 assertions and six records independently checked |

The mixed journeys still include normal commerce, an expired session and a lost
payment response. The Flutter recovery program still kills the app before and
after an action's effect, preserves the ambiguous original receipts without
replaying them, then completes commerce with payment-response loss and refund.
No screenshots, business steps, injected failures or budget thresholds were
removed. Counts vary by one read-only Flutter observation during payment-response
loss, not by omitted business work.

Both mixed repeats satisfy the original 60-second full-program target. Both
recovery repeats satisfy that target and the original 15-second readiness limit
for each restarted executor. Readiness was 2.227/2.259 seconds in the first run
and 2.179/2.388 seconds in the second. Two-sample ranges are reported directly;
they are not percentile estimates.

The new Flutter fixture APK has SHA-256
`6d1bbc6467a5aff9a65c6177a623bfd5595dc2cec4d8564d23c7dfc5adb2e718`.
It was installed with app data retained; the app UID and the 22 pre-existing
recovery-journal hashes were preserved. Updating its path-dependency lock entry
to 0.4.8 does not change the published packages or release tag.

## Retained slow runs and environment boundary

The historical complete recovery and mixed programs took 67.501 and 62.334
seconds. Fresh 0.4.8 runs before the confirmed unlock window took 64.684 and
62.103 seconds. They passed functional checks but missed the performance target;
those results remain in the record.

During the slower window, session/display observations did not agree with a
single IOKit lock bit. RunningBoard also recorded qemu CPU/timer restrictions
during the long first recovery. After the user explicitly unlocked the Mac,
two complete A/B pairs ran with bounded temporary sleep-prevention assertions
and recorded environment observations. No global setting or product admission
rule was changed. Environment warnings remain advisory.

These observations support a host scheduling contribution. They do not isolate
App Nap as the sole cause or establish a new SDK speedup. The accepted timing
scope is the observed active-host test environment; slow samples are not
discarded. Existing Web comparisons likewise do not show an additional engine
speedup from 0.4.7 to 0.4.8. Lossless response-byte savings are separate from
execution-time savings.

## Complete concurrent-edit recovery

Replaying the original frozen validation source reproduced a 40.718-second
failure: its generic launcher selected a different retained Flutter task when
the intended inspection page was underneath the Native activity. This is a
validation-program navigation error, not evidence that the SDK should guess a
different task.

The repository already contained the explicit Back correction. A new complete
run used that source without a resume input or an old task ID. The original
Flutter epoch, task, Activity and PID were independently verified before and
after returning; version 2 and its draft remained present. Submitting that
version received HTTP 409 with no mutation. An explicit query obtained version
3, and the new submission committed revision 4 once. Two confirmation attempts
were 228 ms apart; the second target was absent and the call was not dispatched.
The ledger contains one create, two distinct approvals and one final check.
This is not a claim of two dispatched HTTP requests exercising server deduplication.
This complete correctness run occurred while the host was locked/inactive;
its 24.926-second trace is not a controlled unlocked latency comparison.

## Coverage and limits

The wider audit covers agent choice and diagnostics, command/ADB composition,
real JavaScript and Python, cancellation and recovery, tree deltas, response
delivery, and representative business execution on Native, Flutter, mixed
Native/Flutter/H5, UIA-only apps and desktop Web. Existing open-source apps were
tested as independent apps as well as through the custom workbench.

Earlier Flexify and UIA records retain their actual versions and clocks.
Flexify's 41.764-second UI run does not include its later separate SQLite oracle.
The UIA fault-recovery business completed in 42.778 seconds including its
deliberate callback delay and database check; a three-journey endurance run took
103.635 seconds and is not claimed to meet a one-minute budget. Matching UIA
payload bytes do not turn those historical Host runs into fresh 0.4.8 runs.

Platform coverage and execution-language coverage are tracked separately. All
five available platform categories have real business evidence; Intent,
JavaScript and Python have actual execution evidence. The earlier proposed
15-cell platform/language cross-product is not claimed fully measured. There
is no iOS device or Simulator business acceptance: only source/archive checks
and unsigned compilation were available.

## Evidence and reproduction

`N` is the sibling evidence directory
`ai-app-bridge-release-evidence/0.4.8-work/2026-10-13/`.

- `N/flutter-full-acceptance/full-loss-unlocked-{2,3}/run/report.json`
- `N/flutter-full-acceptance/long-mixed-unlocked-{3,4}/run/report.json`
- `N/flutter-full-acceptance/concurrent-full-current-1/run/identity-and-oracle-verification.json`
- `N/flutter-full-acceptance/full-loss-1/` and `long-mixed-2/` retain the slow runs;
  `concurrent-full-1/` retains the frozen-source navigation failure.
- Each run retains its source copies, inputs, call receipts and independent
  server records. The pair directories retain their supervisor/environment
  observations. `N/flutter-full-acceptance/summary.json` and `REPORT.md` index
  the complete reruns and cleanup. The requirement-by-requirement audit is
  `N/publication/goal-requirements-audit.md` and its JSON counterpart.

All dedicated Host/server processes and temporary sleep-prevention assertions
were stopped. Device ownership is idle with no unresolved operation; the
original emulator and global Runtime were preserved. No persistent OS setting
was changed.

Reusable runners are in `desktop/ai-app-bridge-cli/scripts/validation/`:
`run-flutter-executor-loss.js`, `run-long-commerce.js` and
`run-concurrent-duplicate.js`. Isolated facts, Runtime and server data are
required to preserve the run's identity and avoid unrelated app state.

See [release verification](RELEASE_VERIFICATION_0.4.8_2026-10-13.md) for public
artifacts, the current connected client and consumer upgrades, and the
[validation history](WORKFLOW_PERFORMANCE_0.4.8_CANDIDATE_2026-10-13.md) for
retained earlier candidates and timing boundaries.
