# Export and verify retained Host evidence

Discover the public MCP command with `capabilities {"command":"evidence"}`.
It works for both Intent operation IDs and Script execution IDs, including
records retained after the MCP process has restarted. It does not require a
connected phone or a live worker.

```json
{
  "command": "evidence",
  "arguments": {
    "operation": "export",
    "namespace": "intent",
    "operationId": "intent-from-your-response",
    "outputDir": "/absolute/existing-parent/new-archive"
  }
}
```

Use `namespace: "script"` for a Script operation. Export reads the current
MCP Host's configured FactStore (`AI_APP_BRIDGE_FACT_STORE_DIR`), drains its
queued writes, and freezes the retained records for exactly that namespace
and operation. The parent directory must exist; the output directory must
not exist. No existing directory is replaced.

The response includes `archiveDir`, `manifestPath`, `manifestSha256`,
`recordCount`, `targets`, and `coverage`. Save the returned manifest SHA256
separately when handing the archive to an author or reviewer.

The directory contains two files:

- `records.json`: the original ordered Facts, including their globalSeq,
  outer source binding, full evidence envelopes, raw trees where stored,
  checksums, and original device/app identities.
- `manifest.json`: schema `aab.evidence-archive/v1`, namespace/operation,
  source store ID and sequence watermark, partition retention metadata,
  file size/SHA256, record counts, target inventory, and coverage.

The sequence can have gaps because unrelated operations share the store.
An expired cursor, unreadable page, checksum error, mismatched binding, or
snapshot change fails export. An unknown operation returns
`operation_not_found`. Limits are 10,000 records and 128 MiB of record JSON;
the manifest is limited to 2 MiB. Exceeding a limit fails rather than
truncating. The manifest is written last; a directory left by an interrupted
write is not a successfully verified archive.

## Verify without the source store or phone

Move or copy the directory as a unit, then call:

```json
{
  "command": "evidence",
  "arguments": {
    "operation": "verify",
    "archiveDir": "/absolute/moved-archive",
    "manifestSha256": "<the 64 lowercase hex characters saved from export>"
  }
}
```

Verification opens only these two ordinary files. It does not open a
FactStore, initialize an operation, or contact a phone. It verifies the
externally supplied manifest hash, records hash/size, each evidence checksum,
namespace/operation/source binding, IDs, sequence, internal reference order
and binding, and recalculated coverage and target inventory. Archive files cannot be symlinks, and the manifest
cannot redirect the verifier to another file. A missing or changed file
fails verification. Source paths embedded in evidence are data and are never
opened or executed.

Success returns `ok: true` and `integrity: "verified"`. The hash establishes
that the supplied archive matches the frozen export; it is not a signature
authenticating the producer. Obtain the expected hash from the export
response, not by hashing an untrusted archive and treating that as approval.

## What this archive establishes

`coverage.scope` is `retained-host-records`. `priorHistoryComplete` remains
`unknown`: a store can already have evicted older records before export.
Partition retention metadata describes the entire partition, not proof that
this particular operation lost records.

`referenceClosure` is `complete` when the included records' checked internal
references are present, or `partial` with `missingReferences`. This is
separate from whole-history completeness. Exporting a partial retained set
can succeed as a diagnostic archive; it does not fill its missing evidence.
Contradictory references fail: a reference to a future record, a summary with
a different observation revision, a receipt preceding its dispatch marker,
or duplicate observation/decision/action identities cannot become a complete
reference set merely because the IDs exist.

The archive preserves already persisted, sanitized values byte-for-value as
JSON values. It does not change recorded serials or infer missing targets
from the currently connected phone. `owner` retains the declared context,
`observed` retains each observation's serial/package, and `foreground`
retains explicit Intent route data. Script marker targets use `dispatch`
and can contain explicit target overrides, including another serial when
the Script supplies it. These roles preserve the current execution contract;
the archive does not apply a new device allowlist or infer an absent target.

Currently persisted Intent content includes observations with raw trees,
summaries, decisions, dispatch markers, and action receipts. Script content
includes durable checkpoints, dispatch markers, and action receipts.

`externalPayloads` is `not-included`. External screenshot files, phone
logs/network capture items, Script call results/assertions, and in-memory
events are outside this archive. Existing external references are listed
but not downloaded or dereferenced. Preserve those artifacts separately
when the intended check requires them.

`executionStatus` is `not-inferred` and `businessVerdict` is `not-evaluated`.
The caller can inspect recorded decisions/checkpoints, but Intent cancellation
and other in-memory state cannot be recovered from a successful export.
Archive integrity alone does not establish a passed business assertion.
