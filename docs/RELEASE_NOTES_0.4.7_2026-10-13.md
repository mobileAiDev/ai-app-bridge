# 0.4.7 release scope and measured limits

This version addresses failures found while using Intent and ordinary
JavaScript/Python Script against native Android, Flutter, embedded H5, SDK-free
UIA apps and an independent Web app. It retains the existing execution interfaces
and the agent's ability to inspect, decide, continue, cancel and force-stop.

## Changes

- Reuse eligible connections and remove redundant launch, foreground and widget
  observations. Launch acceptance and business readiness remain separate facts.
  Local waits handle loading, network errors and retries within one execution.
- Script `decide` and explicit continuation can return the next question or
  final result within a bounded wait. Failed programs retain their error and
  progress; checkpoints support explicit continuation without replaying effects
  whose outcome is unknown. Agent waiting is accounted for in timing summaries.
- Optional delta extraction reduces repeated tree delivery while preserving fresh
  capture metadata and a complete response reference. Default auto delivery and
  existing command composition remain available.
- Web observations expose bounded actual ancestor text for unlabelled controls.
  Web/H5 actions accept complete observed controls and page references, retaining
  required identity validation and projecting only defined identity fields into
  strict H5 renderers. Additive metadata no longer causes a field rejection.
- Android permission parsing, UIA package filtering, loading H5 waits and several
  target-specific recovery messages are corrected. Flutter runtime selection is
  bound to the resumed Activity, including multiple retained engines.
- Android fact-store bulk I/O and CRC computation have equivalence and corruption
  tests. CRC CPU improvements measured in an isolated payload probe have not
  established an end-to-end startup improvement.

## Actual workflow evidence

The expanded samples include a persistent HTTP backend, search, variants, cart,
address, permissions, H5 campaigns, checkout, payment-query reconciliation and
refunds. Payment is an isolated test ledger. Existing NotallyX, Flexify and Memos
provide independent application targets with their upstream attribution.

Prepared native, mixed Flutter/H5 and UIA workflows run continuously through the
existing public interfaces. Examples include a 187-command native/H5 journey in
50.557 seconds with one external call, a 53-command Activity/engine check in
11.607 seconds including its oracle, and an independently verified prepared Web
workflow in 10.71 seconds. These are scenario measurements, not full-app coverage
or unfamiliar-app discovery claims. The full run history includes failed runs,
network faults, process death, response loss, cancellation and continuation.

The complete-observation Web fix also passed a real registration and note-creation
flow: all five input/click actions settled, and UI assertions agreed with a
read-only SQLite check. It removes a real first-use rejection; it does not prove
that all first-use costs have been eliminated.

## Remaining limits

- Fresh-context Web discovery still takes minutes. The most recent assisted run
  took 394.947 seconds from agent dispatch to UI completion and 439.180 seconds
  through the independent database check. Its 1.710-second sum of inner command
  durations is not the user's total elapsed time. Mistakes and decision waits
  remain included.
- Unlocked Android runs include 21.178-second readiness and 26.292-second first
  frame outliers. Later shorter runs did not establish their cause. The latest
  CRC candidate passed recovery but did not show a paired whole-startup speedup.
- iOS has source/contract checks and an unsigned build check, without new device
  or Simulator runtime acceptance. Android emulator evidence does not substitute
  for iOS or all OEM devices.

The broader goal of consistently testing an unfamiliar complex app within one
minute is **not achieved**. This release ships the verified fixes and keeps that
goal open. Detailed scenarios, source fingerprints and external evidence paths
are in [the workflow record](WORKFLOW_PERFORMANCE_PLAN_2026-10-12.md).
