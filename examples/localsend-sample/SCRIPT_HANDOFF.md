# Frozen-evidence authoring gate

The deliverable is a reusable Bridge Script for the declared LocalSend scenario.
Author it in a clean context from the frozen Intent artifacts and public Script
contract. The exploration author has not supplied a finished Script. Record
exactly which artifacts and contract files the new author read. Same-context
authoring does not satisfy this gate.

## Fixed inputs

- Upstream source and toolchain: `source.json`; debug package
  `org.localsend.localsend_app.bridge_sample`.
- Current evidence root, relative to the Bridge repository:
  `build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/`.
- Frozen build, source hashes, archives and checkpoint files:
  `handoff-manifest.json` in that evidence root.
- OPPO PGFM10 `FYZLAU49X8OVQGJ7`; both this phone and PKR110 `b46093e6`
  are authorized when connected. Do not operate the POS devices.
- Initial page: Receive; Settings scroll at the top; theme and color System;
  locale absent in persisted preferences, following the Chinese system locale;
  no selected file. Compare exact allowlisted preferences with
  `settings-fixture-baseline.json` using `settings-oracle.py` outside Script.

## Declared scenario

1. Observe Receive and all three navigation destinations.
2. Open link receive, verify the page content, and return. Addresses are live
   network data, not fixed assertions. No transfer is required by this gate.
3. Open Send, verify its selection controls, open Files, observe the actual OPPO
   picker (`com.coloros.filemanager`) with Add(0), cancel, and verify empty Send.
   The master plan also requires the no-peer/empty-discovery branch: freeze its
   page evidence and network/peer precondition before replay. An empty selection
   is not an empty peer list. The earlier Send screenshot shows the placeholder,
   but the peer fixture still needs a repeatable assertion; do not omit this gate.
4. Open Settings, choose Dark on the Theme row, choose English on the Language
   row, return to the system locale, and restore System theme. Independently
   inspect persisted values at the changed and restored checkpoints.
5. Scroll to About, open the row's Open control, scroll to License Notices,
   open `_fe_analyzer_shared`, verify actual license body, and return to Settings.
6. Restore Settings scroll to the top, visit Send and Receive, and verify the
   final fixture and exact settings equality.

## Evidence and targeting rules

Read complete public MCP responses and archive payloads, not just this prose.
Use fresh Flutter operable nodes and their logical `tap.bounds`; IDs belong to
one observation. Labels such as System, Settings and Open can repeat. Resolve
the intended row from current bounds; never take the first text match or copy
coordinates/IDs from this document. Navigation destinations have their own
bounds. The real framework LicensePage now has operable nodes.

Post-action observations may precede an animation or snapshot update. Poll
read-only observations for the declared page condition; never retry a mutation
because its immediate return still shows the previous page. System picker
cancellation can yield `waiting_for_observation`; observe again after the
foreground changes. Keep the intended app/package explicit.

The existing Intent archives contain empty complete action-filtered mobile
event pages. These are not evidence that a business event was recorded. Use
fresh UI and the independent settings oracle for the declared outcomes, and
report this mobile action-correlation gap. Dart HTTP instrumentation does not
prove coverage of LocalSend's Rust transport.

## Acceptance

Freeze one source hash before verification, then run three positive replays,
one deliberately incorrect business expectation and one controlled cancellation
at an Agent wait before settings mutations. The latter does not prove in-flight
device-action cancellation. A failure or missing oracle must never become a
passed verdict. `completed` only says execution ended.

Record runtime, all assertions, fresh evidence references and checkpoints for
every run. Export recorded payloads and verify each archive with its pinned
manifest hash in a separate offline MCP process. Keep failed attempts. Measure
only the declared scenario: core <=5 minutes and acceptance <=10 minutes are
gates to test, not results already achieved. This is not full-app, file-transfer,
whole-device, iOS or four-app acceptance.

Version separate core and acceptance scenario manifests against the LocalSend
row in `docs/SCRIPT_INTENT_RUNTIME_CAPTURE_MASTER_PLAN.md` before measurement.
Keep onboarding/permissions as explicit setup branches when observed. Missing
required mobile evidence or the no-peer fixture leaves full acceptance open,
even when the UI-only replay succeeds.
