# Authoring a code Script

This describes the current `aab.code-script/v1` implementation. Discover the
running server's command allowlist with `capabilities({command:"script"})` and
each command's arguments with `capabilities({command: name, includeOptions:true})`.
An installed server can differ from a development checkout.

## Start and observe

Call MCP `run` with this shape, replacing the target and source path:

```json
{
  "command": "script",
  "arguments": {
    "operation": "start",
    "script": {
      "schemaVersion": "aab.code-script/v1",
      "name": "observed-flow",
      "language": "javascript",
      "sourcePath": "/absolute/flow.js",
      "entrypoint": "main",
      "target": {"platform":"android", "serial": "explicit-device", "packageName": "explicit.package"},
      "inputs": {},
      "permissions": ["app.read", "app.interact"],
      "policy": {"timeoutMs": 180000, "restartPolicy": "none"}
    }
  }
}
```

The same request is available through CLI:

```sh
ai-app-bridge script --operation start --script '{"schemaVersion":"aab.code-script/v1","language":"javascript","sourcePath":"./flow.js","permissions":["app.read","app.interact"]}'
ai-app-bridge script --operation status --operation-id RETURNED_ID
ai-app-bridge script --operation result --operation-id RETURNED_ID
```

The CLI returns the operation under `value`. CLI and MCP share a persistent runtime;
the originating connection can close before another connection queries, answers,
pauses or cancels the task. Both must select the same FactStore/runtime namespace.

Local source paths resolve from the initiating client's directory. `script.cwd`
defaults to that directory; set it explicitly to select the child working directory.
It is frozen into Script identity together with source and target. Resume with the
original `cwd` when connecting from another directory. Relative transport paths
in a target also bind to the originating request, rather than a later caller.

Use exactly one of `sourcePath` and `source`. JavaScript is loaded as CommonJS
in a real Node child. Export `main`; use `ctx.inputs` for run-specific values.
The source is trusted local code, not an OS sandbox. Use `ctx.call` for device
operations so the Host can apply permissions and record receipts.

`start` returns an operation ID without waiting for completion. Query `status`
or `wait` with that `operationId`; `waitMs` bounds one wait and `afterSequence`
pages execution events. Preserve every returned event page and inspect gaps.
Track sequence continuity across the event pages you receive. `history.gap`
reports eviction from the bounded in-process history ring; it can be true even
when a continuously polling client has already retained every earlier event.
The durable evidence archive is verified separately.
`cancel` uses the same operation ID. While owned Host calls, assertions or
checkpoint writes are settling, status is `cancelling`; new calls and resume are
rejected. The terminal checkpoint is committed after their receipts. Explicit runtime stop
and SIGINT/SIGTERM to the runtime perform this cleanup for active Scripts,
including those waiting for an Agent. MCP EOF or a signal to a CLI/MCP client
disconnects that client without cancelling the task. Cancellation closes owned local subprocesses and HTTP requests;
it cannot undo an effect already accepted by a device. A submitted effect without
a confirmed result remains `ambiguous`, and cannot be replayed from an old
checkpoint. Permission and lifecycle mutations use the same dispatch ledger as
UI actions. `policy.timeoutMs` is the whole runtime budget; command arguments may
set a shorter `timeoutMs`, but never extend it.

An execution status of `completed` means the child returned and its final JSON
and terminal checkpoint were persisted; it does not imply that assertions passed.

The JavaScript/Python session protocol bounds each UTF-8 JSON frame by the larger
of `maxOutputBytes`, `maxProgressBytes` and 1 MiB, plus 64 KiB for the protocol
envelope. Output and progress retain their separate policy limits. A Host
response exceeding the frame bound ends the Script with `frame_too_large`; a returned
device result is not replayed. For mobile capture, use a bounded `limit` and
follow `evidence.capture.nextCursor` until `hasMore` is false. Check every page's
target, runtime epoch, committed status and gap; pagination must preserve the
entire requested evidence window.

