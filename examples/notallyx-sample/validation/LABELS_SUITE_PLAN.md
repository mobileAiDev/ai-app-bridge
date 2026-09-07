# Label management regression extension

Status: implemented, frozen, and executed as R9 on OPPO PGFM10 / Android SDK 36, serial `FYZLAU49X8OVQGJ7`, using candidate-v2 APK. Run `script-1788755934374-6eea39` completed the combined text/list/label suite in 187.172 seconds: 14 Script phases, 59 UI checkpoints and 15 database snapshots. The runner's seven core templates passed; an independent replay also passed all 59 UI checkpoints. Older runs and their frozen source remain unchanged. See [SCRIPT_REGRESSION.md](SCRIPT_REGRESSION.md) for the command, evidence contract and limits.

The confirmed device failure is preserved in `intent-exploration/1788750907051/8-start.json` through `16-observe.json`: operation `intent-1788751052004-2` created `AAB扩展标签-01`, then submitted the same exact name. Step 15's successful tap receipt only proves dispatch. Step 16 could not observe the app (`socket hang up`, blocked state), and the device crash log identifies `IllegalStateException` in `addLabel` on old APK SHA `8252b6c0a4d36ce1a38c4056ba2bb5becfa63ca18803e7dde42de3116cb80836`. This is a retained failure, not a completed acceptance run. The earlier operation `intent-1788750922485-1` is not silently combined into a successful goal.

## First extension: label management

Target the existing `labels.manage.normal`, `.negative` and `.restart` templates. Use two exact names with a shared prefix, `AAB-label-<runId>-a` and `AAB-label-<runId>-ab`, so substring selection cannot accidentally satisfy the oracle. Reuse the current run's unique text/list notes only after capturing their actual baseline label arrays.

| Phase | Scripted operations derived from real Intent | Independent expected result |
| --- | --- | --- |
| Prepare | Create both labels; assign `a` to note A and `ab` to note B | Label values/order are exact; each note retains its previous labels plus only its intended new label; unrelated notes and preferences remain intact |
| Reject duplicate | Attempt another exact `a` creation; observe the response and current app | No additional row/order change; canonical notes, labels and preferences equal the pre-attempt snapshot; current UI remains usable |
| Reject rename conflict | Rename `a` to already-existing `ab` | Original label and every note reference remain unchanged; no preferences update; fresh app observation succeeds |
| Rename | Rename `a` to `renamed`; inspect label list, navigation and both notes | Every exact `a` reference becomes `renamed`; `ab` references are unchanged; notes and their bodies survive |
| Cancel deletion | Open deletion confirmation for `renamed`, then choose the actual cancellation control | Exact canonical snapshot equality; no removed entity or association |
| Confirm deletion | Reopen confirmation and confirm | Only `renamed` and its associations disappear; IDs, bodies, `ab`, unrelated labels and rows remain |
| Restart | Force-stop, collect quiescent DB, launch and revisit label navigation and both notes | New DB snapshot matches the committed expected result; deleted routes do not return |

After each rejected/cancelled business operation, the runner collects a fresh independent SQLite/WAL/preferences snapshot before further mutations. Missing or crashed observations are inconclusive/failed evidence, never a successful rejection. The source Intent screenshots show the transient “标签已存在” toast; the automated oracle does not claim to read it. It proves the exact duplicate/conflicting input before Save, then requires a fresh unchanged management page and exact canonical storage equality. A tap receipt alone cannot prove either rejection or survival.

UI checks retain exact label text and bind controls to the same observed row/dialog. Text `a` cannot select `ab`, another note's chip cannot satisfy note A, and a background input cannot serve as the current dialog. Duplicate creation records the complete existing value; conflicting rename records original `a` and replacement `ab` in separate Host-issued checkpoints before Save. Real Node-child negative tests prove that an `ok` input receipt with unchanged text does not dispatch Save. Stable observation, IME handling, viewport bounds and tree–PNG–tree Host provenance remain required. The highest non-hidden window is selected before validation; an unknown or disabled foreground cannot fall back to the background management page. A missing checkbox checked boolean is not invented.

## Scope kept pending

`labels.assignment.normal/restart` additionally require two-note selection, the three-state dialog, explicit selected/unchecked/unchanged behavior, and subsequent single-note removal. `labels.assignment.negative` requires cancelling that actual dialog; Back from an activity that applies selection immediately is not equivalent. These templates remain unverified until those distinct controls and outcomes have been observed.

`labels.navigation_layout.*` requires reordering, hidden-label behavior, More/maxLabels and restoration. Label creation/rename/delete does not cover it. Hidden labels also filter associated notes from Notes overview in the upstream behavior; that must not be misreported as data deletion.

## Reporting and source evidence

The report keeps the full 51-feature / 143-template / 396-slot denominator. R9 has 7 passed templates, 2 inconclusive partial templates and 134 not run; all 311 parameter variants remain unexecuted. `labels.manage` is the only fully passed feature. The earlier organization fragment remains attempt 1; completed label management is a separate attempt 2. Normal/restart share an explicitly recorded prefix; duplicate, conflicting rename and cancellation each retain their own before/after snapshots and results. One passed duplicate rejection does not stand in for the other negative branches.

`labels-evidence-source-index-v2.json` and `source-evidence-labels-v2/` are frozen with 225 preserved artifacts: 172 indexed files and 53 dependencies. They verify in a relocated repository without the original `build/` directory. The prior v1 bundle is unchanged. Source operations from `intent-exploration/1788752615378` are:

| Original response range | Operation ID | Preserved outcome |
| --- | --- | --- |
| 1–13 | `intent-1788752668874-1` | Completed duplicate rejection |
| 14–49 | `intent-1788752991946-2` | Completed creation and assignment to separate notes |
| 50–62 | `intent-1788753529249-3` | Completed rename-conflict rejection |
| 63–88 | `intent-1788753729297-4` | Completed rename, navigation and both-note checks |
| 89–99 | `intent-1788754163691-5` | Completed cancellation; failed helper-oracle invocation retained separately |
| 100–102 | `intent-1788754600061-6` | Failed unsupported selector, retained |
| 103–118 | `intent-1788754627577-7` | Deletion dispatched, later ambiguous node selection failed; whole operation remains failed |
| 119–130 | `intent-1788754681926-8` | New completed operation verifies post-deletion notes |
| 131–140 | `intent-1788754805340-9` | Completed observations after restart |

Independent source snapshots prove the preparation, rename, rejection/cancellation equality, deletion and restart values. The original restart has force-stop/pidof evidence and a changed capture-page epoch, but no separately saved launch transcript; its feedback still contains an old epoch. These historical limitations remain in the index. File/dependency hashes establish preserved source bytes, not durable receipt validity or a new run's business outcome.

R9 uses new captures and its actual APK/source hashes, saves launch responses, and includes label phases, launches, collectors and independent oracles in its ten-minute clock. Its 187.172 seconds is fixed-regression time; historical exploration, coding, debugging and installation are separate. It does not measure model latency or claim an Agent/JS/Script speed comparison. The candidate passed 61/61 offline tests and a separate 61/61 independent rerun before device execution. The complete App remains unverified despite this core suite passing.

R9's independent archive reviews also passed 15/15 SQLite/WAL rereads, all seven label transition/equality checks, all 894 artifact-entry hashes and 270/270 durable Host-record checksums with close/reopen verification. The old two notes were unchanged in every snapshot and the final database contained four notes. These checks used archived inputs and temporary Host-store copies without device commands or changes to the original evidence. Full paths and exact executed hashes are recorded in [SCRIPT_REGRESSION.md](SCRIPT_REGRESSION.md).
