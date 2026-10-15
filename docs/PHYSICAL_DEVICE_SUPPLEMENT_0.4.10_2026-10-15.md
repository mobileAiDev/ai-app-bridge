# Physical device supplement after 0.4.10 publication

The user reconnected iPhone `00008160-001465A81E400036` and rooted OPPO
`b46093e6` after publication and authorized the omitted checks. This supplement
does not change the immutable 0.4.10 tag or public packages. The K2 cashier was
not used. Windows physical verification remains deferred by the user.

Evidence root, outside the repository:
`../ai-app-bridge-release-evidence/0.4.10-device-supplement-2026-10-15/`.
Failed attempts and interrupted tests remain in their original directories.

## Completed business evidence

| Target | Actual scope | Result and limits |
| --- | --- | --- |
| iPhone Kiwix, verified public SDK 0.4.10 | Python Native/H5 navigation, bookmark create/cancel, App restart and saved-bookmark reopening | Original Script completed, 36 device calls, 78.457 s. Four screenshots and a separate quiescent CoreData oracle confirm the fresh bookmark, relation and absence of duplicate URLs. This is not a comparative speedup measurement. |
| iPhone Kiwix | Script cancellation; `askAgent`/`decide`; Host death after an admitted H5 effect | Original operation identities retained. Query-only recovery completed and the independent device counter remained one. Cancellation and business cancellation are recorded separately. |
| OPPO mixed test App, verified public dependencies | Dynamic Native order, H5 account/cart, Flutter hotel search; delay and lost business-response variants | JavaScript: 9.282 s / 47 calls, 9.653 s / 64 calls, 9.075 s / 48 calls. Independent backend ledgers each confirm one order and one create-order commit. Hotel search returned an empty result; this is not a completed hotel booking. |
| OPPO mixed test App | Python and Intent; existing UIA plus screenshot and subsequent UIA action | Python 8.745 s; Intent 4.068 s. The UIA epoch survived capture and the subsequent tap changed the actual screen. The earlier privacy-overlay obstruction remains a retained non-dispatch failure. |
| OPPO mixed test App | Real Host death after the backend committed a hotel query; original-action reconciliation and query-only resume | Original effect remained ambiguous until inspected. Backend query count remained one; no effect was replayed. The first incomplete resume request's hash mismatch remains in the record. |
| iPhone Flexify, verified public SDK 0.4.10 | Unique plan, two exercise sets, edit, cancel deletion, History and Volume graph | Script completed: 135 calls, 95.607 s, 16 observed device assertions. Independent SQLite checks passed 13/13: actual plan/exercise relations, 42.5 × 8 and 47.5 × 6, 14 repetitions and 625 kg, fresh timestamps and unchanged source copy. |
| iPhone Flexify | Actual process restart and deliberately wrong expected value | New PID and SDK epochs; saved plan and both sets remained, 10 calls / 6.915 s / four observed assertions. The separate 999999 kg × 999 expectation correctly failed its device assertion and Script. |

These are bounded workflows. They do not establish one-minute coverage of a
whole unfamiliar App or universal cross-platform efficiency. Preparation,
authoring and device connection time are retained separately from submitted
program runtime. The iOS flow duration is not an Android performance result.

## Power defects and candidate verification

The supplement found a real Host defect in public 0.4.10. Its renewal timer was
created inside the command's asynchronous execution scope. When that command
settled, a later iOS renewal inherited its closed scope and failed with
`runtime_stopped`, although the logical work deadline was still live. The
candidate detaches timer creation from that completed command; explicit calls
retain their own cancellation and deadline checks.

The first activity-recovery candidate also hid an ordinary transport failure
when a queued renewal reported the generic `power_lease_ended` wrapper. Review
reproduced it and retained the underlying failure and retry cooldown. Further
review caught two nested replacement attempts and an obsolete expiry timestamp
after an unconfirmed replacement. Both have focused failing-before/passing-after
records.

The combined candidate adds an explicit `recovery:"reacquire-ended"` policy for
selected iOS SDK targets. Automatic work chooses it; explicit power leases
default to manual recovery. A live logical work lease can restore an assertion
that the SDK confirms has ended, on the next ordinary heartbeat without another
UI action. The original deadline and explicit endpoint stay fixed. Transport,
identity and foreground errors remain failures. Failed replacement does not
loop. Attempt/confirmation facts are visible in `assertionRecovery`.

Later Windows review found a shared child-channel diagnostic gap: a worker had
already closed but the lease could remain `active` until the next heartbeat.
The local repair serializes confirmed exit notification for the current handle,
preserves the first error and does not reacquire or invalidate another handle.
Eight new real-process tests and all 67 power tests passed. This later Host-only
repair is separate from the frozen four-module device candidate below.

- All 59 power tests pass, including the actual production Host/provider path
  with the real 15-second timer. Test source hashes were stable across the run.
- The timer-scope-only candidate passed an actual 75.017-second no-touch Kiwix
  window. SDK assertion, foreground and idle-disabled state were all confirmed
  at the end; a real screenshot still showed Kiwix. Explicit release restored
  the original idle setting.
- The combined candidate passed one real Kiwix process restart. The default
  heartbeat observed the old assertion had ended and made exactly one confirmed
  replacement, taking 479 ms. The original logical deadline stayed fixed. A
  further 75.012-second no-touch window retained SDK assertion, foreground and
  idle-disabled state; release restored the prior setting. No auxiliary renewal
  process supplied protection during this window (`ios/181-combined-verdict.json`).