Start uses the `script` field and its nested `target`. `language` is exactly
`javascript` or `python`; provide either `source` or `sourcePath`. The Host freezes
the source, working directory, JSON inputs, target, permissions and policy before execution. Policy
contains `timeoutMs`, `restartPolicy`, `maxOutputBytes` and `maxProgressBytes`;
invalid values are rejected rather than replaced. `onFailure` is removed because
it never controlled code execution. Check call results and assertion verdicts in
source, throw to fail, and use explicit pause/resume/cancel control as needed.
Use `status` or `wait` for progress; there is no separate `progress` operation.

For a portable evidence run, add `recordingDir` to the start arguments with
a new output directory. The Host records returned calls, assertions and
referenced screenshots before bounded events are evicted. With
`restartPolicy: "none"`, use public `evidence export` with
`includeRecordedPayloads: true`, then offline `evidence verify` with the
saved manifest hash. See [the recording and archive contract](EVIDENCE_ARCHIVE.md).

For successive event waits, set `afterSequence` to the previous response's
**`eventSequence`**. `history.lastSequence` belongs to the history page; there
is no top-level `lastSequence`. Repeatedly passing zero re-delivers old events
immediately. Status, wait responses and terminal events carry a small `resultRef`,
not the child's complete return value. Read it with
`script {operation:"result",operationId:"…"}` after completion. The response
contains `result`, `resultRef` and `persisted:true`, read from the retained
FactStore record even after a runtime restart. Event eviction does not determine
result availability.

`resultRef` contains `evidenceId`, `bytes`, `sha256`, `originalSha256` and
`representation`. Password/token redaction occurs before persistence;
`original-json` preserves the return value, while `redacted-json` identifies a
sanitized value. Size and `sha256` cover persisted canonical JSON; the original
canonical JSON has its separate hash. `policy.maxOutputBytes` defaults to 1 MiB
and supports up to 64 MiB, subject to full storage capacity. A result write
failure fails the Script with `result_not_persisted`.

Read failures distinguish `result_not_ready` while running, `result_unavailable`
after failure/cancellation, `result_not_persisted`, `result_not_retained` when the
referenced result has been evicted, and checksum/read errors. If the whole
operation is gone it may be `unknown_operation`. Persist the returned value or
export its evidence before store retention expires; `completed` is not an
unlimited retention promise.

Terminal rolling summaries freeze elapsed and active durations at the terminal
event. Later status queries do not add idle time. For end-to-end measurement,
retain the public start timestamp and terminal event timestamp separately.

## Capability selection

Use `capabilities` to inspect each command's `inputSchema` and `entrypoints.script`.
Script supports the Android, iOS and Web commands listed in the catalog. An Android target requires
`platform: "android"`, `serial`, and `packageName`; optional `adb` and `port`
are retained in the frozen spec and passed to commands that accept them.
Install APKs through the CLI or MCP Intent installation workflow before starting a fixed Script.
Expert commands outside the catalog remain unavailable. Add `app.lifecycle`
explicitly for clear-data fixtures and `app.permissions` for permission
fixture changes. Defaults remain read/capture/interact; source runs as trusted
local code. Targets and permissions participate in the recovery hash.

An iOS target requires `platform: "ios"`, `deviceId` and `bundleId`. SDK transports
use `runtimeUrl` or `iosHost`/`iosPort`; WDA commands additionally require the
explicit `wdaRunnerBundleId` and, where applicable, `wdaSessionId`. The iOS
provider resolves and arbitrates the physical UDID; it never borrows an Android
serial. Script request IDs become the original SDK/WDA action IDs.

For Flutter iOS use `ios-tap-flutter` with an exact `selector`,
`ios-input-flutter-text` with `selector` and `text`, `ios-scroll-flutter` with
`selector` and `delta`, `ios-flutter-back`, and `ios-flutter-hide-keyboard`.
Selector actions use live Flutter Element references. Keyboard dismissal uses
the same managed execution receipt as other actions; observe
`viewport.viewInsets.bottom === 0` before interacting with controls it covered.
Raw `ios-flutter-action` and `ios-h5-eval` remain outside the
Script catalog. Use `ios-flutter-nodes` for fresh observations and device
assertions, and `ios-logs/network/state/events` for mobile evidence.

