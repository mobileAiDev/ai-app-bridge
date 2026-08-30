#!/usr/bin/env python3
"""Throwaway FactCache storage architecture benchmark.

This file intentionally lives under ``prototypes`` and is not production code.
It compares four implementations with the same deterministic fact stream:

1. current_like_sqlite
   One transaction per fact, followed by partition/global ``SUM(byte_size)``
   quota checks.  Its only retrieval index is ``(target, seq)``, matching the
   important shape of the current FactCache implementation.
2. optimized_sqlite
   Batches facts in one transaction, maintains O(1) usage counters, and adds a
   composite recent-fact index.
3. segmented_mmap
   POS-inspired 4 MiB append-only segments with a CRC32 and a commit marker at
   the final four bytes of each aligned frame.  A torn tail is ignored and the
   active segment is truncated to the last committed frame during recovery.
4. hybrid
   Uses the same mmap segments for payloads and a batched SQLite index for
   target/partition/action lookup.  Recovery rebuilds the index from committed
   frames, including a committed-but-not-indexed tail.

The benchmark answers an architectural question, not a language shoot-out.
Python's sqlite3/mmap implementations are deliberately small models of the
Node/Android implementations.  See ``limitations`` in the JSON output before
using absolute numbers for capacity planning.
"""

import argparse
import collections
import dataclasses
import datetime
import gc
import hashlib
import json
import math
import mmap
import os
import pathlib
import platform
import resource
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import zlib


ENGINE_NAMES = (
    "current_like_sqlite",
    "optimized_sqlite",
    "segmented_mmap",
    "hybrid",
)

PARTITIONS = ("action", "ui", "network", "logs")
TARGETS = tuple("device-{}/app-{}".format(index % 2, index) for index in range(8))
ACTIONS = ("tap", "input", "wait", "request", "event", "state")
QUERY_PARTITION = "ui"
QUERY_TARGET = TARGETS[3]
QUERY_ACTION = ACTIONS[2]

SEGMENT_SIZE = 4 * 1024 * 1024
SEGMENT_MAGIC = b"AIFACT1\0"
SEGMENT_HEADER = struct.Struct("<8sIIQQ16s")  # 48 bytes
FRAME_MAGIC = b"FACT"
FRAME_PREFIX = struct.Struct("<4sHHIQQII")  # 36 bytes; commit is frame tail
FRAME_VERSION = 1
COMMIT_MARKER = 0xC0DEC0DE
COMMIT = struct.Struct("<I")
FRAME_ALIGNMENT = 8


@dataclasses.dataclass(frozen=True)
class Fact:
    seq: int
    partition: str
    target: str
    action: str
    timestamp_ms: int
    body: bytes


@dataclasses.dataclass(frozen=True)
class FrameLocation:
    segment_id: int
    offset: int
    frame_len: int


def percentile(values, quantile):
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1))
    return ordered[index]


def latency_summary(latencies_ns):
    values_ms = [value / 1_000_000.0 for value in latencies_ns]
    return {
        "p50": round(percentile(values_ms, 0.50), 6),
        "p95": round(percentile(values_ms, 0.95), 6),
        "p99": round(percentile(values_ms, 0.99), 6),
        "max": round(max(values_ms) if values_ms else 0.0, 6),
    }


def max_rss_mib():
    raw = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    # macOS reports bytes; Linux and most BSD-derived Python builds report KiB.
    divisor = 1024.0 * 1024.0 if sys.platform == "darwin" else 1024.0
    return raw / divisor


def disk_usage(root):
    logical = 0
    allocated = 0
    files = 0
    for path in pathlib.Path(root).rglob("*"):
        if not path.is_file():
            continue
        stat = path.stat()
        logical += stat.st_size
        allocated += getattr(stat, "st_blocks", 0) * 512
        files += 1
    return {
        "files": files,
        "logical_bytes": logical,
        "allocated_bytes": allocated,
        "logical_mib": round(logical / (1024.0 * 1024.0), 4),
        "allocated_mib": round(allocated / (1024.0 * 1024.0), 4),
    }