- OPPO remained unlocked and in the test App for 80.590 seconds while its owned
  assertions renewed. Original timeout `600000` and stay-on setting `15` were
  unchanged, so this positive run does not isolate efficacy from OS settings.
  The earlier sleep/Doze negative controls were stopped at the user's request.
  After owned protection was released, a later read observed normal timeout
  and keyguard; no new wake input was sent. That later state does not invalidate
  the timestamped positive window or mean the phone stayed unlocked indefinitely.
- Full functional regression initially finished with 1,815 passes, five failures
  and one cancellation. All 88 tests in the affected files passed when rerun
  serially and with the original concurrency of two, without timeout changes.
  The initial long delays are not assigned a proven cause. The final frozen
  candidate run completed 1,846 functional passes and one documentation-mirror
  failure; all six original failing/cancelled cases passed. Synchronizing the two
  use-skill copies fixed that failure, with its original four-test file passing
  unchanged. Performance passed 50/50. The 2,179 executable/configuration/artifact
  files retained aggregate SHA-256 `06b6c6296b0095daa120f67b8a5ccbd2a3cb1b093d767cb2acb6eecef7cd91f3`
  across the full run and focused recheck. The original failures remain recorded.

Candidate identity and review: `power-recovery-candidate-manifest.json`,
`power-rebind-diagnosis/POST_RESTART_REVIEW.md`. Only four Host power modules
differ from the public installed CLI in that frozen device candidate. No SDK,
global installation or public release was silently replaced.

## Permission-alert handoff audit

This run does not justify saying that button clicks took several minutes.
The WDA setup call took 111.556 seconds and included Xcode waiting for the phone
to unlock. A failed status query was issued while that setup was still running;
it was not evidence that a ready executor had subsequently failed. The existing
setup implementation already waits for WDA status and execution readiness.

The seven calls in the later alert-handling interval took 13.509 seconds in
total, including 7.814 seconds for the two actual label-based button taps.
The interval spanned 113.748 seconds: 100.239 seconds were between calls. A
137,197-byte native tree was delivered by reference, then incorrectly consumed
as an inline value by the caller. Known steps should be put in one ordinary
Script, and a required reference should be read without replaying the action.

These are invocation defects, distinct from the confirmed power code defect.
The source audit also found missing structured guidance for actual WDA session
and transport errors. The local repair supplies schema-valid read-only diagnosis
for the original connection; an unknown action first queries its original ID and
epoch. The related suite passed 77 tests, including six new regressions, and offline replay of the
two real failed envelopes now supplies the missing guidance. No action is replayed
or session changed by these suggestions. This guidance repair has no new physical
device execution claim.
The completed system-alert sequence used WDA to select Allow and WLAN Only,
then observed Kiwix foreground again. It did not infer success from a request
being accepted or from an empty/partial tree.

One additional hypothesis remains experimental: the SDK clears its power lease
on `willResignActive`, which can occur for temporary system overlays. Apple
distinguishes that state from entering the background. Any change here needs a
real permission/return test and must retain restoration on background, expiry
and shutdown. No change to that SDK lifecycle is included in the Host candidate.
See Apple's [application state](https://developer.apple.com/documentation/uikit/uiapplication/applicationstate)
and [inactive notification](https://developer.apple.com/documentation/uikit/uiapplication/willresignactivenotification)
contracts.

## Task-level protection and Windows

The parent task retains separate bounded leases for macOS and every selected
device across analysis and subtask completion. Finishing a subtask releases only
its additional lease. This also applies to Windows: the same Host lease uses the
PowerShell worker's `SetThreadExecutionState` assertion, with renewal, expiry and
owned cleanup. Windows protocol/lifecycle checks ran with a substitute worker on
macOS; the actual Windows PowerShell/API path remains untested on Windows.
Subsequent installation review found the bundled native FactStore rejects
win32, so Windows is not merely missing a physical test: complete Host support
is still open. The exact blocker and implementation gates are recorded in
[WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md](WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md).

An ID retained by the coordinator is not proof that protection is still active.
At 15:01 the old OPPO lease reported `power_worker_closed`; its earlier confirmed
assertion had expired. A fresh read found OPPO connected and USB-powered, and the
parent acquired and confirmed a new explicit lease. No continuity across that
gap, manual unlocking, or cause of the transport closure is claimed. The earlier
charging-state discrepancy also remains unexplained: framework battery overrides
were reset, yet the earlier kernel USB-online and framework charging flags were
false. At the new check they were true. The stay-on setting remained `15`.

The current parent inventory is `ROOT_WORK_LEASES.json` in the evidence root.
It is renewed before its deadline while this work continues, then explicitly
released at overall completion; no touch, lock, or wake-input loop is used.

## Remaining release gates

After the child-exit repair, the complete frozen Host run passed 1,855/1,855
functional and 50/50 performance tests. Clean-package verification passed in
87.593 seconds. A final archive contains identical execution files; its only
differences from the validated package are the power document and use skill.
All 238 members match source. Archive SHA-256 is
`db5dd187738e4caf06c8de1791517b0ff2c2d63a1cf92db95918424472fc9365`.
The final skill-mirror test also passed. Logs and source snapshots are in
`worker-exit-final-validation-1792049655365/`.

These are local candidate gates, not a new publication or complete Windows
support. The Windows installation/native-storage work above is still open.
The slow permission handoff remains an invocation and usability gap; no fast
combined permission Script was measured here. Published 0.4.10 is not overwritten,
and unfinished checks are not converted to passes by its earlier publication.
