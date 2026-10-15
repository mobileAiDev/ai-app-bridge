# Authoring a code Script

This describes the current `aab.code-script/v1` implementation. Discover the
running server's command allowlist and start contract with
`capabilities({command:"script", operation:"start"})`, and each device command's arguments with `capabilities({command: name})`.
An installed server can differ from a development checkout.

## Start and observe

Call the existing MCP `run` directly. For a short sequence, put ordinary code
in `source` and set `waitMs`; no separate RPC controller or workflow interpreter
is needed. The following reads a connected Web page in one call. Replace the
target with the session identity actually returned by `web-sessions`:

```json
{"command":"script","arguments":{"operation":"start","waitMs":60000,"script":{"schemaVersion":"aab.code-script/v1","language":"javascript","target":{"platform":"web","sessionId":"<sessionId>","runtimeEpoch":"<runtimeEpoch>","targetId":"main"},"source":"module.exports.main = async ctx => { const read = await ctx.call('web-dom', {}); if (!read.ok) return {error: read.error, detail: read}; return read.result; };"}}}
```

Continue the currently understood steps in the same program, including local
observations, waits and branches on an unfamiliar page. Return a focused question
with `ctx.askAgent` when new judgment is needed; return the result when done.
You do not need to discover the entire App before using Script. See
[Web first use](#web-first-use) below.

## Web first use

With an already connected Web session, call
`run({command:"script",arguments:{operation:"recipes",name:"web-steps"}})`.
It returns editable ordinary JavaScript, an absolute `sourcePath` and a `start`
request. Fill the current session target in `start`; it reads the complete DOM
and waits up to 60 seconds for the result in the same call. The recipe does not
open or inject a browser. Inspect that first observation to choose the actual
fields and result conditions for the App.

For the next understood steps, import the returned `sourcePath` from your own
Script. Replace the path below with that exact path and supply the values in
`script.inputs`. Run this code through the same `script start` with `waitMs:60000`:

```javascript
const { createWebSteps } = require('/returned/sourcePath/recipes/web-steps.js');
exports.main = async ctx => {
  const web = createWebSteps(ctx), i = ctx.inputs;
  let page = await web.wait(p => p.dom.controls.some(c =>
    c.placeholder === i.field && c.editable && c.interaction.status === 'ready'));
  await web.action('web-input', page, web.one(page, c => c.placeholder === i.field), { value: i.value });
  page = await web.wait(p => p.dom.controls.some(c =>
    c.text === i.submit && !c.disabled && c.interaction.status === 'ready'));
  await web.action('web-click', page, web.one(page, c => c.text === i.submit));
  return await web.wait(p => p.dom.bodyText.includes(i.successText));
};
```

Wait on the actual usable control or business result; a URL change can precede
rendering. Continue additional inputs, clicks and branches in this same ordinary
program. `read(args)` returns the complete ordinary `web-dom` result, and
`one(page, predicate)` requires exactly one control. `bind(page, control)` keeps
the page's explicit session/epoch/target and the complete observed control;
`action(command, page, control, args)` uses that binding, calls once and returns
the unchanged call envelope. It does not perform a new observation afterwards.
Other commands remain available through `ctx.call`.

`wait(predicate,{initial,timeoutMs:15000,intervalMs:150})` first checks `initial`
when supplied, then makes full DOM reads against that observation's target.
Each read uses the remaining deadline. Predicates and branches are JavaScript
functions; use complete capture coverage when proving absence. A failed call
throws an error with its original `reply`; a condition timeout retains the last
`observation`. These complete properties are available to a local `catch`; return
the needed facts or an original `error.reply` when the caller needs them. An
uncaught error reports a short diagnostic; original calls remain in Script's
records (set `recordingDir` for exportable local files). The helper does not
refresh a rejected identity or replay an action.
After explicitly reading a new target with `web.read({runtimeEpoch:current})`,
use that returned page for binding or as `wait`'s `initial`, even if `ctx.target`
still names the original epoch.

Only a genuinely unresolved choice needs `askAgent`. Keep the original controls
and page for the answer; a changed binding will be rejected by the Host:

```javascript
let control;
try { control = web.one(page, myBusinessPredicate); }
catch (error) {
  if (error.code !== 'web_element_ambiguous') throw error;
  const choice = await ctx.askAgent({ question: 'Which observed record is intended?', candidates: error.candidates });
  control = web.one(page, c => c.elementId === choice.elementId);
}
await web.action('web-click', page, control);
```

The helper is optional editable source, not a restriction on Script or a separate
execution format. Copy/pin it with your program when a replay needs fixed imports.

## Saved scripts

For reuse, save the code and use `sourcePath`. This Android example shows the
expanded shape; supply the actual target and source path:

```json
{
  "command": "script",
  "extract": null,
  "arguments": {
    "operation": "start",
    "waitMs": 60000,
    "script": {
      "schemaVersion": "aab.code-script/v1",
      "name": "observed-flow",
      "language": "javascript",
      "sourcePath": "/absolute/flow.js",
      "entrypoint": "main",
      "target": {
        "platform": "android",
        "serial": "explicit-device",
        "packageName": "explicit.package"
      },
      "inputs": {},
      "permissions": [
        "app.read",
        "app.interact",
        "capture.read"
      ],
      "policy": {
        "timeoutMs": 180000,
        "restartPolicy": "none"
      }
    }
  }
}
```

The same request is available through CLI:

```sh
ai-app-bridge script --operation start --wait-ms 60000 --script '{"schemaVersion":"aab.code-script/v1","language":"javascript","sourcePath":"./flow.js"}'
ai-app-bridge script --extract null --operation status --operation-id RETURNED_ID
ai-app-bridge script --extract null --operation result --operation-id RETURNED_ID
```

The CLI returns the operation under `value`. CLI and MCP share a persistent runtime;
the originating connection can close before another connection queries, answers,
pauses or cancels the task. Both must select the same FactStore/runtime namespace.

Local source paths resolve from the initiating client's directory. `script.cwd`
defaults to that directory; set it explicitly to select the child working directory.
It is frozen into Script identity together with source and target. Checkpoint
recovery retains that directory even when called from another client directory. Relative transport paths
in a target also bind to the originating request, rather than a later caller.

Use exactly one of `sourcePath` and `source`. JavaScript is loaded as CommonJS
in a real Node child. Export `main`; use `ctx.inputs` for run-specific values.
The source is trusted local code, not an OS sandbox. Use `ctx.call` for device
operations so the Host can apply permissions and record receipts.
`ctx.target` is a copy of the declared default target (or null); changing it does
not change Host routing defaults. `ctx.sourcePath` is the declared source file
(or null for inline source). Python exposes `ctx.target` and `ctx.source_path`.

Local imports work from the declared source file: CommonJS `require('./helper')`,
parent `node_modules`, `__dirname` and `__filename`; Python sibling modules and
packages, `__file__` and normal module metadata (including dataclasses).
Inline code resolves imports from `script.cwd`, with a virtual entry named
`__ai_app_bridge_inline__.js` or `.py` in that directory; no file is written there.
The declared working directory still controls relative file I/O.

The entry's source bytes are frozen into the operation, including after a worker
restart. Imported modules and assets remain ordinary filesystem dependencies;
each new child loads the versions currently at those paths. Copy or pin those
dependencies when a replayable test needs a fixed environment. Script does not
snapshot the whole project or silently substitute missing modules.

## Editable recipes and fewer round trips

Read `script {operation:"recipes"}` to list shipped ordinary JavaScript sources,
then add `name` to read one source and its start request. This works without a
shared Runtime or FactStore. The same directory appears under `catalog.recipes`
in `capabilities {command:"script",operation:"start"}`. CLI:

```sh
ai-app-bridge script --operation recipes
ai-app-bridge script --operation recipes --name android-test-session
ai-app-bridge script --operation recipes --name android-launch-and-wait
ai-app-bridge script --operation recipes --name web-steps
```

Use the returned `start` request, replacing its explicit target and `inputs`.
The returned start request sets `waitMs:60000`; choose `0` when you want an
asynchronous start. You can copy/edit the source or run its installed `sourcePath`; it uses the same
Script lifecycle, call receipts and cancellation as other Scripts. There is no
separate workflow interpreter.

`android-launch-and-wait` launches once and uses `wait-text` for the exact
`readyText` condition, with optional `provider`, `timeoutMs` and `intervalMs`.
The default provider is UIA, so this recipe does not require an integrated App
SDK. The Script returns the launch receipt and last condition result; unsuccessful
or unknown launch stops that recipe without replay. For a custom short batch,
write sequential `ctx.call` statements, handle each returned envelope, then
observe once where the next decision needs fresh state. Use read commands for
condition polling; code decides whether a failed mutation should be tried again.
`wait` already holds until events/state change or its deadline. Use an inline
`result` directly; only read `resultRef` when the value has not been returned.
The launch/wait recipe keeps execution, matched conditions, foreground identity,
timestamps and warnings, while omitting repeated raw dumpsys evidence. Choose
`fullResult:true` when those diagnostic dumps are part of the task. Its result
marks this projection explicitly; normal output still follows the auto budget.

`android-test-session` accepts a device-only target and inputs such as:

```json
{"operation":"prepare","stateFile":"/absolute/session.json","stayAwake":true,"rotation":0,"showImeWithHardware":true,"wake":true}
```

It first records the explicit serial, current Android user, rotation, plugged-in
stay-awake value, IME component, selected subtype/history and hardware-keyboard
visibility setting in a new local file. Only supplied options change settings.
An optional `imeId` uses `ime set` for an installed/enabled keyboard. Each write
is recorded before dispatch and read back; `ok` verifies those setting values,
not whether an App honored rotation or displayed a keyboard. The returned
`restore` request starts the same recipe with
`{"operation":"restore","stateFile":"/absolute/session.json"}`. Keep the file:
restoration works in a new Script after cancellation or connection loss and
restores only settings the preparation attempted, including a lost receipt.
Already restored values cause no write. Existing state files are preserved; use
a fresh path for another preparation. If a write fails, the original record and
receipt remain available for the next choice.

`stayAwake` applies while on AC/USB/wireless power. App orientation policies may
override the default rotation. `wake` requests screen wake only; a credential
lock needs its own authorized interaction, and restore does not turn the screen
off. The recipe restores the recorded Android settings, not arbitrary keyboard
App preferences or the currently focused editor. These semantics follow the
[Android settings definitions](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/provider/Settings.java)
and [IME shell command implementation](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/inputmethod/InputMethodManagerService.java).

## Runtime and permission notes

An explicit `permissions` list replaces the defaults: `events`, `logs`, `network`
and `state` need `capture.read`, included in both starting examples above.
A transient `uia-tree` read rejected with `uia_tree_changed` and
`dispatched:false` may be retried within a bounded wait for a stable snapshot.
Do not use that read retry to replay a mutation with an unknown result.
The repository fixture `scripts/validation/reader-regression.js` demonstrates
this handling with Reader navigation, chapter restoration and captured events.
It expects its documented book, chapters and font-size fixture; it records the
installed SDK version without requiring an exact release number.

`start`, `resume` and `decide` return without waiting by default. Set `waitMs` (up to
60000) to receive completion or an Agent question in that same call. A ready
result is returned inline. `wait` with `until:attention` also includes a ready
result, so do not issue `result` when it is already present.

Query `status` or `wait` with the same `operationId`; `waitMs` bounds one wait
and `afterSequence` selects records after that sequence. Control replies default to one
event and one ledger entry. With no explicit cursor or limits this is the
latest entry, marked `history.window:latest` and `omittedBefore` when older
entries exist. For a history audit, start with `afterSequence:0` and an explicit
`limit`, then use `history.lastSequence` until `history.hasMore` is false. For
event pages, use the last returned `events[].sequence` and an explicit
`eventLimit` until the captured live `eventSequence` is reached. Read those
streams separately if their limits differ. `eventSequence` is the live
watermark, not the last delivered record: using it to page an audit can skip
unread records. `eventLimit` does not enlarge the independent history limit.
Preserve every requested event page and inspect gaps.
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
a confirmed result remains `ambiguous`; ordinary resume does not replay an old
checkpoint across it. The script may inspect an unknown receipt, make an explicit new decision
and commit a later checkpoint; restore uses that boundary and retains the old
unknown receipt. Uncommitted durable writes still prevent a valid checkpoint.
Permission and lifecycle mutations use the same dispatch ledger as
UI actions. `policy.timeoutMs` is the whole runtime budget; command arguments may
set a shorter `timeoutMs`, but never extend it.

### Recover a stopped Script

Enable `policy.restartPolicy:"checkpoint"` when the program needs durable reentry.
If a child exits after an action but before its next checkpoint, inspect the
original operation and current App result. Then use the same `operationId` and
explicitly select the continuation state understood by that frozen program:

```json
{
  "operation": "resume",
  "operationId": "script-existing-id",
  "waitMs": 60000,
  "recovery": {
    "checkpoint": {"name": "query-original-payment", "state": {"phase": "query-payment"}},
    "reason": "Query the submitted payment before deciding the next action."
  }
}
```

The program receives `state` through `ctx.resume()`. It owns the query, branch
and subsequent actions; the runtime does not infer a successful business result.
The new checkpoint is saved before reentry. Existing receipts, missing receipts
and unknown outcomes remain in the history, and new action IDs continue after
the old ones. `reason` is optional. A live program uses ordinary pause/resume;
recovery replaces the entry state of a stopped program. A completed operation or
a program without checkpoint recovery starts a new Script instead. A failed
checkpoint write starts no child and reports the storage error for correction.

After Host loss, `status` and `wait` can still read the retained operation even
when an action lacks its completion receipt. A successful read has `ok:true`;
the returned execution status and `recovery` describe the interrupted program,
checkpoint and unresolved actions. Reading does not restart the child, fill in
missing receipts or make ordinary resume safe. Use those facts and the current
App result to choose an explicit continuation.

If restoration reports `script_hash_mismatch`, inspect the original start
specification. Older evidence could normalize a safe input URL (for example,
adding `/` to `http://host:port`) even though the original hash used its exact
bytes. You can supply the complete, unchanged original `script` on `resume`:

```javascript
{ command: 'script', arguments: {
  operation: 'resume', operationId: originalOperationId,
  script: originalStartScript, waitMs: 60000
} }
```

Use the original working directory, or specify its original absolute `script.cwd`;
unchanged source alone is insufficient. Source, inputs, target, cwd, permissions
and policy must pass the original hash check. Changed source files or missing
original inputs must be corrected before this can resume. Omit `script` for
ordinary recovery from the saved program, which does not need to reread its
source file. Supplying the original spec does not resolve unknown effects;
inspect them and provide `recovery` separately when needed. Old records remain
unchanged. Credential redaction remains enabled.

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
a new or empty output directory. The Host records returned calls, assertions and
referenced screenshots before bounded events are evicted. Checkpoint-enabled
programs create a separate `attempt-*` directory and recording ID for each
restart; previous files are never reopened for writing. The durable checkpoint
records the attempt before the resumed program starts. Use public `evidence export` with
`includeRecordedPayloads: true`, then offline `evidence verify` with the
saved manifest hash. See [the recording and archive contract](EVIDENCE_ARCHIVE.md).

Use `await ctx.recovery()` in JavaScript or `ctx.recovery()` in Python to read
retained action facts after the checkpoint. The same read is available outside
the program as `script {operation:"recovery",operationId:"…"}`. It does not
dispatch or cancel work. After explicit recovery, its initial boundary is the
previous checkpoint; a new program checkpoint establishes a new boundary.
Pass `checkpointId` to select another retained checkpoint. Paginate with the
returned `cursor` and a `limit` (default 20, maximum 100); each page retains the
same upper fact boundary even while the program continues.

Facts include the original action ID, target, command, optional caller label,
receipt references and execution receipt. For example,
`ctx.call('tap-text', {text:'Submit'}, {label:'submit-order'})` records the label
without storing the call's input values in the dispatch marker. Labels describe
steps; avoid putting credentials or private business data in them. A missing
receipt stays ambiguous. Check `coverage.gaps` and `missingMarkers`: absence of
retained evidence is not proof that an effect did not happen. Query the original
receipt or business state and choose an explicit continuation.

After losing an operation ID, use `script {operation:"inventory"}` to list
retained operations needing inspection. Use `view:"all"` to include completed
programs. Pages pin a durable upper boundary; use their `cursor` to continue.
The result separates `durableStatus` from the current Host's `liveStatus` and
gives an original-operation query. A running checkpoint without a live local
runtime is not proof that another process has died. Completed programs with
unsettled effects remain visible. Missing retained history is never proof that
an operation did not execute. One corrupt operation is reported in place without
hiding other readable operations.

For successive progress waits, set `afterSequence` to the previous response's
**`eventSequence`**. `history.lastSequence` belongs to the history page; there
is no top-level `lastSequence`. Repeatedly passing zero re-delivers old events
immediately. Progress waits can omit intermediate records; use the audit cursors
above when every record is required. Status and terminal events carry a small
`resultRef`. Ready attention waits and `start`/`resume` with `waitMs` include the
result inline. If it is absent, use
`script {operation:"result",operationId:"…"}` after completion. That response
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
after failure/cancellation without a returned value, `result_not_persisted`, `result_not_retained` when the
referenced result has been evicted, and checksum/read errors. If the whole
operation is gone it may be `unknown_operation`. Persist the returned value or
export its evidence before store retention expires; `completed` is not an
unlimited retention promise.

If the program catches an execution problem and returns diagnostics, that value
is retained even when the operation remains `failed` (for example, an unknown
dispatched effect). Reading it succeeds with `status:"failed"` and
`executionError`; inspect both the operation status and the returned checks.
A readable report does not convert the original failed/unknown action to success.

`rollingSummary.startedAtMs` is the beginning of the execution segment held by
this Host. `elapsedMs` is wall-clock time from that point; `decisionWaitMs`
accumulates time with at least one unanswered Agent question. `activeMs` excludes
the union of Agent waits, explicit pauses, and stopped time before an explicit
same-Host resume. It includes local code, provider/network waits and persistence;
it is not CPU time or a sum of command durations. Overlapping Agent waits are not
counted twice. Terminal durations freeze until an explicit resume.

After a new Host restores a checkpoint, its new execution segment has a new
`startedAtMs`; these fields do not claim to accumulate across Host restarts.
Durable terminal retrieval without a live summary does not invent one. For the
whole user workflow, retain the outer start/end timestamps and decision events,
including preparation, authoring, recovery and verification time. Historical
releases reported only the currently unanswered question in `decisionWaitMs`,
which returned to zero after a decision; do not compare that old value as a
cumulative metric.

## Lifecycle: start, wait, result

A sequence can finish in one start call: pass `waitMs:60000` to wait
until completion or a request for agent input. The default `waitMs:0` returns
immediately. A completed return value is delivered inline. If it is
still running, use the same operation ID with the wait/result lifecycle below;
do not read the result again when start already supplied it. The program owns
observation, actions and assertions. The repository test suite runs the two sources below against the
current contract with an injected device, so they match the installed package.

1. The following shows the asynchronous lifecycle for callers that need it.
   Use `source` for inline code or `sourcePath` for repeated runs, a
   platform-qualified `target`, and the run's values in `inputs`:

```json lifecycle-example
{"command":"script","extract":null,"arguments":{"operation":"start","script":{"schemaVersion":"aab.code-script/v1","name":"labels-regression","language":"javascript","sourcePath":"./regression.js","target":{"platform":"android","serial":"<serial>","packageName":"<package>"},"inputs":{"entryText":"Labels","expectedText":"New label"}}}}
```

2. Wait with the returned `operationId`. `waitMs` is at most 60000 per call.
   While `status` is `running` or `finishing`, call `wait` again with the
   previous response's `eventSequence` as `afterSequence`:

```json lifecycle-example
{"command":"script","extract":null,"arguments":{"operation":"wait","operationId":"<operationId>","waitMs":30000,"afterSequence":0,"limit":100,"eventLimit":100}}
```

   `finishing` means the program has returned and the result is still being
   persisted; `result` answers `result_not_ready` until the status is terminal.
   This example requests up to 100 records for inspection; omit both limits for
   concise control replies. A complete audit must also drain any remaining
   history pages using `history.lastSequence`, independently of progress waits.
   `waiting_for_agent` means the program called `ctx.askAgent`;
   the current `pendingQuestion` contains `requestId`, `revision` and `request`,
   independently of event filtering. Answer it with `decide` and `waitMs:60000`
   to receive the next question or result in that call, or end the run with
   `cancel`. Outside `waiting_for_agent` the question may be absent or null.
   Keep every requested event page; do not wait out an Agent question.

3. Use an inline `result` immediately. If a terminal reply has a `resultRef` but
   no inline value, read the saved result:

```json lifecycle-example
{"command":"script","extract":null,"arguments":{"operation":"result","operationId":"<operationId>"}}
```

   `completed` only states that the program returned and its value was
   persisted; the verdicts inside `result` decide each case. `failed` and
   `cancelled` without a retained return value produce `result_unavailable`.
   A failed program that returned diagnostics can still have a `resultRef` and
   readable value; the terminal event and `executionError` preserve the reason.

The JavaScript program. Each case records a device assertion against the
observation it judges, and the run stops at the first case that is not `passed`:

```javascript regression-example
'use strict';

// Fixed regression: observe, act once, observe again. Per-run values arrive in
// ctx.inputs; the returned cases are read with script operation:"result".
module.exports.main = async function main(ctx) {
  const cases = [];
  async function observe(step) {
    const read = await ctx.call('tree', { compact: true, visibleOnly: true, maxNodes: 1000 });
    if (!read.ok) throw new Error(`${step}:tree:${read.error}`);
    return read;
  }
  async function check(name, read, condition) {
    const verdict = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: read.evidence });
    cases.push({ name, verdict: verdict.verdict, reason: verdict.reason || null });
    if (verdict.verdict !== 'passed') throw new Error(`${name}:${verdict.verdict}`);
  }
  const before = await observe('before');
  await check('entry control is visible', before,
    before.result.nodes.some(node => node.text === ctx.inputs.entryText && node.visible === true));
  const tap = await ctx.call('tap-text', { targetText: ctx.inputs.entryText });
  if (!tap.ok) throw new Error(`tap-text:${tap.error}`);
  const after = await observe('after');
  await check('expected text is shown after the tap', after,
    after.result.nodes.some(node => node.text === ctx.inputs.expectedText));
  await ctx.progress({ phase: 'done', cases: cases.length });
  return { cases, actionId: tap.execution.actionId };
};
```

The same program in Python; `ctx.assert_` takes one dictionary and envelopes are
dictionaries:

```python regression-example
# Fixed regression: observe, act once, observe again. Per-run values arrive in
# ctx.inputs; the returned cases are read with script operation:"result".
def main(ctx):
    cases = []

    def observe(step):
        read = ctx.call("tree", {"compact": True, "visibleOnly": True, "maxNodes": 1000})
        if not read["ok"]:
            raise Exception(f"{step}:tree:{read['error']}")
        return read

    def check(name, read, condition):
        verdict = ctx.assert_({"name": name, "condition": condition, "requiredEvidence": ["tree"], "evidence": read["evidence"]})
        cases.append({"name": name, "verdict": verdict["verdict"], "reason": verdict.get("reason")})
        if verdict["verdict"] != "passed":
            raise Exception(f"{name}:{verdict['verdict']}")

    before = observe("before")
    check("entry control is visible", before,
          any(node.get("text") == ctx.inputs["entryText"] and node.get("visible") is True for node in before["result"]["nodes"]))
    tap = ctx.call("tap-text", {"targetText": ctx.inputs["entryText"]})
    if not tap["ok"]:
        raise Exception(f"tap-text:{tap['error']}")
    after = observe("after")
    check("expected text is shown after the tap", after,
          any(node.get("text") == ctx.inputs["expectedText"] for node in after["result"]["nodes"]))
    ctx.progress({"phase": "done", "cases": len(cases)})
    return {"cases": cases, "actionId": tap["execution"]["actionId"]}
```

## Capability selection

Use `capabilities` to inspect each command's `inputSchema` and `entrypoints.script`.
Script supports the Android, iOS and Web commands listed in the catalog. An Android target requires
`platform: "android"` and `serial`; `packageName` is needed only for App commands. Optional `adb` and `port`
are retained in the frozen spec and passed to commands that accept them.
For Flutter form preparation, `input-flutter-text` / `ios-input-flutter-text`
can use `{selector:{label:"Account",role:"input"},text:"example",focus:false}`
after observing that editor. This runs its formatters and `onChanged` without
tapping, taking focus or opening the keyboard. Use the default tapped input when
testing keyboard, tap or focus behavior; `hideKeyboard:true` requests dismissal
after that input. The same optional fields are accepted by Flutter Intent
`inputText` actions. Both modes retain live target validation.
Installation and permission workflows can be started with `ctx.call('install-apk', ...)`
and `ctx.call('permission-dialog', ...)`; their returned Intent operationId supports
the same status/observe/decide/cancel operations inside the Script.
All supported catalog permission categories are enabled by default, including
`app.lifecycle`, `app.permissions`, `app.expert`, `app.workflow` and `evidence.read`. An explicit `permissions` list
restricts Bridge calls. `adb-exec` accepts argv for device or Host ADB commands;
every registered command has a Script entry. Source is trusted local code. Targets and permissions participate in the recovery hash.

`ctx.call('script', {operation:'start', script:...})` and `ctx.call('intent',
{operation:'start', goal:...})` inherit the owning target when the child omits it.
Explicit `script.target:null` selects Host-only execution. Retain the child ID
from `reply.result.operationId`; use Script wait/result or Intent wait/decide
to continue. Child operations own their lifetime: stopping a parent does not
silently stop a child. Composed Intent start defaults to `background:true`, so a
slow observation or autonomous loop does not hold the parent call open. Set
`background:false` to await its initial loop. Parent permissions restrict its
SDK calls; a child Script has its own explicit/default permissions.

Control calls preserve the child's whole response under `result`, including
status and resultRef. Runtime stop/force-stop run in a separate controller and
return `controlAccepted`, `completionScope:'control-request'` and `resultPath`.
Read that file or query status from another call to confirm completion. Self
cancel requests drain after the initiating call returns; a self wait returns
current status immediately instead of waiting on itself.

An iOS target requires `platform: "ios"` and `deviceId`; App commands also need `bundleId`. SDK transports
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
Raw `ios-flutter-action` and `ios-h5-eval` are also available through `ctx.call`;
explicit permission lists can restrict them. Use `ios-flutter-nodes` for fresh observations and device
assertions, and `ios-logs/network/state/events` for mobile evidence.

Web uses `platform: "web"`, `sessionId`, `runtimeEpoch` and optional
`targetId: "main"`. `app.read` admits `web-status`, `web-dom` and `web-wait`;
`app.interact` admits `web-click`, `web-input`, `web-key` and `web-scroll`.
The existing serving Web provider owns the connected session and mutation lease.
Raw `web-command` is available through `ctx.call` under `app.expert`, enabled by
default; an explicit permissions list can restrict it.

Read `web-dom`, choose exactly one observed control, and send its `elementId`
with `expectedTarget: { pageRef, element: observedControl }`. Pass the complete
observed control directly; extra observation metadata is accepted on both
`element` and `pageRef`. Element identity still requires
`elementId`, `tag`, `id`, `name`, `type`, `role`, `ariaLabel`, `placeholder`,
`href` and `text` from that observation. `interaction.status` explains whether
the control is ready, disabled, hidden, outside the viewport or obscured.
Reobserve when the next step needs new state, a replaced control's identity, or
an asynchronous completion condition. Known controls on the current page can
be handled consecutively. A completed input or click is not evidence that an
asynchronous business operation finished.

Web DOM reads issue Host tree observations usable by `ctx.assert` with
`requiredEvidence: ["tree"]`. `web-logs/network/state/events` read committed
Host FactStore records under `capture.read`; their evidence is available to
Script capture assertions and Intent `require.streams`. Before an action, retain
`evidence.capture.watermarkCursor`, then pass it as `factCursor` to the post-action
read. `afterActionId` additionally filters associated records using the original
action ID. Capture barriers bound the window; incomplete capture remains partial,
and temporal proximity alone does not establish action causality. See the
[Web capture contract](COMMAND_CONTRACT.md#web-dom-intent-and-script) for coverage and
pagination. The Memos validation source and independent SQLite oracle are in
`examples/memos-sample/validation`.

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

Use `Promise.all` for independent JavaScript reads. Reads submitted together
run concurrently; a write waits for preceding reads, and subsequent reads wait
for that write. Assertions, checkpoints and agent questions also wait for prior
reads, preserving their evidence and persistence boundaries. Await a result
before submitting a call that depends on it. The SDK keeps 32 requests in flight
and queues larger bursts; reaching that window does not fail the Script. Progress
is acknowledged through the same channel. Returning from `main` drains already
requested SDK calls before reporting completion; explicitly cancel to stop work.

Python calls remain synchronous, but ordinary calls use one request/reply with
control state attached. The Host holds dispatch while paused; `controlPoint()`
is an explicit query for scripts doing long local computation. Neither language
needs a separate before/after control query for every ordinary command.

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
on the phone and can outlive the Host timeout. Unknown ownership is preserved in
an archive; an explicit new action may continue after the actual owner releases
the device, with the previous unknown outcome reported as a warning.
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

Python uses `ctx.assert_({...})` with one dictionary argument; `assert` is a
Python keyword. JavaScript uses `ctx.assert({...})`. Both return a verdict that
the script must check. A `status` response alone supplies no UI tree evidence,
and `capture_page_limit` means that capture is incomplete. Drain the documented
capture cursor before making a completeness assertion; do not relabel a partial
capture as passed.

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

A successful tree read can have partial or unreported coverage. Script keeps
that distinction in `evidence.coverage`; it does not turn a truncated result
into complete evidence. Full Flutter layout coverage includes every requested
source, so an available operable tree does not hide a failed diagnostic source.
Use `flutter-nodes` when the decision only needs operable controls.

For a predicate about the values actually returned, explicitly choose
`coverageScope: 'observed'`. For example, a WDA tree can prove that the returned
input field has the expected value even when WDA does not report whole-tree
coverage. This mode returns its `coverageScope` and the unchanged source
`coverage`; it does not prove that omitted controls or records are absent.
The default remains `coverageScope: 'complete'`. Observed checks still require
Host-issued, unedited, committed evidence with the requested references in the
current action window. Failed reads, stale evidence and missing references
remain inconclusive. Both JavaScript and Python accept the same option.

Compact `uia-tree` reads show visible nodes by default. Hidden and offscreen
nodes are filtered before `maxNodes`, so retained background pages cannot fill
the budget ahead of current controls. Use `visibleOnly: false` with `compact:
true` to inspect hidden nodes, or omit compaction and filters to read raw XML.
The response reports the applied filter and any remaining truncation. A visible
control in a partial tree remains available for explicit selection; the read
does not automatically retry or stop a Script.

`ctx.assert({scope:'code', name, condition})` records a local code check. It
cannot accept device evidence and is counted separately. Keep independent
database, file or network business oracles in the report when applicable.

## Flutter snapshot freshness and coordinate actions

`flutter-nodes` requests a fresh operable capture from the current SDK. Older
SDKs can return a previously published snapshot. Two equal responses from one
snapshot do not demonstrate that a route animation or scroll has settled. Keep the
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
is available through `ctx.call`, subject to any explicit permission list. See [the command contract](COMMAND_CONTRACT.md)
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
// Reuse a recent status observation of this target when already available.
const status = await ctx.call('status');
const deviceNow = status.result?.updatedAtMs;
if (!status.ok || !Number.isFinite(deviceNow)) {
  throw new Error('device capture time unavailable');
}
const before = await ctx.call('events', { sinceMs: deviceNow - 1000, limit: 200 });
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

`sinceMs` uses the device's wall clock. A Host `Date.now()` value can be ahead
of that clock and exclude records from the intended window. Reuse a recent
device status for the initial time bound; subsequent reads use the opaque
capture cursor. Clock offset is diagnostic information, not an action gate.

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

## Web steps and local waiting

`web-session-start` starts the connection service. A browser must already load
the Web SDK and connect before a Web Script can use it; the command does not
open, inject or reload an arbitrary page. Reuse the application's integration
or the supplied browser harness for that setup.

The [Web first-use example](#web-first-use) shares observation, binding and local
waits through an ordinary editable module. Use a predicate that checks competing
success/error states when the App may reject a submitted form. Return or inspect
the rejection before choosing another action. `web-wait {targetText,timeoutMs}` is shorter
when text/selector presence alone is the condition; use ordinary code for
disappearance, competing success/error states, or another predicate. Likewise,
an initially empty page can be polled locally until relevant controls appear.

An unlabelled Web control can include `context.ancestors`: bounded text samples
from its actual DOM ancestors. These can distinguish two record menus without
another screenshot. Inspect the samples and their truncation flags, then use the
chosen control's observed `elementId`; context is not an action selector or
binding. Controls remain a flat list, and ancestor text can cover multiple records.
If the association is still unclear, filter to the intended record or inspect
current visual evidence.
Keep full call/observation receipts in `recordingDir` when required, and return
the checks/results needed by the caller. Completed work should `return` directly
instead of asking for an empty final confirmation.

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

Intent wait uses `afterEventSequence: previous.eventSequence`, not the history cursor. It waits on Host events and does not capture another UI tree. Use it after background start or during managed installation instead of polling status in a tight loop.
