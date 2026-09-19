# Response extraction (0.4.0)

Every CLI/MCP run must state what to return. Use `extract:null` for the original
result within the body budget, or select the fields needed for the current task.
`extract` and `output` are top-level request fields, separate from business
`arguments`. The old request without extract is rejected before dispatch.
Internal Script `ctx.call(command, args)` stays unchanged (`ok`, `result`).

```json extraction-example
{"command":"runtime","arguments":{"operation":"status"},"extract":null}
```

```bash
ai-app-bridge runtime --operation status --extract null
```

A small response can be read in full. Large trees, network records and logs are
better extracted near the Host. This saves response/context bytes, not the
original collection time. Capture duration, history limit and extraction solve
different problems; a one-item page can still exceed the byte budget.

## One query, one extraction

Regex requires a string at `inputPath` (JSON Pointer). Empty path selects a text
response; escape `/` as `~1` and `~` as `~0`. Flags are unique `i`, `m`, `s`, `u`;
all matches are returned with `match`, `groups` and `namedGroups`.
Unmatched captures are null. At most 1,000 matches are allowed; overflow fails.

```json extraction-example
{"command":"runtime","arguments":{"operation":"status"},"extract":{"mode":"regex","pattern":"stopped|running","inputPath":"/status"}}
```

For structured responses, both languages receive exactly
`ctx.inputs = {kind, response, execution, control}`. `response` is the original
command value, including its final feedback. This is a short local transform;
it has no Script `ctx.call`, agent decisions or assertion API.

```json extraction-example
{"command":"runtime","arguments":{"operation":"status"},"extract":{"mode":"script","language":"javascript","source":"module.exports.main = ctx => ({status:ctx.inputs.response.status, commandOk:ctx.inputs.execution.ok});"}}
```

```json extraction-example
{"command":"runtime","arguments":{"operation":"status"},"extract":{"mode":"script","language":"python","source":"def main(ctx):\n    return {\"status\": ctx.inputs[\"response\"][\"status\"], \"commandOk\": ctx.inputs[\"execution\"][\"ok\"]}\n"}}
```

Use exactly one of `source` and `sourcePath` for scripts. Relative paths resolve
from the caller directory; the Host freezes the file before executing the
command. Syntax checks do not execute top-level code. Source is at most 64 KiB
UTF-8. Python requires Python 3.9+; ordinary, JS and regex calls need no Python.

Return strict JSON: null, booleans, strings, finite numbers, arrays and objects.
Integers outside ±9,007,199,254,740,991 are rejected, including Python values
before serialization. Convert intentionally to a string inside your source.
Unsupported types, cycles and sparse JS arrays fail rather than being coerced.

## Read the three outcomes separately

The shared compact body is
`{command, execution, control, extraction, delivery, kind, value?, failureStage?}`.
`execution` records the original command outcome and dispatch facts. Successful
extraction cannot convert a failed or unknown command into success. `control`
preserves operation IDs, receipts, Intent revisions, Script event cursors and
current pending questions, and capture coverage/pagination. Histories remain in
value; only their page controls are protected separately.

`extraction.status` is skipped, succeeded or failed. `delivery` reports actual
UTF-8 body bytes and the limit. `failureStage` gives the first failing stage in
validation → execution → extraction → delivery order. CLI exit codes are 0 for
requested delivery, 1 for validation/failed or unknown execution, and 2 when a
known successful command could not be extracted/delivered. MCP uses `isError`
consistently. A successful Script execution is separate from its business verdict.

A temporary-directory removal failure after the worker exits is reported as
`extraction.cleanupError`. It does not replace a successful value or the original
extraction error, change the exit code, or replay the command.

Preserve source identity, timestamps, state and coverage needed by the actual
assertion. A selected successful row does not prove complete business coverage.

## Retry extraction without repeating the action

Non-null extraction attempts to retain the original response. A null response
that would exceed the budget also attempts retention. `control.source` is the
only ref location. Only `persisted:true` makes that ref readable. Null within
budget normally reports `persisted:false, reason:not_requested`; offline local
commands report `offline`. Saving and extraction may fail independently.

On extraction failure or overflow, copy the original ref and change only the
extraction in a `response read`. The current read execution is separate from
original facts in `control.origin`; `control.source` still identifies the same
snapshot. Repeated reads neither replay devices nor create nested snapshots.

```json
{
  "command": "response",
  "arguments": {"operation":"read","ref":{"namespace":"response","evidenceId":"<original evidenceId>","checksum":"<original checksum>","operationId":"<original operationId>"}},
  "extract": {"mode":"script","language":"javascript","source":"module.exports.main = ctx => ctx.inputs.response;"},
  "output": {"maxBytes":262144}
}
```

A ref is subject to existing evidence retention. Missing/evicted/corrupt sources
fail explicitly. Reissuing the original action with the same requestId is not a
substitute for ref recovery: deduplication can expire and does not survive every
Host lifetime. Snapshot/export JSON preserves original values; binary responses
are base64 for null delivery and are not extractable in this version.

## Limits and diagnosis

| Limit | Value |
| --- | --- |
| Final compact UTF-8 body | 96 KiB default; output.maxBytes 16–256 KiB |
| Source snapshot / extraction input | 8 MiB original UTF-8 JSON |
| Returned extraction value | 256 KiB (the enclosing body still has its budget) |
| Extraction timeout | 2,000 ms default; timeoutMs 1–10,000; includes worker startup/input |
| Active extractions | 2; no queue; busy still preserves the original action result/ref |
| Failed worker diagnostics | Most recent 8 KiB stderr; stack at most 20 frames and 8 KiB |

No budget error returns a truncated JSON document or dumps the large original
value. If the protected controls themselves cannot fit, `controlComplete:false`
and `control_over_budget` prohibit continuing from incomplete controls. Use a
real ref when available, with a sufficient budget or a narrower command query.
Discovery/help has a separate fixed 96 KiB limit; follow its command/operation
hint. Runtime stop drains active extraction workers; CLI/MCP disconnect alone
keeps the shared Runtime alive. Extraction is trusted local code, with bounded
worker/channel lifetime rather than an OS/process-tree sandbox.
