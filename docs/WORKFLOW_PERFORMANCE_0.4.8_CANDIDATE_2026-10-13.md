# Workflow performance after the 0.4.7 release

Status: **in progress, not a new public release**. The installed CLI and the
reconnected Codex MCP still use 0.4.7; the live Runtime reports `compatible:true`.
The published 0.4.7 artifacts and tag have not been replaced. This document
records subsequent source changes and their actual limits.

Evidence is under the sibling directory
`ai-app-bridge-release-evidence/0.4.8-work/2026-10-13/` (called `N` below).
The directory name is a work label, not evidence of publication.

## Discovery and complete response delivery

The MCP run description incorrectly required `extract` although its schema
already made it optional. The description now agrees with the contract. Script
discovery states the actual `ctx.call` envelope (`ok/result/error`), includes
executable JavaScript and Python start examples, and identifies `recordingDir`
as a sibling of `script`. Lifecycle queries retain their complete selected
schemas without repeating the authoring catalog. The three original regressions
failed before the changes; all 38 related tests passed afterwards, including
unchanged examples executed through an isolated real MCP in both languages.

Actual 29–31 KiB Web snapshots contained optional control fields. The old 32 KiB
formatting threshold and uniform-row requirement left these replies verbose.
Auto now tries lossless formatting above 8 KiB and uses it only when the existing
savings/budget rules permit. This threshold does not truncate the result or
require a second read. The v3 table representation retains every row, identity,
optional field, missing/null distinction and original capture-coverage flag.
Explicit `extract:null` and ordinary Script call results keep their original shape.

Replaying the same 13 real replies reduced complete MCP response bytes from
234,835 to 139,292 (40.69%), including source references. Independent expansion
restored every original field and execution failure. Formatting the measured
30,956-byte DOM added about 2 ms median local CPU/wall work; this is delivery
savings, not faster browser collection or proof of faster agent reasoning.
See `N/web-latency/replay-sparse-after.json` and `delivery-cpu.json`.

Independent review found a candidate regression that the original full suite
did not cover: one heterogeneous diagnostic array selected v3 globally and
disabled the existing delta column representation. A previously compact full
baseline exceeded 96 KiB and required a saved-response read. Delta now explicitly
uses its original homogeneous-table strategy, retaining `columns/v1` and leaving
heterogeneous branches intact. A failing-then-passing public-reply regression
covers the complete initial baseline, subsequent patch, checksum and original
saved response. The frozen first-use candidate below has not been overwritten
with this later correction.

## Independent first use remains too slow

Two separate fresh-context agents used new Memos databases and authored their
own ordinary scripts. Both registered an account, created two related notes,
searched for only FIRST, edited FIRST, entered and cancelled deletion, and
verified the exact final text after reload. Independent read-only SQLite checks
confirmed both contents, no deletion and an unchanged SECOND timestamp.

| Measurement | Public 0.4.7 | Frozen candidate |
|---|---:|---:|
| Environment setup | 1.531 s | 1.694 s |
| Agent dispatch to final UI verification | 355.653 s | 311.083 s |
| UI completion to independent database check | 157.180 s | 189.845 s |
| Dispatch to database check | 512.833 s | 500.928 s |
| Accepted MCP calls | 14 | 13 |
| Capability queries | 6 | 6 |
| MCP response bytes | 156,927 | 127,142 |
| Time inside accepted MCP request windows | 10.685 s | 1.979 s |
| Time outside those windows | 344.968 s | 309.104 s |
| Authored source characters | 10,959 | 6,746 |

The 44.570-second UI difference is one sample per arm, not an isolated causal
compression result or a percentile. The candidate still took over five minutes
and did not meet the intended first-use efficiency. Its 1.483-second successful
Script-body total is not the user workflow time. The database-check delays are
parent coordination/resumption time, not database or UI execution latency.

All mistakes remain in the evidence: invalid app username, a textarea-only
assumption, premature URL-only readiness, an assertion that included a `New`
badge, and reads bound to the old document after reload. The test controller
also rejected two/three concurrent discovery attempts with HTTP 409 because of
its own single-request slot. Those are fixture failures; their unrecorded
durations cannot be subtracted or assigned to Bridge. Neither agent wrote a
compact-response decoder or needed an extra read because of compression.

