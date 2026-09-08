# Authoring a code Script

This describes the current `aab.code-script/v1` implementation. Discover the
running server's command allowlist with `capabilities({command:"script"})` and
each command's arguments with `capabilities({command: name, includeOptions:true})`.
An installed server can differ from a development checkout.

## Start and observe

Call MCP `run` with this shape, replacing the target and absolute source path:

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
      "target": {"serial": "explicit-device", "packageName": "explicit.package"},
      "inputs": {},
      "permissions": ["app.read", "app.interact"],
      "policy": {"timeoutMs": 180000, "restartPolicy": "none"}
    }
  }
}
```

Use exactly one of `sourcePath` and `source`. JavaScript is loaded as CommonJS
in a real Node child. Export `main`; use `ctx.inputs` for run-specific values.
The source is trusted local code, not an OS sandbox. Use `ctx.call` for device
operations so the Host can apply permissions and record receipts.

`start` returns an operation ID without waiting for completion. Query `status`
or `wait` with that `operationId`; `waitMs` bounds one wait and `afterSequence`
pages execution events. Preserve every returned event page and inspect gaps.
`cancel` uses the same operation ID. An execution status of `completed` means
the child returned; it does not imply that its assertions passed.

For a portable evidence run, add `recordingDir` to the start arguments with
a new output directory. The Host records returned calls, assertions and
referenced screenshots before bounded events are evicted. With
`restartPolicy: "none"`, use public `evidence export` with
`includeRecordedPayloads: true`, then offline `evidence verify` with the
saved manifest hash. See [the recording and archive contract](EVIDENCE_ARCHIVE.md).

For successive event waits, set `afterSequence` to the previous response's
**`eventSequence`**. `history.lastSequence` belongs to the history page; there
is no top-level `lastSequence`. Repeatedly passing zero re-delivers old events
immediately. The child's return value is `result` on the `script_completed`
event, not a top-level `status.result`. Preserve event pages so the completion
event remains available after advancing the cursor.

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

For Flutter runtime actions use the public `tap-flutter` command with
`tapX`/`tapY` in **logical pixels**, directly from that Flutter observation.
It requires `app.interact`; both coordinates must be finite and non-negative.
Do not multiply them by the device pixel ratio. The Host supplies the action ID
and sends a typed `tapAt` through the Flutter runtime. Raw `flutter-action`
remains outside the Script catalog. `tap-flutter-text`, `input-flutter-text`
and `scroll-flutter` also carry the Host action ID.

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
come from the current target's bounds. `input-text` accepts `text`, `tapX`,
`tapY`, and `hideKeyboard`; use it for Unicode. `tap` uses `tapX`/`tapY` and
`swipe` uses its discovered start/end argument names. These commands do not
accept Intent's `action`/`selector` decision object.

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
