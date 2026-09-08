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
