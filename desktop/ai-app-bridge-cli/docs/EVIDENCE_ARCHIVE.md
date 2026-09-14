# Record, export and verify execution evidence

Discover the public MCP command with `capabilities {"command":"evidence"}`.
It works for both Intent operation IDs and Script execution IDs, including
records retained after the execution runtime has restarted. CLI and MCP use the
same operation IDs and export command. Export does not require a
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
execution runtime's configured FactStore (`AI_APP_BRIDGE_FACT_STORE_DIR`), drains its
queued writes, and freezes the retained records for exactly that namespace
and operation. The parent directory must exist; the output directory must
not exist. No existing directory is replaced.

The response includes `archiveDir`, `manifestPath`, `manifestSha256`,
`recordCount`, `targets`, and `coverage`. Save the returned manifest SHA256
separately when handing the archive to an author or reviewer.

Without `includeRecordedPayloads`, the directory contains two files:

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

Verification opens only the archive's ordinary files. It does not open a
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
`observed` retains each observation's declared device/App identity, and `foreground`
retains explicit Intent route data. Script marker targets use `dispatch`
and can contain explicit target overrides, including another serial when
the Script supplies it. These roles preserve the current execution contract;
the archive does not apply a new device allowlist or infer an absent target.

New execution envelopes declare `schemaVersion: "aab.execution-evidence/v1"`.
Their targets use an explicit platform discriminator; observations carry both
`target` and `observedTarget` when the latter was actually observed. A pure
Script call can have a null target. Archive verification also understands the
original unversioned record format already frozen in archive v1/v2. It checks
those original fields and hashes without adding a platform or rewriting bytes.
New execution writes do not accept an old observation in place of a platform target.

Currently persisted Intent content includes observations with raw trees,
summaries, decisions, dispatch markers, and action receipts. Script content
includes durable checkpoints, dispatch markers, and action receipts.
Completed Scripts also persist their final JSON as a `result` record, with a
terminal checkpoint `resultRef` binding its evidence ID, canonical byte count,
persisted SHA256, original SHA256 and `original-json`/`redacted-json`
representation. Export includes this retained record without requiring
`includeRecordedPayloads`; it is independent of progress-event retention.
Verification checks the checkpoint's binding to that result. An evicted result
leaves partial reference closure rather than a reconstructed value. For a direct
checked read, use `script {operation:"result",operationId:"…"}`.

Without recorded payload inclusion, `externalPayloads` is `not-included`. External screenshot files, phone
logs/network capture items, individual Script call results/assertions, and in-memory
events are outside this archive. Existing external references are listed
but not downloaded or dereferenced. Preserve those artifacts separately
when the intended check requires them.

`executionStatus` is `not-inferred` and `businessVerdict` is `not-evaluated`.
The caller can inspect recorded terminal decisions/checkpoints, including a
persisted cancellation. Export verification does not infer missing lifecycle
state or reconstruct evicted records.
Archive integrity alone does not establish a passed business assertion.

## Explicit recording for one execution

Add `recordingDir: "/absolute/output/recording"` to the
**arguments of `script start` or `intent start`**, alongside `script` or
`goal`/`target`. Missing parents are created; the directory may be new or empty.
The Host claims it before admitting work. Nonempty directories are rejected to
preserve existing evidence, with `field:"recordingDir"` and no admitted operation ID.
This is opt-in file output for this execution; ordinary live calls do not
copy mobile payloads to a Host history database.

Script records each returned Host call envelope (command, arguments, actual
result, call/action/observation IDs, source hash, window, coverage, refs and
capture metadata), plus each assertion input and Host verdict. The Host
copies referenced screenshot PNG bytes immediately, checking the issued
SHA256 before an original path can be reused. It awaits the attachment's
FactStore receipt before replying to the child. This does not depend on the
child writing files or on retaining the bounded event log.

Intent records the complete capture pages already fetched by its `require`
streams, including items. Each attachment references its persisted raw-tree
observation. Recording itself does not query extra streams or take Intent
screenshots. With no `require` streams, Intent has no mobile payload to record.

The existing Host FactStore stores small `attachment` records containing
file hashes and execution bindings; the payload files remain in the explicit
output directory. The live mobile query path never consults those files.
Script recording currently requires `restartPolicy: "none"`; a checkpoint
restart request with recording is rejected as `recording_restart_unsupported`.
Live pause/resume can continue the same recording. No recording is silently
reopened after Host or child loss.

Limits are 10,000 attachments, 16 MiB per JSON/PNG file and 256 MiB per
recording. A write, checksum or persistence failure stops further successful
recording: Script receives an explicit error and blocks further calls;
Intent stops exposing the new observation. Previously committed material
can still be exported. Unreferenced files left by a failed write are not
included. Existing output directories are never replaced or cleaned up.

JSON uses the existing FactStore credential redaction. `representation`
distinguishes `original-json` from `redacted-json`. Original and archived
data hashes are stored separately; a redacted payload is never presented as
the original `source.payloadSha256` bytes. PNGs retain their original bytes.

## Include recorded files in the portable archive

Use the same public export call with `includeRecordedPayloads: true`:

```json
{
  "command": "evidence",
  "arguments": {
    "operation": "export",
    "namespace": "script",
    "operationId": "script-from-your-response",
    "outputDir": "/absolute/existing-parent/new-archive",
    "includeRecordedPayloads": true
  }
}
```

This produces `aab.evidence-archive/v2`: records, manifest and flat
`payload-<sha256>.json/png` files. All retained attachment references must
resolve with the expected size/hash. Export never re-fetches mobile facts
or substitutes another screenshot. Keep the recording directory in place
until export; after export, move the archive as a unit and use the same
`verify` operation and separately saved manifest hash. Offline verification
never opens the old recording directory or screenshot paths.

`recordedPayloads` reports included calls, Host assertion verdict counts,
screenshots, mobile pages/items and checked item/ref associations. Item IDs,
timestamps, stream, target and explicitly filtered epoch must agree. A
connected-history page's current epoch is not substituted for an older
fact's own epoch. Coverage, query window, pagination and store generation
remain the values returned by the source. Uncommitted items remain visible
without being counted as bound mobile facts.

This remains an archive of **retained recorded payloads**, not proof of a
complete run. Unqueried facts, calls made without recording, evicted
attachment references, in-memory progress and late/in-flight calls outside
the export watermark are not reconstructed. Assertion verdicts are retained
Host judgments of the supplied condition/evidence, not an independent
recalculation of business expectations. Integrity verification does not
turn a failed or inconclusive assertion into a pass.