Web uses `platform: "web"`, `sessionId`, `runtimeEpoch` and optional
`targetId: "main"`. `app.read` admits `web-status` and `web-dom`;
`app.interact` admits `web-click`, `web-input`, `web-key`, `web-scroll` and
`web-wait`. The existing serving Web provider owns the connected session and
mutation lease. Raw `web-command` is outside the Script catalog.

Read `web-dom`, choose exactly one observed control, and send its `elementId`
with `expectedTarget: { pageRef, element }`. The element projection contains
`elementId`, `tag`, `id`, `name`, `type`, `role`, `ariaLabel`, `placeholder`,
`href` and `text` from that observation. `interaction.status` explains whether
the control is ready, disabled, hidden, outside the viewport or obscured.
Reobserve after an action. Wait by observing the required state; a completed
input or click is not evidence that an asynchronous business operation finished.

Web DOM reads issue Host tree observations usable by `ctx.assert` with
`requiredEvidence: ["tree"]`. Web logs/network/state/events are currently
ordinary MCP Host-FactStore reads; their Script/Intent capture-window adapter
and automatic action correlation remain open. They are not advertised as
Script capture evidence. The Memos validation source and independent SQLite
oracle are in `examples/memos-sample/validation`.

A missing target, or `target: null`, is permitted for pure code and
`page-summary`. Device calls still need a complete identity.

Same-platform command arguments can explicitly override the default App or
phone. For a complete per-call target, use the third argument:

```javascript
await ctx.call('uia-tree', {}, {
  target: { platform: 'android', serial: 'explicit-device', packageName: 'com.android.documentsui' }
});
```

Conflicting identities in command arguments and `options.target` are rejected
before dispatch. Incomplete targets never borrow identity or transport fields
from another platform. Events, dispatch markers, receipts, and recordings retain
the bound target; `execution.target` describes the target used for that call.
Provider results remain necessary to verify the device's actual runtime identity.
Changing connection options also invalidates reuse of a previous capture boundary.

For a system picker, explicitly bind its package and use `tap-uia` with one
exact selector field (`text`, `contentDescription` or `resourceName`):

```javascript
await ctx.call('tap-uia', { selector: { text: 'All files' } }, {
  target: { platform: 'android', serial: 'explicit-device', packageName: 'com.example.filemanager' }
});
```

The Host observes and binds the current node, then the phone revalidates it
before clicking. Text and accessibility-description selectors stay distinct.
Observe the destination after each action; after scrolling, wait for stable
observed geometry before selecting the next file.

`tap-text` with `provider:"auto"` discovers Native, Flutter, then UIAutomator
before a single action. It reports the selected provider and observed matches.
An explicit provider pins regression replay. A dispatch error/unknown response
is returned without trying another provider. For Android Native repeated labels,
use `ctx.call('tap-native', { selector: { resourceName: 'app.package:id/control' } })`.
Its exact selector and optional `within` row scope are shared with Native Intent;
the executor observes, revalidates and obtains the SDK target reference. Intent
decisions additionally bind the choice to an Agent-reviewed revision.
For exact Android Native editing, use `ctx.call('input-text', {
selector: { resourceName: 'app.package:id/search' }, text: 'Observed query' })`.
It shares Intent's editor binding, supports empty text to clear, and rejects a
noneditable or replaced target. A selector cannot be combined with coordinates.
For native checkboxes and switches, inspect the observed `checked` boolean
before choosing a tap. `null` means the View is not an Android `Checkable`
control. Reobserve after `native_target_changed`; never blindly replay a toggle.

## Calls and assertions

```javascript
'use strict';

module.exports.main = async function main(ctx) {
  const read = await ctx.call('tree', {
    compact: true, visibleOnly: true, maxNodes: 1000,
  });
  if (!read.ok) throw new Error(`tree:${read.error}`);
  const assertion = await ctx.assert({
    name: 'visible native tree',
    condition: read.result.nodes.some(node => node.visible === true),
    requiredEvidence: ['tree'],
    evidence: read.evidence,
  });
  if (assertion.verdict !== 'passed') {
    throw new Error(`visible native tree:${assertion.verdict}:${assertion.reason || ''}`);
  }
  return { assertion };
};
```

