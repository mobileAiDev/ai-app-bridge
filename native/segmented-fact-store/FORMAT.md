# Segmented Fact Store binary format v1

This document is the cross-language contract for the C11 reference
implementation, the Kotlin `FileChannel.map` implementation, and any future
Swift or Node adapter. All integers on disk are unsigned little-endian values.
No implementation may write a native C struct directly to disk.

## Store layout

```text
<store>/
  .sfs-lock
  .sfs-manifest
  partition-0/
    segment-00000000000000000001.sfs
  ...
  partition-7/
```

- Partition IDs are fixed to `0..7` (`SFS_MAX_PARTITIONS = 8`).
- Their semantic mapping is also fixed across Host, Android, iOS, and Flutter:

  | ID | Partition |
  | ---: | --- |
  | 0 | `network` |
  | 1 | `ui` |
  | 2 | `app-log` |
  | 3 | `device-log` |
  | 4 | `state-event` |
  | 5 | `action` |
  | 6 | `note` |
  | 7 | `index` |

- A zero manifest quota disables that partition.
- `.sfs-lock` has no binary-format contract. The C implementation takes an
  exclusive advisory non-blocking `flock` writer lock on it. Separate opens in
  the same process therefore conflict as well as opens in other processes.
- `.sfs-manifest` is exactly 4096 bytes.
- Segment names contain a zero-padded, 20-decimal-digit partition-local segment
  ID. Segment IDs start at 1 and never get reused.
- Each enabled partition is one independently rotated segment family. Its hard
  quota includes the full allocated size of its segment files. The manifest,
  lock file, and filesystem metadata are outside that quota.

## CRC32C

All CRC fields use CRC32C Castagnoli with the reflected polynomial
`0x82F63B78`, initial value `0xFFFFFFFF`, and final XOR `0xFFFFFFFF`.

The required check vector is:

```text
CRC32C("123456789") = 0xE3069283
```

## Manifest

The manifest contains two 512-byte slots at file offsets 0 and 512. Bytes
1024..4095 are reserved and zero in v1. A reader validates both slots and uses
the valid slot with the greatest generation. A slot is valid only when its
magic, version, size, CRC, and commit marker are valid.

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | ASCII `SFSMAN01` |
| 8 | 4 | format version, `1` |
| 12 | 4 | slot size, `512` |
| 16 | 8 | monotonically increasing manifest generation |
| 24 | 8 | next store-local global sequence |
| 32 | 8 | segment size shared by every partition |
| 40 | 4 | partition count, `8` |
| 44 | 4 | reserved, zero |
| 48 | 384 | eight 48-byte partition entries |
| 432 | 4 | CRC32C of bytes `[0, 432)` |
| 436 | 68 | reserved, zero |
| 504 | 8 | commit marker `0x314D4F434D534653` |

Each partition entry contains six `u64` fields:

| Relative offset | Field |
| ---: | --- |
| 0 | hard quota in bytes; zero means disabled |
| 8 | next partition-local segment ID |
| 16 | first retained partition-local segment ID |
| 24 | cumulative evicted segment count |
| 32 | cumulative evicted record count |
| 40 | cumulative evicted payload bytes |

The manifest commit marker's little-endian bytes spell `SFSMCOM1`. Writers
prepare the inactive slot with a zero marker, persist its body and CRC, then
write and persist the marker last. A torn update therefore leaves the previous
slot usable.

## Segment header

Every segment is preallocated to the manifest's fixed segment size. Its first
64 bytes are:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | ASCII `SFSSEG01` |
| 8 | 4 | format version, `1` |
| 12 | 4 | header size, `64` |
| 16 | 8 | partition-local segment ID |
| 24 | 8 | fixed segment size |
| 32 | 4 | partition ID |
| 36 | 4 | reserved, zero |
| 40 | 8 | global-sequence hint at segment creation |
| 48 | 4 | CRC32C of bytes `[0, 48)` |
| 52 | 12 | reserved, zero |

The sequence hint is diagnostic, not authoritative. If the first attempted
frame is torn, recovery may later place a higher sequence in the same segment.
Frame sequence values are authoritative.