The existing Script interface now ships an editable `web-steps.js` source
module and a short first-use example. Callers can reuse observation, binding
and wait helpers while keeping predicates and business branches in ordinary
JavaScript. Other commands remain available through `ctx.call`; `askAgent`
still allows unresolved choices to return to the agent. There is no additional
execution API or JSON workflow language. Recipe start requests explicitly wait
up to 60 seconds for a result; the global asynchronous Script default is unchanged.

Prepared validation against a separate real Memos instance passed registration,
two-note creation, exact FIRST search, editing, deletion cancellation and exact
post-reload contents. After an old-epoch read was rejected, explicitly reading
the current target allowed binding, actions and waits to continue even inside a
Script whose original default target was old. A real `askAgent`/`decide` exchange
also selected and opened an observed record. Independent database, call-route
and cleanup checks passed. An initial verification-source SyntaxError dispatched
zero business calls; its failure and correction gap are retained. This is
prepared functionality evidence, not a fresh-agent speed result.
See `N/web-latency/live-web-recipe/report.json` and its independent checks.

See [the full comparison](../../ai-app-bridge-release-evidence/0.4.8-work/2026-10-13/web-latency/first-use-comparison.md)
for every stage, request, gap and retained failure. Both dedicated Web
environments were closed after their independent checks; other runtimes were
preserved.

## Native timing diagnosis

The earlier `IOConsoleLocked:false` evidence did not establish a fully active
performance environment. Display/session observations are now recorded
independently, with unavailable facts left unknown and advisory recovery hints.
They do not prevent App execution or change its business verdict.

Further trials reproduced slow first frames even with the display active and
temporary `caffeinate` assertions. Simply selecting `waitForLaunch`, avoiding
early Flutter observations, resetting ART compilation or toggling Perfetto did
not independently establish the cause. Those negative results remain recorded.
RunningBoard reported qemu App Nap CPU/timer restrictions during the 53.503 /
35.401-second first frames and the two approximately 27-second readiness waits
despite active displays. Later unrestricted windows returned to 2–4-second
first frames with the same APK/data/AVD. Historical 26.292 / 21.178-second slow
windows also align with App Nap for the previously recorded qemu PID, although
its original command-line binding lacks explicit AVD/port arguments. These
are strong scheduling observations, not a controlled foreground/background
causal A/B or proof that App Nap explains all delays.

The validation runner now records display/session, emulator CPU and App Nap
facts separately, keeps missing evidence unknown and gives short advisory
recovery hints. Environment warnings do not block execution or change an App's
success verdict. Ten focused tests passed, including a follow-up that accepts
an observed frontmost PID when an unbundled app has no bundle identifier; missing
or invalid identities remain unknown. Actual native probe and lifecycle checks
also passed. No SDK was changed. All seven dedicated Hosts and temporary
caffeine processes were stopped; the original emulator and other runtimes were
preserved. See `N/android-startup/summary.md` for raw windows, retained slow
samples, anomalies and the limits of the conclusion.

## Validation status

The first frozen Host integration run passed **1,652 functional and 50
performance tests**, with all 560 captured files unchanged during the run
(`N/host-integration-1`). This predates the additional delta regression and Web
authoring module.

The final Host integration run passed **1,658 functional and 50 performance
tests** in 196.988 seconds, with all 561 captured files unchanged throughout
(`N/host-integration-2`). The candidate tarball then passed the existing clean
installation and controlled CLI/MCP/npx, continuation, shutdown, permissions
and evidence verification. All **218 shipped files** match the frozen source
by SHA-256. The native prebuild loaded while compiler/Python installation
commands were unavailable; no real device or global Runtime was used for this
package check. See `N/package-candidate-1/report.json` and
`source-install-parity.json`. These candidate bytes still carry the source
version 0.4.7 in an isolated directory; they are not a replacement for published
0.4.7 and will need a new version before publication.

The overall efficiency/capability/recovery goal remains active. iOS device
acceptance remains unavailable and is not implied by compilation or Host tests.