`ctx.call(command, arguments, options?)` returns an envelope with `ok`, `error`,
`command`, `result`, `execution`, `evidence`, and `timings`. Provider payloads
are inside **`result`**. This differs from ordinary MCP `run` results.
`execution.callId` identifies the call; a mutation also has an action ID.

`executionReceipt` is a nullable compact Native/Flutter/H5 SDK or Android shell
settlement proof. `kind` identifies its protocol. A command containing several
physical operations can instead provide `executionReceipts`.
It contains the original action identity and validated outcome, and is retained
in the persisted action receipt. Unknown settlement has no proof. The nested
provider result still preserves its own fields: a Native gesture's `completion`
is the gesture state string, distinct from `executionReceipt`. SDK settlement
does not prove business success or roll back already delivered input. A shell
receipt proves the original command process exited, including a nonzero exit;
assert the observed UI and independent business outcome separately. UIA/physical
input receipts carry the Script action ID without implying SDK event correlation.

H5 completion receipts are top-level fields of `ctx.call(...)`; `result` contains
the command's DOM result. `h5-wait` uses `timeoutMs`/`intervalMs` and keeps each
poll's original identity in `executionReceipts`. To assert their phone events,
read a fresh suffix from the Host-issued pre-action event watermark and compare
event IDs with the receipts. If the initial history page has a gap, establish a
complete new suffix before acting; the old gap remains part of the evidence.
For native `h5-dom`, use the control's `value` to verify empty input; display
`text` and `ariaLabel` are separate fields. See [H5 execution](COMMAND_CONTRACT.md#android-h5-execution-and-dom-operations).
Cancellation fences shell work that has not started. An admitted command drains
on the phone and can outlive the Host timeout; unknown ownership remains blocked.
Recovery
records a separate receipt in the `device-ownership` command's execution history;
it does not rewrite the original unknown action as successful.

Host `call_completed` and `call_failed` events expose that `callId` plus the
returned evidence's `observationId`, `source`, `window`, and `coverage` when
available. Execution history retains these fields in `payloadSummary`.
Use them to associate saved envelopes with Host events, including reads such
as `status` and `keyboard-state` whose `evidenceRefs` can be empty. References
are preserved unchanged; these metadata fields do not create a capture ref or
make incomplete or missing evidence valid for a device assertion.

`ctx.assert` returns `{verdict, name, scope, reason?}`. Verdict is `passed`,
`failed`, or `inconclusive`; it does not throw or stop the program. Code must
check the verdict and implement the intended stopping behavior. `throw` alone
is an execution failure, not a device assertion.

For a device assertion, pass the unchanged `evidence` object from the relevant
current call. The Host verifies that it issued the evidence, that coverage is
complete, that the required stream exists, and that the observation is still
in the current action window. Missing, foreign, edited, evicted or pre-mutation
evidence is inconclusive. The Host validates the evidence boundary, not whether
the author's Boolean predicate correctly expresses the business expectation.

Assert each observed page before the next mutation. Do not claim a union of
several scrolled pages using only the last page's evidence. Record separate
device assertions per page; evaluate cross-page set equality separately and
retain every page and its assertion. The current API has no device assertion
that binds multiple observation objects together.

`ctx.assert({scope:'code', name, condition})` records a local code check. It
cannot accept device evidence and is counted separately. Keep independent
database, file or network business oracles in the report when applicable.

## Flutter snapshot freshness and coordinate actions

`flutter-nodes` returns the SDK's published snapshot. A new Host
`evidence.observationId` can contain the same `result.updatedAtMs` and node
geometry as the previous response. Two equal responses from that one snapshot
do not demonstrate that a route animation or scroll has settled. Keep the
provider snapshot timestamp separate from the Host call identity. For a
stability predicate, require matching relevant geometry across distinct,
advancing SDK snapshot timestamps, with a bounded read deadline. Missing or
nonadvancing generations cannot establish that stability.

Before a coordinate tap, resolve the target from the latest qualifying tree
and validate its complete actionable bounds against the current viewport.
An in-bounds center alone can belong to a button that is mostly offscreen
during a transition. Reobserve without mutation while waiting for the declared
condition; a successful tap receipt does not prove navigation occurred and
must not authorize a blind repeat. Flutter node bounds are logical pixels;
public Android `tap` coordinates are physical pixels, using that observation's
viewport device pixel ratio.

For Flutter semantic actions, use `tap-flutter`, `input-flutter-text` or
`scroll-flutter` with `selector:{text:"Exact label"}` or an observed
`selector:{nodeId:"..."}`. These commands require `app.interact` and bind the
current SDK Element reference before execution. Missing references require an
SDK update and a new observation. Node IDs describe live Elements in one runtime;
do not persist them as cross-run selectors.

Input binds an EditableText and verifies that editor and its focus after the
awaited frames. Supply an explicit selector when several editors are visible;
without one, only a focused or unique editor may be selected. Scrolling likewise
requires one unique container or an explicit container selector. At a boundary,
`flutter_scroll_boundary` is an explicit no-movement result for the code to handle.

`tap-flutter` also retains its explicit `tapX`/`tapY` primitive in **logical
pixels**; do not combine coordinates with a selector or multiply them by DPR.
The Host supplies the action ID for all these paths. Raw `flutter-action`
remains outside the Script catalog. See [the command contract](COMMAND_CONTRACT.md)
for target errors and the remaining Flutter transport cancellation boundary.

The Dart runtime preserves this ID within the dispatched action's async zone,
and freezes it into each record before MethodChannel or HTTP transport awaits.
The matching Android plugin forwards the full capture payload to the current
Android SDK; four native streams retain their existing bounded producers.
Callbacks outside that async scope are unassociated, including ordinary user
input and unrelated background timers. This is async execution context, not
a proof that every later event was caused by the most recent gesture. A
pre-existing listener, isolate, or native physical input does not acquire an
ID by temporal proximity. The iOS plugin does not yet preserve this field.

A route push/pop with `semanticChanged:true` proves that route transition.
It does not prove persisted settings or a transfer result; keep independent
business oracles and preserve missing log/state/network evidence as nonpassing.

## Mobile capture before and after an action

Grant `capture.read` to query `events`, `state`, `logs` or `network`. For each
stream you intend to assert, first read a bounded current window **before the
mutation** and retain its mobile-issued `evidence.capture.watermarkCursor`.
Require a complete, committed page with `gap:false`, `hasMore:false`, and a
nonempty cursor, runtime epoch and target key. An empty item list can establish
a cursor; it does not establish a business outcome.

Treat mobile cursors as opaque. The Android capture reader now issues `cf3`
cursors that bind the committed sequence to the loss revision observed at that
writer barrier. This distinguishes a historical loss from a new enqueue loss
even when no successful record advanced the sequence. Pagination cursors do
not acknowledge losses beyond the returned page. Earlier `cf2` cursors return
`invalid_capture_cursor`; after an SDK change, clear or runtime restart, obtain
a fresh bounded pre-action page. Persisted fact references and archived payloads
retain their identities; never rewrite a cursor or suppress a gap on the Host.
When following `nextCursor`, preserve the original query filters, including
`sinceMs`/`sinceId`; removing them changes the loss window. A complete
pre-action `watermarkCursor` is the separately acknowledged starting boundary.

```javascript
const before = await ctx.call('events', { sinceMs: Date.now() - 1000, limit: 200 });
const capture = before.evidence.capture;
if (!before.ok || before.evidence.coverage.status !== 'complete'
    || before.evidence.coverage.gap || !before.evidence.coverage.committed
    || capture.hasMore !== false || !capture.watermarkCursor
    || !capture.runtimeEpoch || !capture.targetKey) {
  throw new Error('events pre-action boundary unavailable');
}
// tapX/tapY must come from a fresh observation of the intended target.
const action = await ctx.call('tap', { tapX, tapY });
if (!action.ok) throw new Error('tap outcome unavailable; do not retry');
const after = await ctx.call('events', {
  factCursor: capture.watermarkCursor,
  afterActionId: action.execution.actionId,
  runtimeEpoch: capture.runtimeEpoch,
  limit: 200,
});
// Evaluate the declared predicate from after.result.items and pass the
// unchanged after.evidence to ctx.assert; require the events stream.
```

The timestamp bounds the initial read, while the returned cursor supplies the
boundary for the action. Do not replace that cursor with a host timestamp,
invent a cursor or reuse one across intervening mutations. A decision-window
query with an action ID and no lower boundary is rejected with
`decision_watermark_required`. The Host additionally requires the observed
pre-action cursor, matching target, epoch and filter before accepting a capture
assertion. An action targeting a system picker does not establish an app-local
capture boundary for another package. Missing or unassociated mobile facts
remain `inconclusive`; a fresh tree or screenshot cannot substitute for them.

## Native UI and waiting

Selectors for a new flow should come from its observations. Coordinates should
come from the current target's bounds. `input-text` accepts `text`, an optional
Native `selector` or paired `tapX`/`tapY`, and `hideKeyboard`; use it for Unicode
or empty text. Omitting both targeting forms uses the SDK's focused editor
contract. `tap` uses `tapX`/`tapY`, and `swipe` uses its discovered start/end
argument names. Pass command arguments directly, without an Intent decision wrapper.

After an action, poll a fresh tree for an explicit expected state with a bounded
deadline. A sleep or successful mechanical action is not an observed outcome.
Do not retry an uncertain mutation merely because the expected state is absent.

Native trees may contain both an indexed activity/window hierarchy and a
duplicate `root` hierarchy. Preserve window identity when selecting nodes.
`visible` describes provider metadata; it does not prove that an entire label
is readable or that another fixed view is not covering it. Compare screenshots
and clipping/container bounds where that matters. A scroll based on the whole
window can start in a fixed toolbar; verify that the list actually moved.

`ctx.call('screenshot', {outFile:'/absolute/screen.png'})` saves a screenshot.
Preserve the returned artifact path/hash and the nearby tree. A separately
requested screenshot and tree are sequential captures, not an atomic pair;
animations or other intervening changes require fresh observations.

## Progress and deliberate control points

- `await ctx.progress(event)` emits progress; use small structured events.
- `await ctx.askAgent(request)` suspends for a controller decision. A normal
  unattended positive run should not need it. A cancellation experiment can
  deliberately wait here and verify that subsequent device calls never occur.
- `await ctx.checkpoint(name, state)` and `ctx.resume()` support explicit
  checkpoint reentry. They do not save a JavaScript stack. Leave restart policy
  at `none` unless the program implements and tests reentry.
- `ctx.controlPoint()` returns the current control state; SDK calls also
  cooperate with the Host's pause/cancel control.

Save call envelopes, assertions and the final result to a new output directory
provided through inputs. Freeze the source hash before repeats. Report authoring
time, execution time, interventions, positive trials and negative trials
separately. Preserve failed attempts rather than silently replacing them.

## Web capture around a business action

Declare `capture.read`. Read `web-network` and any other required streams before
mutating the App, then query with the original lower watermark:

```javascript
const before = await ctx.call('web-network', {});
const action = await ctx.call('web-click', observedSaveArguments);
const after = await ctx.call('web-network', {
  factCursor: before.evidence.capture.watermarkCursor,
});
// Assert exact request/response content with after.evidence. Do not infer
// causal attribution from the time window or from an HTTP 200 alone.
```

Keep that lower watermark while waiting for the expected record and complete
coverage. If the real request has a known action ID, add
`afterActionId: action.execution.actionId`; otherwise retain its unfiltered
window and explicit `unattributed` origin. `hasMore: true`, partial coverage and
an isolated continuation page cannot prove the full decision window.

The Memos [save-and-capture Script](../../../examples/memos-sample/validation/memos-save-capture.js)
decodes the actual Protobuf request and response, checks the exact memo/content,
verifies the synchronous Save event and checks the rendered checkbox state.
An external read-only SQLite checkpoint checks persistence before restoration.
Unknown `checked: null` is not accepted as unchecked. The sample reports its
actual UI failure even when the backend saved correctly; it does not change the
business expectation to fit the observed page. The entry source is self-contained
because the Script runtime copies that source into its execution directory.