The C reference creates and durably initializes a hidden
`.segment-%020llu.creating` file, then atomically renames it to the committed
segment name and syncs the partition directory. Interrupted `.creating` files
are uncommitted and are removed under the writer lock during the next open.
Readers must ignore them.

## Record frame

Frames start at offset 64 and are contiguous. Every frame start and every next
frame start is 8-byte aligned.

| Relative offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | total frame length |
| 4 | 4 | payload length |
| 8 | 8 | store-local global sequence |
| 16 | 4 | CRC32C of the exact payload bytes |
| 20 | 4 | CRC32C of frame bytes `[0, 20)` |
| 24 | N | opaque payload bytes |
| `24 + N` | 0..7 | zero alignment padding |
| `totalLength - 8` | 8 | commit marker `0x314D4F4346534653` |

```text
totalLength = align8(24 + payloadLength) + 8
```

The frame commit marker's little-endian bytes spell `SFSFCOM1`. Writers zero
the destination range, write the prefix, payload, and padding, execute a release
fence, and write this marker last. The marker is never included in either CRC.

## Large logical fact envelope v1

The native record payload remains opaque. Host, Android, and iOS adapters use
the following additional envelope when one canonical fact JSON payload does
not fit in a single native frame. This envelope is fixed independently of the
native store format so every platform can read facts written by the others.

The writer splits the exact canonical JSON UTF-8 bytes without base64 encoding.
Each physical chunk payload starts with this 72-byte little-endian header:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | ASCII `AIBCHN01` |
| 8 | 4 | envelope version, `1` |
| 12 | 4 | chunk header size, `72` |
| 16 | 32 | SHA-256 of the complete canonical fact JSON bytes |
| 48 | 4 | zero-based chunk ordinal |
| 52 | 4 | total chunk count |
| 56 | 8 | complete fact byte length |
| 64 | 4 | bytes in this chunk after the header |
| 68 | 4 | reserved, zero |
| 72 | N | unencoded slice of the canonical fact JSON bytes |

For the current native frame layout, the maximum slice length is
`segmentSize - 96 - 72`: 96 bytes are the native segment/frame/commit
overhead and 72 bytes are this envelope header.

After every chunk frame has committed, the writer appends one final JSON UTF-8
manifest frame in the same partition. The manifest has this semantic shape;
JSON object member order is not significant:

```json
{
  "__aiAppBridgeInternal": "ai-app-bridge.large-fact-manifest.v1",
  "index": {
    "partition": "ui",
    "targetKey": "android:device:package",
    "runtimeEpoch": "runtime",
    "actionId": null,
    "dedupeKey": null,
    "timestamps": {
      "occurredAtMs": 1,
      "observedAtMs": 2,
      "ingestedAtMs": 3
    }
  },
  "content": {
    "encoding": "json-utf8",
    "byteLength": 123,
    "sha256": "64-lowercase-hex-characters",
    "chunks": [
      {
        "ordinal": 0,
        "sequence": 10,
        "segmentId": 2,
        "frameOffset": 64,
        "payloadLength": 195,
        "byteLength": 123
      }
    ]
  }
}
```

Only the manifest is a logical fact. Its physical global sequence remains the
public `globalSeq` and therefore the input to the unchanged `factId`. SQLite or
another rebuildable query projection indexes only that manifest; physical
chunks never appear in pagination, counts, deduplication, or mmap-scan query
results. `payloadLength` in the logical projection is the complete canonical
fact byte length, while each manifest chunk location's `payloadLength` is its
physical 72-byte-header-plus-slice length.

A reader must require ordinals `0..chunkCount-1`, strictly increasing chunk
sequences below the manifest sequence, exact recorded locations and lengths,
matching per-chunk header metadata, the declared complete length, and the
complete SHA-256. A missing, evicted, reordered, truncated, or corrupt chunk
invalidates the whole logical fact; returning a prefix or any other partial
fact is forbidden. Chunks without a later valid manifest are uncommitted
orphans and are skipped during query-projection rebuild and mmap fallback.

The cross-platform golden vector is
`tests/golden/large-fact-v1.json`. It fixes the header offsets, UTF-8 payload,
SHA-256, complete header bytes, and manifest fields used by adapter tests.

## Durability and recovery

