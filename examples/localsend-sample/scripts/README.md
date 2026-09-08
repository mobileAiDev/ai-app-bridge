# Frozen-evidence LocalSend Script

`localsend-flow.v1.js` implements the two versioned scenarios in this directory.
Its initial author used frozen public Intent observations, archive payloads,
screenshot bindings and public Script contracts. `authorship.v1.json` records
the reads, hash checks, selector decisions and explicitly shared pilot feedback.
No upstream application source or prior sample Script was used.

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
stability. These waits are bounded reads and cannot repeat a mutation. Flutter
logical bounds are converted using the current validated viewport DPR; app taps
must return the explicit native Bridge transport. The one picker Cancel tap uses
its observed UIA physical bounds, explicit picker package and `feedback:"off"`.
Settings uses observed physical swipes. About uses the declared primary
`scroll-flutter` route, one logical step of at most 450 at a time, after asserting
one current matching `SingleChildScrollView`. Every further step requires fresh
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
`checkpoints`, `actions`, `screenshots`, `mobileCaptures`, `lastPage`, `stop` and
`settingsGeometry` with its baseline/restored references, `stableObservations`
with both qualifying snapshot generations and evidence references, plus
supplemental `wallMs`. Runtime assertion counts depend on bounded scroll steps
and qualifying observations.
Successful core/acceptance paths capture 6/13 screenshots and make 3/9 mobile
stream assertions respectively. Mobile assertion names contain
`facts recorded in the current action window`; their outcomes remain separate
from the UI replay verdict. `completed` only means that execution ended.

Before each declared mobile-evidence action, the worker obtains a complete current
per-stream cursor using a bounded `sinceMs` read. After one mutation it queries
with that exact cursor, epoch and action ID. Missing boundaries are retained as
inconclusive. The system picker action does not establish an app-local capture
association. An empty stream or generic capture existence cannot prove business
semantics. The preserved first pilot exposed the missing watermark query and led
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

Full acceptance still requires a controlled no-peer fixture and discovery oracle,
reliable business-correlated mobile state/events/logs, and final independent
preference equality. The repeated diagnostic `DevicePlaceholderListTile` assertion
proves the current empty-discovery UI branch only. Transfer success, Rust transport
coverage, onboarding variants and in-flight device-action cancellation are not
established by this scenario. Keep these limits in the report even when UI replay
and preference restoration pass.

Export each recording with full recorded payloads, pin the manifest hash, and use
a separate offline public evidence verifier. Retain failed and cancelled archives.
Measure the fixed scenarios separately: core ≤300 seconds; acceptance ≤600 seconds.
Host timing categories may overlap, and ordinary JavaScript waits are not a
separate measured business-wait category. Agent-oracle waits count in wall time.
The controller also measures question-to-decision duration; a terminal Host
rolling summary reporting zero decision wait is not evidence of zero actual wait.
This directory's author performed syntax, frozen-selector and byte-integrity
checks; live replay belongs to the independent controller.
