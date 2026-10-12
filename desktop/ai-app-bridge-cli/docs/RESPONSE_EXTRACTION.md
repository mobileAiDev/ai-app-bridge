# Response discovery and extraction

Omitting `extract` uses `auto`. A result within the output budget (96 KiB by
default) is delivered completely, with no mandatory discovery/read round trip.
JSON above 32 KiB can use a complete table representation when removing repeated
field names and shared values saves at least 30%; this formatting threshold never
discards content. Over-budget JSON tries the same complete representation even
for a smaller saving. Only results that still do not fit become partial views
with complete records or text ranges, a structural index, and a saved source ref.

Explicit `extract:null` requests the original result within the body budget.
`extract` and `output` are top-level fields, separate from business `arguments`.
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

## Complete data first; read more only when needed

`delivery.status:inline` preserves the original shape. `compact` uses
`format:aab.response-tables/v1`, `partial:false`, `data` and `tables`. Each table has
a JSON Pointer `path`, shared `constants`, JSON Pointer `columns`, and `rows` of
corresponding cells. Replace the null at `data[path]` with those rows as objects:
apply each constant leaf path and then each column's cell. Empty values, all node
states, original ordering, duplicate labels and action bindings are preserved.
This is a complete representation of the captured result; the original capture
coverage/truncation flags still apply. A different object shape is kept verbatim.

For example, constants `{"/enabled":true}` plus columns `["/text","/checked"]`
and rows `[["同意",false],["同意",true]]` describe two distinct objects with all
three fields. No row is deduplicated. The saved ref and `read` are optional
conveniences for selecting an original row; interpreting this table needs no call.

`aab.response-tables/v2` additionally shares identical long diagnostic texts,
which are often repeated inside nested Script/Intent results. First replace the
null placeholders at each `sharedTexts[].paths` with that entry's `text`. These
JSON Pointers address the entire compact representation, under `/data` or
`/tables`. Then expand tables as in v1. `tables` can be empty. This is still
`partial:false`: every original value is recoverable from this reply alone.
Saved response refs, select paths and extraction always address the original
shape, independent of this delivery representation.

`delivery.status:overview` uses `format:aab.response-overview/v1`, `originalBytes`,
`fields` (JSON Pointers, types, counts and small scalar facts), `partial:true`, and
`preview`. The preview identifies its source path and returns bounded head/tail
ranges with exact source offsets. Array entries are complete; text prefers whole
lines and never splits Unicode surrogate pairs. A single oversized record can
preview its large text field while exposing sibling scalar facts in the index.
The preview spends up to 64 KiB of the remaining body budget on actual data.
It does not silently assert that omitted data is absent.

The `read` request selects the next retained range, sized from the saved data.
`control.source.ref` identifies that frozen response. Execution, warnings,
continuation controls and capture coverage remain outside the view.

Copy `value.read` and adjust its extraction, for example:

```json
{"mode":"select","path":"/items","offset":20,"limit":10}
```

`select` accepts a JSON Pointer without starting a script process. `offset` and
`limit` slice arrays or strings; omit them for objects and scalars. Empty path
selects the root; `/a~1b` selects a property named `a/b`. These reads consume the
saved response, never rerun the device command. Use `null` with a larger output
budget to retrieve the full retained value, or regex/JS/Python for a precise query.

If storage fails, a complete table view can still be delivered without a `read`
hint. An over-budget result that needs a partial view reports unavailable
delivery when its source cannot be saved. No nonexistent ref is advertised.
Retention/8 MiB source limits still apply; explicit `outFile` is available for
large binary ADB output. These views are deterministic and do not infer business
relevance or reduce device collection time.

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

Explicit select/regex/script extraction and large auto responses attempt to retain the original response. A null response
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
## Candidate continuation

Host selection failures retain all observed candidates in the original response.
`control.candidates` (or an Intent's `control.lastAction.candidates`) is a preview
of at most 20 records and 8 KiB, so protected control fields do not duplicate a
large candidate array. `candidatePage` reports its path, offset, count, available
records and whether the provider itself truncated the source. When the response
was saved, `candidatePage.read` selects the next byte-bounded range from the same
response; it does not repeat the original action. An inline full value already
contains the complete list and needs no further read. `sourceTruncated:true`
means omitted candidates were never received: follow a provider observation hint
such as Web's filtered DOM query instead of expecting response extraction to
recover them.