def make_facts(count, payload_bytes):
    facts = []
    timestamp_base = 1_800_000_000_000
    for index in range(count):
        seq = index + 1
        digest = hashlib.sha256(str(seq).encode("ascii")).hexdigest()
        blob = (digest * ((payload_bytes // len(digest)) + 1))[:payload_bytes]
        record = {
            "seq": seq,
            "partition": PARTITIONS[index % len(PARTITIONS)],
            "target": TARGETS[(index // len(PARTITIONS)) % len(TARGETS)],
            "action": ACTIONS[(index // (len(PARTITIONS) * len(TARGETS))) % len(ACTIONS)],
            "timestampMs": timestamp_base + index,
            "payload": {"blob": blob, "ordinal": index, "source": "storage-benchmark"},
        }
        body = json.dumps(record, separators=(",", ":"), sort_keys=True).encode("utf-8")
        facts.append(
            Fact(
                seq=seq,
                partition=record["partition"],
                target=record["target"],
                action=record["action"],
                timestamp_ms=record["timestampMs"],
                body=body,
            )
        )
    return facts


def query_identity(sequences):
    encoded = ",".join(str(value) for value in sequences).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def configure_sqlite(connection):
    connection.isolation_level = None
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA wal_autocheckpoint = 32")
    connection.execute("PRAGMA mmap_size = 1073741824")


def create_fact_schema(connection, optimized):
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS facts (
          seq INTEGER PRIMARY KEY,
          partition_name TEXT NOT NULL,
          target_key TEXT NOT NULL,
          action_id TEXT NOT NULL,
          occurred_at_ms INTEGER NOT NULL,
          payload BLOB NOT NULL,
          byte_size INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS facts_target_sequence
          ON facts(target_key, seq);
        """
    )
    if optimized:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS usage_counters (
              partition_name TEXT PRIMARY KEY,
              byte_size INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS facts_recent_lookup
              ON facts(partition_name, target_key, action_id, seq DESC);
            """
        )


class SQLiteFactStore:
    def __init__(self, root, optimized):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "facts.sqlite3"
        self.optimized = optimized
        self.connection = sqlite3.connect(str(self.db_path), timeout=5.0)
        configure_sqlite(self.connection)
        create_fact_schema(self.connection, optimized)

    def append_current(self, fact):
        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO facts(
                  seq, partition_name, target_key, action_id,
                  occurred_at_ms, payload, byte_size
                ) VALUES (?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    fact.seq,
                    fact.partition,
                    fact.target,
                    fact.action,
                    fact.timestamp_ms,
                    fact.body,
                ),
            )
            connection.execute(
                "UPDATE facts SET byte_size = ? WHERE seq = ?", (len(fact.body), fact.seq)
            )
            # The benchmark budget is deliberately not exceeded.  These two
            # full aggregate reads model the current per-append quota cost.
            connection.execute(
                "SELECT COALESCE(SUM(byte_size), 0) FROM facts WHERE partition_name = ?",
                (fact.partition,),
            ).fetchone()
            connection.execute("SELECT COALESCE(SUM(byte_size), 0) FROM facts").fetchone()
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        present = connection.execute("SELECT 1 FROM facts WHERE seq = ?", (fact.seq,)).fetchone()
        if present is None:
            raise RuntimeError("current-like append did not remain visible")

    def append_batch(self, facts):
        starts = []
        rows = []
        usage = collections.Counter()
        for fact in facts:
            starts.append(time.perf_counter_ns())
            rows.append(
                (
                    fact.seq,
                    fact.partition,
                    fact.target,
                    fact.action,
                    fact.timestamp_ms,
                    fact.body,
                    len(fact.body),
                )
            )
            usage[fact.partition] += len(fact.body)
        connection = self.connection
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.executemany(
                """
                INSERT INTO facts(
                  seq, partition_name, target_key, action_id,
                  occurred_at_ms, payload, byte_size
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            connection.executemany(
                """
                INSERT INTO usage_counters(partition_name, byte_size)
                VALUES (?, ?)
                ON CONFLICT(partition_name) DO UPDATE
                SET byte_size = byte_size + excluded.byte_size
                """,
                list(usage.items()),
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        acknowledged = time.perf_counter_ns()
        return [acknowledged - started for started in starts]

    def close(self):
        started = time.perf_counter_ns()
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.connection.close()
        return time.perf_counter_ns() - started


def query_sqlite(db_path, rounds, limit):
    connection = sqlite3.connect(str(db_path))
    configure_sqlite(connection)
    latencies = []
    last_sequences = []
    for _ in range(rounds):
        started = time.perf_counter_ns()
        rows = connection.execute(
            """
            SELECT seq, payload
            FROM facts
            WHERE partition_name = ? AND target_key = ? AND action_id = ?
            ORDER BY seq DESC
            LIMIT ?
            """,
            (QUERY_PARTITION, QUERY_TARGET, QUERY_ACTION, limit),
        ).fetchall()
        # Decode the payload so the mmap and SQLite query paths return equally
        # usable facts rather than merely row locations.
        for seq, payload in rows:
            decoded = json.loads(bytes(payload).decode("utf-8"))
            if int(decoded["seq"]) != int(seq):
                raise RuntimeError("SQLite payload/index sequence mismatch")
        last_sequences = [int(row[0]) for row in rows]
        latencies.append(time.perf_counter_ns() - started)
    connection.close()
    summary = latency_summary(latencies)
    return {
        "filter": {
            "partition": QUERY_PARTITION,
            "target": QUERY_TARGET,
            "action": QUERY_ACTION,
            "limit": limit,
        },
        "rounds": rounds,
        "returned": len(last_sequences),
        "latency_ms": {"p50": summary["p50"], "p95": summary["p95"], "max": summary["max"]},
        "sequence_sha256": query_identity(last_sequences),
        "newest_seq": last_sequences[0] if last_sequences else None,
        "oldest_returned_seq": last_sequences[-1] if last_sequences else None,
    }


def align(value, alignment=FRAME_ALIGNMENT):
    return (value + alignment - 1) // alignment * alignment


def encode_frame(fact):
    total_len = align(FRAME_PREFIX.size + len(fact.body) + COMMIT.size)
    padding_len = total_len - FRAME_PREFIX.size - len(fact.body) - COMMIT.size
    prefix = FRAME_PREFIX.pack(
        FRAME_MAGIC,
        FRAME_VERSION,
        FRAME_PREFIX.size,
        total_len,
        fact.seq,
        fact.timestamp_ms,
        len(fact.body),
        zlib.crc32(fact.body) & 0xFFFFFFFF,
    )
    return prefix + fact.body + (b"\0" * padding_len) + COMMIT.pack(COMMIT_MARKER)


def segment_path(root, segment_id, suffix):
    return pathlib.Path(root) / "segment-{:06d}.{}".format(segment_id, suffix)


def parse_segment_id(path):
    return int(path.name.split("-")[1].split(".")[0])


class SegmentedMmapWriter:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        existing = [parse_segment_id(path) for path in self.root.glob("segment-*.*")]
        self.segment_id = max(existing) + 1 if existing else 0
        self.file = None
        self.mapping = None
        self.offset = SEGMENT_HEADER.size
        self._open_segment()

    def _open_segment(self):
        path = segment_path(self.root, self.segment_id, "active")
        self.file = open(str(path), "w+b")
        self.file.truncate(SEGMENT_SIZE)
        # CPython on this macOS host does not expose posix_fallocate.  ftruncate
        # establishes the 4 MiB virtual extent but can remain sparse; the JSON
        # output calls this out explicitly.
        if hasattr(os, "posix_fallocate"):
            os.posix_fallocate(self.file.fileno(), 0, SEGMENT_SIZE)
        self.mapping = mmap.mmap(self.file.fileno(), SEGMENT_SIZE, access=mmap.ACCESS_WRITE)
        header = SEGMENT_HEADER.pack(
            SEGMENT_MAGIC,
            1,
            SEGMENT_SIZE,
            time.time_ns(),
            self.segment_id,
            b"\0" * 16,
        )
        self.mapping[: SEGMENT_HEADER.size] = header
        self.offset = SEGMENT_HEADER.size

    def append(self, fact):
        frame = encode_frame(fact)
        if self.offset + len(frame) > SEGMENT_SIZE:
            self._seal_current()
            self.segment_id += 1
            self._open_segment()
        offset = self.offset
        # The commit marker is deliberately the final write.  Python mmap slice
        # assignment does not promise the release-store atomicity of the POS JNI
        # implementation, so this models ordering and recovery, not atomics.
        self.mapping[offset : offset + len(frame) - COMMIT.size] = frame[: -COMMIT.size]
        self.mapping[offset + len(frame) - COMMIT.size : offset + len(frame)] = frame[-COMMIT.size :]
        self.offset += len(frame)
        return FrameLocation(self.segment_id, offset, len(frame))

    def write_torn_tail(self, fact):
        frame = encode_frame(fact)
        if self.offset + len(frame) > SEGMENT_SIZE:
            self._seal_current()
            self.segment_id += 1
            self._open_segment()
        # Write the complete prefix and part of the body, but never the final
        # commit marker.  Preallocated bytes at the marker remain zero.
        written = max(FRAME_PREFIX.size, len(frame) // 2)
        self.mapping[self.offset : self.offset + written] = frame[:written]
        self.mapping.flush()
        return {"offset": self.offset, "declared_frame_len": len(frame), "bytes_written": written}

    def _seal_current(self):
        if self.mapping is None:
            return
        active = segment_path(self.root, self.segment_id, "active")
        sealed = segment_path(self.root, self.segment_id, "seg")
        self.mapping.flush()
        self.mapping.close()
        self.mapping = None
        self.file.truncate(self.offset)
        self.file.flush()
        os.fsync(self.file.fileno())
        self.file.close()
        self.file = None
        os.replace(str(active), str(sealed))

    def close(self):
        started = time.perf_counter_ns()
        self._seal_current()
        return time.perf_counter_ns() - started

    def crash_close(self):
        # Flush makes the synthetic recovery experiment deterministic.  It does
        # not claim that dirty pages survive power loss before msync/fsync.
        if self.mapping is not None:
            self.mapping.flush()
            self.mapping.close()
            self.mapping = None
        if self.file is not None:
            self.file.close()
            self.file = None


def scan_segment(path, include_bodies=True):
    data = pathlib.Path(path).read_bytes()
    if len(data) < SEGMENT_HEADER.size:
        return {"entries": [], "committed_end": 0, "stop_reason": "short_segment_header"}
    magic, version, declared_size, _created_ns, segment_id, _reserved = SEGMENT_HEADER.unpack_from(data, 0)
    if magic != SEGMENT_MAGIC or version != 1 or declared_size != SEGMENT_SIZE:
        return {"entries": [], "committed_end": 0, "stop_reason": "invalid_segment_header"}
    offset = SEGMENT_HEADER.size
    entries = []
    stop_reason = "clean_eof"
    while offset < len(data):
        if offset + FRAME_PREFIX.size + COMMIT.size > len(data):
            stop_reason = "truncated_prefix"
            break
        prefix = FRAME_PREFIX.unpack_from(data, offset)
        frame_magic, frame_version, header_size, total_len, seq, timestamp_ms, payload_len, crc = prefix
        if frame_magic == b"\0\0\0\0":
            stop_reason = "preallocated_empty_tail"
            break
        if (
            frame_magic != FRAME_MAGIC
            or frame_version != FRAME_VERSION
            or header_size != FRAME_PREFIX.size
            or total_len % FRAME_ALIGNMENT != 0
            or total_len < FRAME_PREFIX.size + COMMIT.size
            or payload_len > total_len - FRAME_PREFIX.size - COMMIT.size
        ):
            stop_reason = "invalid_frame_header"
            break
        frame_end = offset + total_len
        if frame_end > len(data):
            stop_reason = "truncated_frame"
            break
        marker = COMMIT.unpack_from(data, frame_end - COMMIT.size)[0]
        if marker != COMMIT_MARKER:
            stop_reason = "missing_commit_marker"
            break
        body = data[offset + FRAME_PREFIX.size : offset + FRAME_PREFIX.size + payload_len]
        if zlib.crc32(body) & 0xFFFFFFFF != crc:
            stop_reason = "crc_mismatch"
            break
        entries.append(
            {
                "seq": int(seq),
                "timestamp_ms": int(timestamp_ms),
                "segment_id": int(segment_id),
                "offset": offset,
                "frame_len": total_len,
                "body": body if include_bodies else None,
            }
        )
        offset = frame_end
    return {"entries": entries, "committed_end": offset, "stop_reason": stop_reason}


def all_segment_paths(root):
    return sorted(pathlib.Path(root).glob("segment-*.*"), key=lambda path: (parse_segment_id(path), path.suffix))


def scan_all_segments(root, include_bodies=True):
    entries = []
    scans = []
    for path in all_segment_paths(root):
        scan = scan_segment(path, include_bodies=include_bodies)
        scans.append({"path": path.name, "committed_end": scan["committed_end"], "stop_reason": scan["stop_reason"]})
        entries.extend(scan["entries"])
    return entries, scans


def recover_active_segments(root):
    recovered_frames = 0
    discarded_tails = 0
    details = []
    for active in sorted(pathlib.Path(root).glob("segment-*.active")):
        scan = scan_segment(active, include_bodies=False)
        recovered_frames += len(scan["entries"])
        if scan["stop_reason"] not in ("clean_eof", "preallocated_empty_tail"):
            discarded_tails += 1
        with open(str(active), "r+b") as handle:
            handle.truncate(scan["committed_end"])
            handle.flush()
            os.fsync(handle.fileno())
        sealed = active.with_suffix(".seg")
        os.replace(str(active), str(sealed))
        details.append(
            {
                "segment": sealed.name,
                "valid_frames": len(scan["entries"]),
                "stop_reason": scan["stop_reason"],
                "recovered_bytes": scan["committed_end"],
            }
        )
    return {
        "recovered_frames": recovered_frames,
        "discarded_tails": discarded_tails,
        "segments": details,
    }


def query_segmented_mmap(root, rounds, limit):
    latencies = []
    last_sequences = []
    for _ in range(rounds):
        started = time.perf_counter_ns()
        matches = collections.deque(maxlen=limit)
        entries, _scans = scan_all_segments(root, include_bodies=True)
        for entry in entries:
            decoded = json.loads(entry["body"].decode("utf-8"))
            if (
                decoded["partition"] == QUERY_PARTITION
                and decoded["target"] == QUERY_TARGET
                and decoded["action"] == QUERY_ACTION
            ):
                matches.append(int(decoded["seq"]))
        last_sequences = list(reversed(matches))
        latencies.append(time.perf_counter_ns() - started)
    summary = latency_summary(latencies)
    return {
        "filter": {
            "partition": QUERY_PARTITION,
            "target": QUERY_TARGET,
            "action": QUERY_ACTION,
            "limit": limit,
        },
        "rounds": rounds,
        "returned": len(last_sequences),
        "latency_ms": {"p50": summary["p50"], "p95": summary["p95"], "max": summary["max"]},
        "sequence_sha256": query_identity(last_sequences),
        "newest_seq": last_sequences[0] if last_sequences else None,
        "oldest_returned_seq": last_sequences[-1] if last_sequences else None,
    }


def configure_hybrid_index(connection):
    connection.isolation_level = None
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA wal_autocheckpoint = 32")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS fact_index (
          seq INTEGER PRIMARY KEY,
          partition_name TEXT NOT NULL,
          target_key TEXT NOT NULL,
          action_id TEXT NOT NULL,
          segment_id INTEGER NOT NULL,
          frame_offset INTEGER NOT NULL,
          frame_len INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS fact_index_recent_lookup
          ON fact_index(partition_name, target_key, action_id, seq DESC);
        """
    )


class HybridFactStore:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "fact-index.sqlite3"
        self.connection = sqlite3.connect(str(self.db_path), timeout=5.0)
        configure_hybrid_index(self.connection)
        self.segments = SegmentedMmapWriter(self.root)

    def append_batch(self, facts):
        starts = []
        rows = []
        for fact in facts:
            starts.append(time.perf_counter_ns())
            location = self.segments.append(fact)
            rows.append(
                (
                    fact.seq,
                    fact.partition,
                    fact.target,
                    fact.action,
                    location.segment_id,
                    location.offset,
                    location.frame_len,
                )
            )
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            self.connection.executemany(
                """
                INSERT INTO fact_index(
                  seq, partition_name, target_key, action_id,
                  segment_id, frame_offset, frame_len
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        acknowledged = time.perf_counter_ns()
        return [acknowledged - started for started in starts]

    def close(self):
        started = time.perf_counter_ns()
        self.segments.close()
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.connection.close()
        return time.perf_counter_ns() - started


def find_segment(root, segment_id):
    sealed = segment_path(root, segment_id, "seg")
    if sealed.exists():
        return sealed
    active = segment_path(root, segment_id, "active")
    if active.exists():
        return active
    raise FileNotFoundError("segment {} does not exist".format(segment_id))


def read_frame_at(handle, expected_offset, expected_len):
    handle.seek(expected_offset)
    prefix_bytes = handle.read(FRAME_PREFIX.size)
    if len(prefix_bytes) != FRAME_PREFIX.size:
        raise RuntimeError("short indexed frame prefix")
    prefix = FRAME_PREFIX.unpack(prefix_bytes)
    magic, version, header_size, total_len, seq, _timestamp_ms, payload_len, crc = prefix
    if magic != FRAME_MAGIC or version != FRAME_VERSION or header_size != FRAME_PREFIX.size:
        raise RuntimeError("invalid indexed frame prefix")
    if total_len != expected_len:
        raise RuntimeError("indexed frame length mismatch")
    remainder = handle.read(total_len - FRAME_PREFIX.size)
    if len(remainder) != total_len - FRAME_PREFIX.size:
        raise RuntimeError("short indexed frame")
    if COMMIT.unpack(remainder[-COMMIT.size :])[0] != COMMIT_MARKER:
        raise RuntimeError("indexed frame lacks commit marker")
    body = remainder[:payload_len]
    if zlib.crc32(body) & 0xFFFFFFFF != crc:
        raise RuntimeError("indexed frame CRC mismatch")
    return int(seq), body


def query_hybrid(root, rounds, limit):
    root = pathlib.Path(root)
    connection = sqlite3.connect(str(root / "fact-index.sqlite3"))
    configure_hybrid_index(connection)
    latencies = []
    last_sequences = []
    for _ in range(rounds):
        started = time.perf_counter_ns()
        rows = connection.execute(
            """
            SELECT seq, segment_id, frame_offset, frame_len
            FROM fact_index
            WHERE partition_name = ? AND target_key = ? AND action_id = ?
            ORDER BY seq DESC
            LIMIT ?
            """,
            (QUERY_PARTITION, QUERY_TARGET, QUERY_ACTION, limit),
        ).fetchall()
        handles = {}
        try:
            sequences = []
            for expected_seq, segment_id, offset, frame_len in rows:
                if segment_id not in handles:
                    handles[segment_id] = open(str(find_segment(root, int(segment_id))), "rb")
                actual_seq, body = read_frame_at(handles[segment_id], int(offset), int(frame_len))
                decoded = json.loads(body.decode("utf-8"))
                if actual_seq != int(expected_seq) or int(decoded["seq"]) != int(expected_seq):
                    raise RuntimeError("hybrid payload/index sequence mismatch")
                sequences.append(int(expected_seq))
        finally:
            for handle in handles.values():
                handle.close()
        last_sequences = sequences
        latencies.append(time.perf_counter_ns() - started)
    connection.close()
    summary = latency_summary(latencies)
    return {
        "filter": {
            "partition": QUERY_PARTITION,
            "target": QUERY_TARGET,
            "action": QUERY_ACTION,
            "limit": limit,
        },
        "rounds": rounds,
        "returned": len(last_sequences),
        "latency_ms": {"p50": summary["p50"], "p95": summary["p95"], "max": summary["max"]},
        "sequence_sha256": query_identity(last_sequences),
        "newest_seq": last_sequences[0] if last_sequences else None,
        "oldest_returned_seq": last_sequences[-1] if last_sequences else None,
    }


def rebuild_hybrid_index(root):
    root = pathlib.Path(root)
    entries, scans = scan_all_segments(root, include_bodies=True)
    rows = []
    for entry in entries:
        decoded = json.loads(entry["body"].decode("utf-8"))
        rows.append(
            (
                int(decoded["seq"]),
                decoded["partition"],
                decoded["target"],
                decoded["action"],
                entry["segment_id"],
                entry["offset"],
                entry["frame_len"],
            )
        )
    connection = sqlite3.connect(str(root / "fact-index.sqlite3"))
    configure_hybrid_index(connection)
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute("DELETE FROM fact_index")
        connection.executemany(
            """
            INSERT INTO fact_index(
              seq, partition_name, target_key, action_id,
              segment_id, frame_offset, frame_len
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    indexed = connection.execute("SELECT COUNT(*) FROM fact_index").fetchone()[0]
    connection.close()
    return {"indexed_frames": int(indexed), "segment_scans": scans}


def sqlite_recovery_experiment(root, optimized):
    root = pathlib.Path(root)
    facts = make_facts(201, 64)
    store = SQLiteFactStore(root, optimized=optimized)
    if optimized:
        store.append_batch(facts[:200])
    else:
        for fact in facts[:200]:
            store.append_current(fact)
    store.close()

    connection = sqlite3.connect(str(root / "facts.sqlite3"))
    configure_sqlite(connection)
    connection.execute("BEGIN IMMEDIATE")
    fact = facts[200]
    connection.execute(
        """
        INSERT INTO facts(
          seq, partition_name, target_key, action_id,
          occurred_at_ms, payload, byte_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            fact.seq,
            fact.partition,
            fact.target,
            fact.action,
            fact.timestamp_ms,
            fact.body,
            len(fact.body),
        ),
    )
    # Closing an uncommitted transaction is the SQLite analogue tested here;
    # SQLite itself owns WAL/page-level torn-write recovery.
    connection.close()
    reopened = sqlite3.connect(str(root / "facts.sqlite3"))
    count = int(reopened.execute("SELECT COUNT(*) FROM facts").fetchone()[0])
    max_seq = int(reopened.execute("SELECT MAX(seq) FROM facts").fetchone()[0])
    reopened.close()
    return {
        "mode": "sqlite_uncommitted_transaction_rollback",
        "seed_committed": 200,
        "visible_after_reopen": count,
        "max_seq_after_reopen": max_seq,
        "passed": count == 200 and max_seq == 200,
        "note": "This does not inject corrupted SQLite pages; SQLite WAL recovery is library-owned.",
    }


def mmap_recovery_experiment(root):
    facts = make_facts(201, 64)
    writer = SegmentedMmapWriter(root)
    for fact in facts[:200]:
        writer.append(fact)
    torn = writer.write_torn_tail(facts[200])
    writer.crash_close()
    recovery = recover_active_segments(root)
    entries, scans = scan_all_segments(root, include_bodies=False)
    sequences = [entry["seq"] for entry in entries]
    return {
        "mode": "commit_marker_and_crc_tail_scan",
        "seed_committed": 200,
        "torn_tail": torn,
        "recovery": recovery,
        "visible_after_recovery": len(entries),
        "max_seq_after_recovery": max(sequences) if sequences else None,
        "segment_scans": scans,
        "passed": len(entries) == 200 and max(sequences) == 200,
    }


def hybrid_recovery_experiment(root, batch_size):
    facts = make_facts(202, 64)
    store = HybridFactStore(root)
    store.append_batch(facts[:200])
    indexed_before = int(store.connection.execute("SELECT COUNT(*) FROM fact_index").fetchone()[0])
    # This committed frame models a crash after the segment commit marker but
    # before the batched SQLite index transaction.
    store.segments.append(facts[200])
    torn = store.segments.write_torn_tail(facts[201])
    store.segments.crash_close()
    store.connection.close()
    recovery = recover_active_segments(root)
    rebuild = rebuild_hybrid_index(root)
    connection = sqlite3.connect(str(pathlib.Path(root) / "fact-index.sqlite3"))
    indexed_after = int(connection.execute("SELECT COUNT(*) FROM fact_index").fetchone()[0])
    max_seq = int(connection.execute("SELECT MAX(seq) FROM fact_index").fetchone()[0])
    connection.close()
    return {
        "mode": "segment_tail_scan_and_index_rebuild",
        "batch_size": batch_size,
        "seed_indexed": indexed_before,
        "committed_but_unindexed": 1,
        "torn_tail": torn,
        "recovery": recovery,
        "rebuild": rebuild,
        "indexed_after_recovery": indexed_after,
        "max_seq_after_recovery": max_seq,
        "passed": indexed_before == 200 and indexed_after == 201 and max_seq == 201,
    }


def benchmark_worker(engine, root, records, payload_bytes, batch_size, query_rounds, query_limit):
    root = pathlib.Path(root)
    data_root = root / "data"
    recovery_root = root / "recovery"
    facts = make_facts(records, payload_bytes)
    total_body_bytes = sum(len(fact.body) for fact in facts)
    gc.collect()
    rss_before = max_rss_mib()
    cpu_started = time.process_time()
    wall_started = time.perf_counter_ns()
    latencies = []

    if engine == "current_like_sqlite":
        store = SQLiteFactStore(data_root, optimized=False)
        append_cpu_started = time.process_time()
        append_started = time.perf_counter_ns()
        for fact in facts:
            started = time.perf_counter_ns()
            store.append_current(fact)
            latencies.append(time.perf_counter_ns() - started)
        append_finished = time.perf_counter_ns()
        finalize_ns = store.close()
        append_cpu_finished = time.process_time()
        rss_after_write = max_rss_mib()
        query = query_sqlite(data_root / "facts.sqlite3", query_rounds, query_limit)
        recovery = sqlite_recovery_experiment(recovery_root, optimized=False)
    elif engine == "optimized_sqlite":
        store = SQLiteFactStore(data_root, optimized=True)
        append_cpu_started = time.process_time()
        append_started = time.perf_counter_ns()
        for offset in range(0, len(facts), batch_size):
            latencies.extend(store.append_batch(facts[offset : offset + batch_size]))
        append_finished = time.perf_counter_ns()
        finalize_ns = store.close()
        append_cpu_finished = time.process_time()
        rss_after_write = max_rss_mib()
        query = query_sqlite(data_root / "facts.sqlite3", query_rounds, query_limit)
        recovery = sqlite_recovery_experiment(recovery_root, optimized=True)
    elif engine == "segmented_mmap":
        store = SegmentedMmapWriter(data_root)
        append_cpu_started = time.process_time()
        append_started = time.perf_counter_ns()
        for fact in facts:
            started = time.perf_counter_ns()
            store.append(fact)
            latencies.append(time.perf_counter_ns() - started)
        append_finished = time.perf_counter_ns()
        finalize_ns = store.close()
        append_cpu_finished = time.process_time()
        rss_after_write = max_rss_mib()
        query = query_segmented_mmap(data_root, query_rounds, query_limit)
        recovery = mmap_recovery_experiment(recovery_root)
    elif engine == "hybrid":
        store = HybridFactStore(data_root)
        append_cpu_started = time.process_time()
        append_started = time.perf_counter_ns()
        for offset in range(0, len(facts), batch_size):
            latencies.extend(store.append_batch(facts[offset : offset + batch_size]))
        append_finished = time.perf_counter_ns()
        finalize_ns = store.close()
        append_cpu_finished = time.process_time()
        rss_after_write = max_rss_mib()
        query = query_hybrid(data_root, query_rounds, query_limit)
        recovery = hybrid_recovery_experiment(recovery_root, batch_size)
    else:
        raise ValueError("unknown engine: {}".format(engine))

    wall_finished = time.perf_counter_ns()
    cpu_finished = time.process_time()
    elapsed_s = (wall_finished - wall_started) / 1_000_000_000.0
    append_s = (append_finished - append_started) / 1_000_000_000.0
    write_wall_s = append_s + finalize_ns / 1_000_000_000.0
    write_cpu_s = append_cpu_finished - append_cpu_started
    cpu_s = cpu_finished - cpu_started
    rss_peak = max_rss_mib()
    result = {
        "engine": engine,
        "write": {
            "records": records,
            "requested_payload_bytes_per_fact": payload_bytes,
            "encoded_body_bytes_total": total_body_bytes,
            "append_phase_ms": round(append_s * 1000.0, 3),
            "finalize_ms": round(finalize_ns / 1_000_000.0, 3),
            "worker_wall_ms_including_query_and_recovery": round(elapsed_s * 1000.0, 3),
            "throughput_records_per_second": round(records / max(write_wall_s, 1e-9), 2),
            "append_ack_latency_ms": latency_summary(latencies),
            "write_cpu_seconds": round(write_cpu_s, 6),
            "write_cpu_percent_of_one_core": round(write_cpu_s / max(write_wall_s, 1e-9) * 100.0, 2),
            "cpu_seconds_including_query_and_recovery": round(cpu_s, 6),
            "cpu_percent_of_one_core_including_query_and_recovery": round(cpu_s / max(elapsed_s, 1e-9) * 100.0, 2),
            "rss_baseline_peak_mib_after_workload_creation": round(rss_before, 3),
            "rss_peak_after_write_mib": round(rss_after_write, 3),
            "rss_peak_delta_after_write_mib": round(max(0.0, rss_after_write - rss_before), 3),
            "rss_process_peak_mib": round(rss_peak, 3),
            "rss_peak_delta_mib": round(max(0.0, rss_peak - rss_before), 3),
        },
        "query_recent_target_partition_action": query,
        "disk_after_clean_close": disk_usage(data_root),
        "torn_tail_recovery": recovery,
    }
    if engine in ("segmented_mmap", "hybrid"):
        result["segment_format"] = {
            "segment_size_bytes": SEGMENT_SIZE,
            "segment_header_bytes": SEGMENT_HEADER.size,
            "frame_prefix_bytes": FRAME_PREFIX.size,
            "frame_alignment_bytes": FRAME_ALIGNMENT,
            "crc": "CRC32(payload)",
            "commit_marker": "final 4 bytes, written last",
        }
    return result


def run_main(args):
    temporary = tempfile.mkdtemp(prefix="ai-app-bridge-storage-benchmark-")
    results = []
    try:
        for engine in ENGINE_NAMES:
            engine_root = pathlib.Path(temporary) / engine
            engine_root.mkdir(parents=True)
            command = [
                sys.executable,
                str(pathlib.Path(__file__).resolve()),
                "--worker",
                engine,
                "--root",
                str(engine_root),
                "--records",
                str(args.records),
                "--payload-bytes",
                str(args.payload_bytes),
                "--batch-size",
                str(args.batch_size),
                "--query-rounds",
                str(args.query_rounds),
                "--query-limit",
                str(args.query_limit),
            ]
            completed = subprocess.run(command, capture_output=True, text=True, timeout=args.timeout_seconds)
            if completed.returncode != 0:
                raise RuntimeError(
                    "{} worker failed (exit {}):\n{}\n{}".format(
                        engine, completed.returncode, completed.stdout, completed.stderr
                    )
                )
            results.append(json.loads(completed.stdout))
        hashes = {
            result["engine"]: result["query_recent_target_partition_action"]["sequence_sha256"]
            for result in results
        }
        recovery_passed = {
            result["engine"]: bool(result["torn_tail_recovery"]["passed"])
            for result in results
        }
        output = {
            "prototype": True,
            "production_code_modified": False,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "host": {
                "platform": platform.platform(),
                "python": platform.python_version(),
                "sqlite": sqlite3.sqlite_version,
                "posix_fallocate_available": hasattr(os, "posix_fallocate"),
            },
            "workload": {
                "records": args.records,
                "payload_bytes_requested": args.payload_bytes,
                "batch_size": args.batch_size,
                "query_rounds": args.query_rounds,
                "query_limit": args.query_limit,
                "query_filter": {
                    "partition": QUERY_PARTITION,
                    "target": QUERY_TARGET,
                    "action": QUERY_ACTION,
                },
            },
            "validation": {
                "same_query_result_across_engines": len(set(hashes.values())) == 1,
                "query_sequence_sha256_by_engine": hashes,
                "all_recovery_experiments_passed": all(recovery_passed.values()),
                "recovery_passed_by_engine": recovery_passed,
            },
            "results": results,
            "limitations": [
                "Python 3 sqlite3/mmap models Node DatabaseSync and Android JNI; compare shapes and ratios, not absolute cross-language capacity.",
                "Fact JSON encoding is completed before timing. Production redaction, dedupe, event capture, queues, IPC, and schema migration are excluded.",
                "SQLite uses WAL with synchronous=NORMAL. mmap append acknowledges after the commit-marker store and flushes/fsyncs only when sealing; per-record latency therefore does not represent equal power-loss durability.",
                "Python mmap slice assignment models write ordering but cannot prove the POS JNI implementation's atomic release-store semantics.",
                "On hosts without posix_fallocate, 4 MiB active files use ftruncate and may be sparse. Sealed segments are flushed, fsynced, and truncated to committed length like the inspected POS design.",
                "The hybrid benchmark rebuilds its complete SQLite index after a synthetic crash. A production implementation should checkpoint indexed segment/offset and repair only the unindexed tail.",
                "This is a single-writer benchmark. Lock contention, a writer daemon, multi-process ordering, and backpressure need a separate experiment.",
                "Query rounds run after writes on a warm local filesystem cache. Pure mmap deliberately performs a sequential scan because it has no secondary index.",
                "RSS is isolated per engine process, but the baseline already includes the identical pre-generated workload; delta represents storage-path overhead above that common baseline.",
            ],
        }
        print(json.dumps(output, indent=2, sort_keys=True))
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", choices=ENGINE_NAMES)
    parser.add_argument("--root")
    parser.add_argument("--records", type=int, default=10_000)
    parser.add_argument("--payload-bytes", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--query-rounds", type=int, default=25)
    parser.add_argument("--query-limit", type=int, default=40)
    parser.add_argument("--timeout-seconds", type=int, default=600)
    args = parser.parse_args(argv)
    if args.records <= 0 or args.payload_bytes < 0 or args.batch_size <= 0:
        parser.error("records and batch-size must be positive; payload-bytes cannot be negative")
    if args.query_rounds <= 0 or args.query_limit <= 0:
        parser.error("query-rounds and query-limit must be positive")
    if args.worker and not args.root:
        parser.error("--root is required with --worker")
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.worker:
        result = benchmark_worker(
            args.worker,
            args.root,
            args.records,
            args.payload_bytes,
            args.batch_size,
            args.query_rounds,
            args.query_limit,
        )
        print(json.dumps(result, sort_keys=True))
    else:
        run_main(args)


if __name__ == "__main__":
    main()
