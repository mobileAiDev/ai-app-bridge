# Frozen-evidence LocalSend Script

`localsend-flow.v1.js` implements the two versioned scenarios in this directory.
Its initial author used frozen public Intent observations, archive payloads,
screenshot bindings and public Script contracts. `authorship.v1.json` records
the reads, hash checks, selector decisions and explicitly shared pilot feedback.
No upstream application source or prior sample Script was used.

Current v1.3.0 uses complete visible Flutter nodes to prove the empty-discovery
branch. Its controller records an explicit fixture: both SIM slots absent,
Wi-Fi disabled, no connected Android network, and WLAN down without addresses.
It checks that condition before and after the UI observations and restores the
original Wi-Fi connection before continuing. These fixture waits are included
in the execution wall time. The bounded widget inspector remains diagnostic.

The original authoring was based on frozen Intent data. The v1.3.0 predicate
additionally uses the fixed upstream card layout and new Intent companion
snapshots/screenshots; this source review is recorded in the manifests. The
[v1.2.0 evidence contract](../../../docs/LOCALSEND_EVIDENCE_CONTRACT_2026-09-12.md)
for exact original action facts, business route outcomes and independent
persisted results is retained. Previous run verdicts remain unchanged.
Use the current public CLI [suite runner](../../device-regression/README.md),
which handles both the preference and network-fixture requests.

Use the public Script runtime with `app.read`, `app.interact`, `capture.read`,
restart policy `none`, an explicit target, and a new `recordingDir`. The controller
must create an existing per-run screenshot directory before supplying inputs:

```json
{
  "serial": "FYZLAU49X8OVQGJ7",
  "outputDir": "/absolute/existing/per-run/script-output",
  "scenario": "acceptance",
  "expectedDeviceName": "好的椰子",
  "cancelBeforeSettings": false
}
```

The initial fixture is Chinese Receive, no selected files, Settings at the top,
and the exact allowlisted preference map below. The locale key must be absent.
The controller independently reads this map before start and again after the
terminal result. It performs fixture restoration outside the Script.
The worker also retains the current initial Text rectangles for 设置, 主题, 颜色
and 语言. Before `settings-scroll-restored`, all four edges of each current
rectangle must differ from that baseline by strictly less than 0.5 logical pixel. Visible System rows
alone do not establish restoration. The checkpoint retains both geometry maps
and observation references for the controller's separate archive comparison.

```json
{"flutter.ls_theme":"system","flutter.ls_color":"system"}
```

`scenario:"core"` runs Receive → Settings → About → actual Flutter license list
and body → each parent → Settings top → Receive. It does not change preferences.
Acceptance also visits receive-by-link, the empty Send UI branch, the real OPPO
picker followed by Cancel, Dark/English/System restoration, and repeated Send/
Receive navigation. Every app tap waits for matching node, actionable and scroll
geometry across advancing Flutter `updatedAtMs` generations, then resolves a
unique target whose complete node and actionable bounds fit the current viewport.
New Host observation IDs carrying the same SDK generation do not establish
stability. These waits are bounded reads and cannot repeat a mutation. App taps
use `tap-flutter` with the nodeId selected from that current observation; the
original settled `flutter` receipt must match the execution actionId. The picker
Cancel uses `tap-uia` with the exact observed resourceName and explicit picker
package. Its original UIA callback must bind that resource name and button text.
During the existing ten-second picker observation budget, `uia_tree_changed`
with no dispatched or ambiguous action is recorded and followed by another
explicit tree read. Other errors stop the flow. The archive reviewer requires
the later complete picker observation before any mutation and retains the failed
read in its counts and `pickerReadRecoveries` details.
The language selection assertion binds the unique checkmark to the selected
label by its visible row and shared scroll container. Each node has its own
tap bounds; matching ancestor tap rectangles are not a selection contract.
Settings uses observed physical swipes. About uses the declared primary
`scroll-flutter` route, one logical step of at most 450 at a time, after asserting
one current vertical `role=scrollable` node whose `id`, `scroll.nodeId` and
`targetRef.elementId` match the observed anchor. It sends that explicit `nodeId`
with each scroll. Every further step requires fresh
visible movement or the destination. These routes are fixed by the scenario;
the Script does not change provider after a failed mutation.

The source pauses at these three external preference-oracle requests:

| Checkpoint | Exact expected allowlisted map |
| --- | --- |
| `settings-dark` | theme=`dark`, color=`system`, locale absent |
| `settings-dark-english` | theme=`dark`, color=`system`, locale=`en` |
| `settings-restored` | theme=`system`, color=`system`, locale absent |

Each `ctx.askAgent` request carries this context, with current evidence references:

```javascript
{
  kind: 'localsend.settings-oracle/v1',
  checkpoint: 'settings-dark',
  expectedSettings: { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system' },
  requireExactSettings: true,
  afterActionId, observationId, evidenceRefs
}
```

The controller runs the external oracle, saves the real result, and supplies the
following object as the public decide `decision`. The worker receives it directly
from `ctx.askAgent`. A nonpassing or malformed reply stops the flow before the
next mutation. External results are never presented as device `ctx.assert` evidence.

```javascript
{
  kind: 'localsend.settings-oracle-result/v1',
  checkpoint: 'settings-dark',
  verdict: 'passed', // or failed / inconclusive
  artifact: { path: '/absolute/saved-oracle.json', sha256: '<64 lowercase hex>' },
  observedSettings: { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system' },
  reason: 'Exact allowlisted map compared by the external controller'
}
```