`SFS_DURABILITY_MEMORY` makes a frame visible through the current handle but
does not promise crash durability. `SFS_DURABILITY_SYNC` and `sfs_flush` use a
two-phase flush for every not-yet-durable frame range:

1. clear its commit marker(s);
2. synchronously `msync` the mapped segment body;
3. restore commit marker(s) last;
4. synchronously `msync`, then `fsync` the segment;
5. commit the next manifest slot.

On open, readers validate committed frames in order. A valid commit marker with
a bad header CRC, payload CRC, sequence, or non-zero padding is corruption and
open fails with `SFS_ERR_CORRUPT`. A partial prefix, incomplete frame, or missing
commit marker at the active segment's tail is recoverable: the implementation
keeps the last complete frame, extends a truncated active file back to the fixed
segment size, zeros the discarded tail, and durably persists that repair. The
same torn state in an older sealed segment is corruption. When a final valid
frame leaves fewer than the 24 bytes needed for another frame prefix, an all-zero
remainder is a clean end-of-segment tail, not a torn prefix; any non-zero byte in
that short remainder is still a torn state.

The manifest's next global sequence is never moved backwards. Open also scans
all retained records and raises the in-memory next sequence above the greatest
committed sequence. This prevents sequence reuse after a recovered append; a
crash or quota eviction may create a visible sequence gap.

## Rotation, retention, and gaps

When a frame does not fit in the active segment, the writer durably flushes and
seals that segment, then rotates to the next partition-local segment ID. Before
allocating a segment that would exceed the partition quota, it durably commits a
manifest retention decision and then unlinks the oldest retained segment. This
ordering makes an interrupted eviction recoverable on the next open.

A global scan (`cursor.partition_id = SFS_PARTITION_ALL`) merges the eight
families by global sequence. When its next retained record is later than
`cursor.after_sequence + 1`, the record carries `SFS_RECORD_GAP_BEFORE` plus the
inclusive missing sequence range. A partition-specific cursor scans physical
segments directly. It reports `SFS_RECORD_GAP_BEFORE` when the cursor's segment
has been evicted, or when an initial partition cursor opens a partition whose
manifest records prior eviction. The reported range is expressed in store-local
global sequence numbers: it proves that this partition's requested history was
truncated, but the interval may also contain sequence numbers that belonged to
other partitions. A partition scan does not otherwise label ordinary global
sequence gaps caused only by interleaved records in other partitions.

A partition cursor with nonzero `after_sequence` and zero `segment_id`/`offset`
seeks to the first retained record in that partition whose sequence is greater
than the supplied value. A successful read returns a physical cursor. End,
buffer-too-small and failure do not advance it. Prior eviction is reported only
when the requested sequence precedes the partition's retained prefix; unrelated
partitions' ordinary sequence gaps do not become data loss.

The open store keeps three `uint64_t` read-position hints per partition to avoid
decoding an already excluded segment prefix on every global/sequence seek.
Rewinds and evicted segment IDs are resolved against current segment metadata.
No payload or successful result is cached: selected frames are decoded and CRC
checked from the original mapping before a read succeeds. These hints are not
persisted and do not alter the disk format or cursor wire layout.

## C interface semantics

The public seam is `sfs_open`, `sfs_append`, `sfs_scan`, `sfs_status`,
`sfs_flush`, and `sfs_close` in `include/sfs.h`.

- `sfs_append` accepts already encoded opaque bytes and returns a physical
  `sfs_record_info_t` receipt containing global sequence, partition, segment,
  frame offset, and payload length.
- `sfs_scan` returns one record and advances the supplied cursor only on
  `SFS_OK`. `SFS_BUFFER_TOO_SMALL` reports the required payload length and does
  not advance it.
- A cursor constructed from an append receipt can read that physical frame by
  setting its partition, segment ID, and offset to the receipt values.
- Output structs use `struct_size` for ABI version checking.
- Calls on one handle are serialized by an internal mutex. One store directory
  permits one writer handle/process. Cross-process lock-free readers are not a
  v1 capability.
- Global merged scan is deliberately a correctness-first implementation and may
  rescan retained partition data; adapters needing high-rate queries should
  maintain a rebuildable projection from append receipts.
