# Native editing through Intent

Use a current supervised Intent observation. To acquire a newer screen without dispatching an action, call:

```json
{"operation":"observe","operationId":"your-intent","basedOnRevision":1}
```

Use the canonical `observe` operation. It reads the provider and persists the observation and summary before exposing revision + 1 while waiting for a decision or observation. Old decisions then require the new revision. It does not sleep, tap, or restart a terminal execution.

Submit an editing decision using the returned revision:

```json
{"operation":"decide","operationId":"your-intent","decision":{"decisionId":"edit-title-1","agentDecision":"act","basedOnRevision":2,"action":{"action":"inputText","selector":{"resourceName":"io.github.mobileaidev.notallyx.sample:id/EnterTitle"},"value":"Example title"}}}
```

`tap` uses the same selector shape. Select one identity through `resourceName`, exact `text`, or `contentDescription`; an optional `within` scopes the native match. Native selection requires exactly one enabled, effectively visible node in the topmost observed window and a center inside its viewport. Input additionally requires SDK `editable: true`. Missing or false `editable` always rejects; class-name guesses are not supported. Duplicate, invisible, obscured and noneditable targets fail without dispatch. Before dispatch, the adapter reads the current tree again and checks the window and semantic identity. A replaced, ambiguous or ineligible target rejects without input. Native `scroll` requires the selected container and `direction:"down"` or `"up"`. Flutter scrolling uses the separate `scrollBy` action.

Native summaries preserve `resourceName`, `editable`, `visible`, and `effectiveVisible` when supplied by the SDK, including blank input fields. Missing metadata remains unknown. The top-level `activity` is copied from the current raw tree. Summary visibility does not establish that a node belongs to the foreground window; the adapter separately enforces the topmost observed window. Each summary node retains its `rawTreeId` and `sourceIndex` for evidence lookup.

An exact native accessibility name can use `selector: {"contentDescription":"置于顶部"}`. It is a separate selector from `text`; no substring match or text/description fallback occurs. A native summary `label` derived from the raw `contentDescription` corresponds to this explicit selector. The same unique visible foreground target rules apply.

Native tap and input pass the selector, SDK `targetRef` and Host action ID to the dedicated `/v1/action/tap-target` and `/v1/action/input-target` endpoints. They do not send coordinates. The SDK validates the runtime, original operable window, View instance, observed semantic ancestry, uniqueness and eligibility on the UI thread immediately before the action. Geometry changes on the same View use its current position. Input binds to that exact editor and rechecks after synchronous focus/connection callbacks; a rejection after requesting focus reports that dispatch already began. It never inserts text into a replacement editor.

Script and direct CLI/MCP callers can use the same editor binding through
`input-text` with `{selector, text}`. Empty text clears the editor. The command
reobserves and revalidates the selector; an Intent decision additionally names
the Agent-reviewed revision. Neither entry substitutes coordinates when the
SDK target reference is unavailable.

Window snapshots distinguish `focused`, `focusable`, `touchable` and nullable `focusOwnerWindowId`. A touchable, non-focusable popup accepts pointer actions only while a window with the same application window token retains focus. The top visible window still owns selection: an overlay never grants access to a background target. Missing metadata, a non-touchable window, or loss of the owning focus rejects explicitly. Native text input still requires the selected window itself to have focus. Tap and gesture events preserve screen-space `rawX/rawY` as well as window-local `x/y`, including cancellation events.

These actions require `targetRef.schemaVersion:"aab.native-target/v1"`. Missing metadata or an unsupported endpoint returns `native_atomic_target_unavailable` without a coordinate/ADB fallback. SDK tasks still queued when their UI wait times out cannot execute later; already-started mutations can have an ambiguous timeout outcome. Native gestures use this reference contract too, with the timed stream described below. Flutter and system UIA do not yet have this SDK execution binding. Host receipts and SDK target validation still require runtime evidence and independent business-state verification.

Unsupported actions/providers fail closed. UIA and Flutter inputText are outside this addition. Unknown actions never become taps. Intent execution completion is separate from business acceptance.

Native `longPress` requires an exact `selector` and integer `durationMs:500..10000`.
Native `swipe` requires an exact `selector`, numeric `deltaX`/`deltaY`, and integer
`durationMs:1..10000`. The SDK computes the start from the selected node's current
center; the endpoint adds those deltas and must remain inside the current window.
A downward finger gesture has positive `deltaY`.

Native `scroll` uses an explicit container, for example
`{action:"scroll", selector:{resourceName:"example.app:id/list"}, direction:"down"}`.
It swipes within that container's visible area (`durationMs` defaults to 400).
If it cannot scroll in that direction, `native_scroll_boundary` rejects before
touch. UIA `scroll` remains a separate viewport action with an explicit provider.

The SDK binds the window/View before DOWN and runs real-time touch events through
the UI handler. Window/focus loss or cancellation sends CANCEL to the original
window. It does not undo a long-click callback or other App effects. Host waits
for a bounded cancellation acknowledgement after response loss; missing or
invalid confirmation remains ambiguous and never triggers a gesture replay.
Started/terminal phone `ui.interaction` events retain the action ID. Arbitrary
delayed callbacks are not all causally tagged. Reobserve and verify actual App
state; a completed touch stream alone does not establish business acceptance.

The same implementation is available to Script and direct commands as
`native-gesture`, with the action object under `payload`. Script uses
`ctx.call('native-gesture', {payload:{action:'longPress', selector:{text:'Observed note'}, durationMs:700}})`;
the Script target supplies serial/packageName, and Host owns action identity.
See [the command contract](COMMAND_CONTRACT.md) for cancellation and receipt fields.

`action: "back"` sends Android Back. `action: "keyevent", keyCode: 4` expresses
that key explicitly. Observe the keyboard/page state before deciding what Back
should accomplish; dismissing a keyboard and leaving a page are different outcomes.

Preserve per-step Intent responses and action receipts. Native observations
currently do not take a screenshot automatically: `summary.screenshotId` can
be null. A separate `screenshot` call should retain its artifact hash, timestamp
and the adjacent observation ID. This association is sequential, not an atomic
tree/screenshot capture. `status.history` is a bounded execution ledger and
does not expose the full stored raw tree for each observation.

Use [the public evidence export](EVIDENCE_ARCHIVE.md) with this Intent's
operationId to freeze retained raw observations, summaries, decisions and
receipts. A returned manifest hash supports verification after moving the
archive or restarting MCP. External screenshot files and phone capture bodies
remain separate; the export reports this coverage explicitly.