Run three positive acceptance trials from the same verified fixture and unchanged
source hash. The wrong-expectation trial changes only `expectedDeviceName` to
`AAB deliberately wrong device`; its initial fresh-tree assertion must fail before
any mutation. For cancellation, set `cancelBeforeSettings:true`. After the ordinary
UI flow reaches top Settings, the worker asks with context
`kind:"localsend.controlled-cancel/v1"`, checkpoint `before-settings-mutations`.
Cancel the Script while it is `waiting_for_agent`; do not decide that request.
No Theme/Language mutation has been issued at this point. This tests cancellation
while awaiting an agent, and does not prove cancellation during a device action.

The returned `localsend.script-result/v1` object includes `flowCompleted`,
`uiVerdict`, `businessVerdict`, device `assertions`, `externalOracles`, `openGates`,
`checkpoints`, `actions`, `screenshots`, `mobileCaptures`, `businessEvidence`, `lastPage`, `stop` and
`settingsGeometry` with its baseline/restored references, `stableObservations`
with both qualifying snapshot generations and evidence references, plus
supplemental `wallMs`. Runtime assertion counts depend on bounded scroll steps
and qualifying observations.
Completed core/acceptance paths capture 6/14 screenshots and make 1/2 mobile
event assertions respectively. They require ordered started/target.tap/settled
facts matching the original receipt and target; theme restoration additionally
requires the real HomePage pop. Assertions retain `evidenceKind` for UI versus
capture checks, and a failed capture assertion makes the business verdict failed.
The UI verdict requires complete current observations for each business assertion. `completed` only means
that execution ended.

Before each declared mobile-evidence action, the worker obtains a complete current
per-stream cursor using a bounded `sinceMs` read. After one mutation it queries
with that exact cursor, epoch and action ID. Missing boundaries are retained as
inconclusive. The system picker action does not establish an app-local capture
association. All three streams are still queried and recorded. Empty state/logs
and the system action's App-filtered queries are supporting diagnostics; they
are not counted as device evidence of record existence. The system Cancel proof
combines its original callback with the fresh empty-selection page. Business
evidence records link those observations and the separate persisted-setting
checks; it does not invent mobile refs for external results.

The preserved first pilot exposed the missing watermark query and led
to a public authoring-contract clarification plus source revision 1.0.1.
The second preserved pilot completed all three preference oracles, then exposed
two temporary navigation-only trees after a swipe. Revision 1.0.2 requires a
current scrollable content anchor or the destination before accepting movement;
those transition trees cannot authorize another swipe.
The third preserved pilot reached About, where a successful ADB receipt produced
no movement. A separately pinned public Intent `scrollBy(450)` probe moved five
matched labels by exactly 450 logical pixels on a later observation. Revision
1.0.3 therefore declares Flutter scrolling as About's primary route and retains
the failed pilot. The immediate action receipt's summary is not movement proof.
The first matrix run then completed its UI flow but failed the independent
Settings geometry oracle: all four key rows retained a 5.06175-pixel scroll
offset. Revision 1.0.4 requires the saved baseline geometry before stopping the
existing bounded upward scroll. Matrix 2 then passed three acceptance trials
(156405, 191886 and 163216 ms), but its core trial tapped a clipped Back target
from two Host observations of the same animated SDK snapshot and remained on
About. That incomplete matrix is preserved. Revision 1.0.5 adds the advancing
generation and complete-bounds requirements above. Its fresh matrix starts with
core, then runs all three acceptance positives, wrong expectation and cancellation
from the verified fixture; earlier positives are not counted toward that matrix.

The current controller resolves the no-peer fixture and final independent
preference equality with explicit external evidence. Its separate final assessment
also requires all assertions, timing and archive integrity. Script return values
remain unchanged. The v1.3.0 [current result](../../../docs/LOCALSEND_NO_PEER_2026-09-12.md)
passes this fixed navigation scenario; transfer success, Rust transport coverage,
onboarding variants and in-flight device-action cancellation remain separate.

At `before-picker` and `final-send`, the worker requests
`localsend.no-peer-fixture/v1` phases `isolate`, `verify`, and `restore`. The
controller requires the declared no-SIM Wi-Fi fixture and records full raw OS
observations in hashed companion files. Only concise receipts and artifact
references are returned to the worker. Its `finally` owns restoration after a
failed or cancelled execution; raw dumps are not duplicated in the Script result.

Export each recording with full recorded payloads, pin the manifest hash, and use
a separate offline public evidence verifier. Retain failed and cancelled archives.
Measure the fixed scenarios separately: core ≤300 seconds; acceptance ≤600 seconds.
Host timing categories may overlap, and ordinary JavaScript waits are not a
separate measured business-wait category. Agent-oracle waits count in wall time.
The controller also measures question-to-decision duration; a terminal Host
rolling summary reporting zero decision wait is not evidence of zero actual wait.
This directory's author performed syntax, frozen-selector and byte-integrity
checks; live replay belongs to the independent controller.

Revision 1.0.6 updates this scroll binding from the current public Intent evidence
in `command-production-phase3o-2026-09-09/localsend-scroll-contract-evidence.json`.
The old 1.0.5 source and its rejected container assertion remain in
`localsend-transport-matrix-01`. The current maintainer performed this revision;
it is not another independent-author experiment. Business expectations, source
timing limits, negative controls and unresolved external evidence gates remain
unchanged. The scenario manifests pin the new evidence and its exact file hashes.

Revision 1.0.7 additionally uses UIA for the system picker, which has no App SDK.
The explicit foreground-routed Intent in `localsend-picker-intent-01` confirms
the original system-node callback, return to empty Send and unchanged preferences.
The combined evidence manifest is `localsend-current-contract-evidence.json`.
The 1.0.6 rejected App-scope tap remains in `localsend-transport-matrix-03`.

Revision 1.0.8 corrects the receipt checks to use explicit completion guards.
The earlier null-evidence assertion error remains in `localsend-transport-matrix-04`.
Original UI and external evidence requirements remain unchanged.
