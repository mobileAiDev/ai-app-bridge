#!/usr/bin/env python3
"""Throwaway real-time FactCache ingest benchmark.

This is a separate experiment from ``storage_benchmark.py``.  It models four
producers publishing a combined 1,000 facts/second into one bounded queue and a
single storage writer.  The writer flushes when either 256 records are queued
or the oldest record reaches ``maxBatchAge``.

Two storage implementations are compared:

* optimized_sqlite: batched SQLite payloads, O(1) usage counters, WAL and
  synchronous=FULL.
* hybrid: POS-like mmap payload segments, followed by a batched SQLite index.
  Each batch flushes and fsyncs segment bytes before committing the FULL-sync
  index transaction.

ACK latency starts immediately before the producer offers a fact to the queue
and ends only after the storage batch crosses the commit boundary above.  This
lets the benchmark show why a large batch size also needs a maximum batch age.

This remains a Python prototype: absolute numbers do not replace a Node/JNI or
real-device benchmark.  Exact limitations are included in the JSON output.
"""

import argparse
import collections
import dataclasses
import datetime
import json
import os
import pathlib
import platform
import queue
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time


import storage_benchmark as storage


ENGINE_NAMES = ("optimized_sqlite", "hybrid")
DEFAULT_BATCH_AGES_MS = (1.0, 5.0, 20.0)
PARTITION_NAMES = (
    "network",
    "ui",
    "app-log",
    "device-log",
    "state-event",
    "action",
    "note",
    "index",
)


@dataclasses.dataclass(frozen=True)
class Submission:
    fact: storage.Fact
    producer_id: int
    offered_ns: int


class SharedMeasurements:
    def __init__(self):
        self.lock = threading.Lock()
        self.enqueue_latencies_ns = []
        self.producer_schedule_lateness_ns = []
        self.dropped = 0
        self.max_queue_depth = 0

    def accepted(self, enqueue_latency_ns, schedule_lateness_ns, queue_depth):
        with self.lock:
            self.enqueue_latencies_ns.append(enqueue_latency_ns)
            self.producer_schedule_lateness_ns.append(schedule_lateness_ns)
            self.max_queue_depth = max(self.max_queue_depth, queue_depth)

    def dropped_offer(self, enqueue_latency_ns, schedule_lateness_ns, queue_depth):
        with self.lock:
            self.enqueue_latencies_ns.append(enqueue_latency_ns)
            self.producer_schedule_lateness_ns.append(schedule_lateness_ns)
            self.dropped += 1
            self.max_queue_depth = max(self.max_queue_depth, queue_depth)


def open_full_sync_sqlite(path):
    # The connection is constructed before the writer thread starts, then used
    # exclusively by that one writer thread until it has drained the queue.
    connection = sqlite3.connect(str(path), timeout=5.0, check_same_thread=False)
    connection.isolation_level = None
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = FULL")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA wal_autocheckpoint = 32")
    return connection


class OptimizedSQLiteStreamStore:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "facts.sqlite3"
        self.connection = open_full_sync_sqlite(self.db_path)
        self.connection.executescript(
            """
            CREATE TABLE facts (
              seq INTEGER PRIMARY KEY,
              partition_name TEXT NOT NULL,
              target_key TEXT NOT NULL,
              action_id TEXT NOT NULL,
              occurred_at_ms INTEGER NOT NULL,
              payload BLOB NOT NULL,
              byte_size INTEGER NOT NULL
            );
            CREATE TABLE usage_counters (
              partition_name TEXT PRIMARY KEY,
              byte_size INTEGER NOT NULL
            );
            CREATE INDEX facts_recent_lookup
              ON facts(partition_name, target_key, action_id, seq DESC);
            """
        )

    def write_batch(self, submissions):
        rows = []
        usage = collections.Counter()
        for submission in submissions:
            fact = submission.fact
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
        commit_started = time.perf_counter_ns()
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            self.connection.executemany(
                """
                INSERT INTO facts(
                  seq, partition_name, target_key, action_id,
                  occurred_at_ms, payload, byte_size
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            self.connection.executemany(
                """
                INSERT INTO usage_counters(partition_name, byte_size)
                VALUES (?, ?)
                ON CONFLICT(partition_name) DO UPDATE
                SET byte_size = byte_size + excluded.byte_size
                """,
                list(usage.items()),
            )
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        acknowledged_ns = time.perf_counter_ns()
        return acknowledged_ns, acknowledged_ns - commit_started

    def close(self):
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.connection.close()

    def verify(self):
        connection = sqlite3.connect(str(self.db_path))
        count = int(connection.execute("SELECT COUNT(*) FROM facts").fetchone()[0])
        distinct_count = int(connection.execute("SELECT COUNT(DISTINCT seq) FROM facts").fetchone()[0])
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        connection.close()
        return {
            "visible_count": count,
            "distinct_sequence_count": distinct_count,
            "sqlite_integrity_check": integrity,
        }


class HybridStreamStore:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "fact-index.sqlite3"
        self.connection = open_full_sync_sqlite(self.db_path)
        self.connection.executescript(
            """
            CREATE TABLE fact_index (
              seq INTEGER PRIMARY KEY,
              partition_name TEXT NOT NULL,
              target_key TEXT NOT NULL,
              action_id TEXT NOT NULL,
              segment_id INTEGER NOT NULL,
              frame_offset INTEGER NOT NULL,
              frame_len INTEGER NOT NULL
            );
            CREATE INDEX fact_index_recent_lookup
              ON fact_index(partition_name, target_key, action_id, seq DESC);
            """
        )
        self.segments = storage.SegmentedMmapWriter(self.root)

    def write_batch(self, submissions):
        commit_started = time.perf_counter_ns()
        rows = []
        for submission in submissions:
            fact = submission.fact
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

        # A hybrid index must not acknowledge a row whose payload is only a
        # dirty mmap page.  Flush/fsync the current segment first.  Any segment
        # rotated during append was already flushed, fsynced, and sealed by the
        # shared POS-like writer.
        self.segments.mapping.flush()
        os.fsync(self.segments.file.fileno())
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
        acknowledged_ns = time.perf_counter_ns()
        return acknowledged_ns, acknowledged_ns - commit_started

    def close(self):
        self.segments.close()
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.connection.close()

    def verify(self):
        connection = sqlite3.connect(str(self.db_path))
        indexed_count = int(connection.execute("SELECT COUNT(*) FROM fact_index").fetchone()[0])
        distinct_count = int(connection.execute("SELECT COUNT(DISTINCT seq) FROM fact_index").fetchone()[0])
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        connection.close()
        segment_entries, scans = storage.scan_all_segments(self.root, include_bodies=False)
        segment_count = len(segment_entries)
        return {
            "visible_count": indexed_count,
            "distinct_sequence_count": distinct_count,
            "committed_segment_frame_count": segment_count,
            "index_minus_committed_frames": indexed_count - segment_count,
            "sqlite_integrity_check": integrity,
            "segment_scans": scans,
        }


def make_store(engine, root):
    if engine == "optimized_sqlite":
        return OptimizedSQLiteStreamStore(root)
    if engine == "hybrid":
        return HybridStreamStore(root)
    raise ValueError("unknown engine: {}".format(engine))


def producer_loop(
    producer_id,
    producer_count,
    facts,
    attempts_per_producer,
    per_producer_period_ns,
    aggregate_period_ns,
    start_ns,
    fact_queue,
    measurements,
):
    # Stagger producers across the aggregate 1 ms cadence rather than creating
    # an unrealistic four-record burst every 4 ms.
    phase_ns = producer_id * aggregate_period_ns
    for ordinal in range(attempts_per_producer):
        target_ns = start_ns + ordinal * per_producer_period_ns + phase_ns
        remaining_ns = target_ns - time.perf_counter_ns()
        if remaining_ns > 0:
            time.sleep(remaining_ns / 1_000_000_000.0)
        offered_ns = time.perf_counter_ns()
        sequence_index = ordinal * producer_count + producer_id
        submission = Submission(
            fact=facts[sequence_index],
            producer_id=producer_id,
            offered_ns=offered_ns,
        )
        enqueue_started = time.perf_counter_ns()
        try:
            fact_queue.put_nowait(submission)
        except queue.Full:
            enqueue_finished = time.perf_counter_ns()
            measurements.dropped_offer(
                enqueue_finished - enqueue_started,
                max(0, offered_ns - target_ns),
                fact_queue.qsize(),
            )
        else:
            enqueue_finished = time.perf_counter_ns()
            measurements.accepted(
                enqueue_finished - enqueue_started,
                max(0, offered_ns - target_ns),
                fact_queue.qsize(),
            )


def writer_loop(
    store,
    fact_queue,
    producers_done,
    batch_size,
    max_batch_age_ns,
    ack_latencies_ns,
    commit_latencies_ns,
    batch_sizes,
    oldest_batch_ages_ns,
    writer_errors,
):
    try:
        while True:
            if producers_done.is_set() and fact_queue.empty():
                break
            try:
                first = fact_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            batch = [first]
            deadline_ns = first.offered_ns + max_batch_age_ns
            while len(batch) < batch_size:
                remaining_ns = deadline_ns - time.perf_counter_ns()
                if remaining_ns <= 0:
                    break
                try:
                    batch.append(fact_queue.get(timeout=remaining_ns / 1_000_000_000.0))
                except queue.Empty:
                    break
            acknowledged_ns, commit_latency_ns = store.write_batch(batch)
            commit_latencies_ns.append(commit_latency_ns)
            batch_sizes.append(len(batch))
            oldest_batch_ages_ns.append(acknowledged_ns - min(item.offered_ns for item in batch))
            for item in batch:
                ack_latencies_ns.append(acknowledged_ns - item.offered_ns)
                fact_queue.task_done()
    except BaseException as error:  # surface thread failures to the worker
        writer_errors.append(error)


def size_summary(values):
    if not values:
        return {"p50": 0, "p95": 0, "max": 0}
    return {
        "p50": int(storage.percentile(values, 0.50)),
        "p95": int(storage.percentile(values, 0.95)),
        "max": int(max(values)),
    }


def run_stream_worker(
    engine,
    root,
    duration_seconds,
    aggregate_rate,
    producer_count,
    queue_capacity,
    batch_size,
    max_batch_age_ms,
    payload_bytes,
):
    if aggregate_rate % producer_count != 0:
        raise ValueError("aggregate rate must be divisible by producer count")
    per_producer_rate = aggregate_rate // producer_count
    attempts_per_producer = int(round(duration_seconds * per_producer_rate))
    attempted = attempts_per_producer * producer_count
    facts = storage.make_facts(attempted, payload_bytes)
    store = make_store(engine, root)
    fact_queue = queue.Queue(maxsize=queue_capacity)
    measurements = SharedMeasurements()
    producers_done = threading.Event()
    ack_latencies_ns = []
    commit_latencies_ns = []
    batch_sizes = []
    oldest_batch_ages_ns = []
    writer_errors = []

    aggregate_period_ns = int(round(1_000_000_000.0 / aggregate_rate))
    per_producer_period_ns = int(round(1_000_000_000.0 / per_producer_rate))
    max_batch_age_ns = int(round(max_batch_age_ms * 1_000_000.0))
    common_start_ns = time.perf_counter_ns() + 250_000_000
    rss_before = storage.max_rss_mib()
    cpu_started = time.process_time()

    writer = threading.Thread(
        target=writer_loop,
        name="fact-stream-writer",
        args=(
            store,
            fact_queue,
            producers_done,
            batch_size,
            max_batch_age_ns,
            ack_latencies_ns,
            commit_latencies_ns,
            batch_sizes,
            oldest_batch_ages_ns,
            writer_errors,
        ),
    )
    producers = [
        threading.Thread(
            target=producer_loop,
            name="fact-producer-{}".format(producer_id),
            args=(
                producer_id,
                producer_count,
                facts,
                attempts_per_producer,
                per_producer_period_ns,
                aggregate_period_ns,
                common_start_ns,
                fact_queue,
                measurements,
            ),
        )
        for producer_id in range(producer_count)
    ]
    writer.start()
    for producer in producers:
        producer.start()
    for producer in producers:
        producer.join()
    producers_done.set()
    writer.join(timeout=max(30.0, duration_seconds * 3.0))
    if writer.is_alive():
        raise RuntimeError("writer did not drain the bounded queue")
    if writer_errors:
        raise writer_errors[0]
    store.close()
    finished_ns = time.perf_counter_ns()
    cpu_finished = time.process_time()
    rss_after = storage.max_rss_mib()
    verification = store.verify()

    accepted = attempted - measurements.dropped
    acknowledged = len(ack_latencies_ns)
    visible = int(verification["visible_count"])
    elapsed_s = max((finished_ns - common_start_ns) / 1_000_000_000.0, 1e-9)
    cpu_seconds = cpu_finished - cpu_started
    enqueue_summary = storage.latency_summary(measurements.enqueue_latencies_ns)
    ack_summary = storage.latency_summary(ack_latencies_ns)
    commit_summary = storage.latency_summary(commit_latencies_ns)
    oldest_summary = storage.latency_summary(oldest_batch_ages_ns)
    scheduling_summary = storage.latency_summary(measurements.producer_schedule_lateness_ns)
    passed = (
        measurements.dropped == 0
        and acknowledged == accepted
        and visible == accepted
        and verification["distinct_sequence_count"] == accepted
        and verification["sqlite_integrity_check"] == "ok"
        and (engine != "hybrid" or verification["index_minus_committed_frames"] == 0)
    )
    return {
        "engine": engine,
        "max_batch_age_ms": max_batch_age_ms,
        "sync_boundary": (
            "SQLite WAL synchronous=FULL transaction commit"
            if engine == "optimized_sqlite"
            else "mmap flush + segment fsync, then SQLite WAL synchronous=FULL index commit"
        ),
        "workload": {
            "duration_seconds_requested": duration_seconds,
            "producer_count": producer_count,
            "aggregate_target_facts_per_second": aggregate_rate,
            "per_producer_target_facts_per_second": per_producer_rate,
            "attempted_facts": attempted,
            "payload_bytes_requested": payload_bytes,
            "batch_size": batch_size,
            "queue_capacity": queue_capacity,
        },
        "result": {
            "elapsed_seconds_from_scheduled_start_through_final_close": round(elapsed_s, 6),
            "attempted": attempted,
            "accepted": accepted,
            "acknowledged": acknowledged,
            "index_visible": visible,
            "producer_queue_drops": measurements.dropped,
            "accepted_but_not_acknowledged": accepted - acknowledged,
            "acknowledged_but_not_visible": acknowledged - visible,
            "actual_persisted_throughput_per_second": round(visible / elapsed_s, 3),
            "max_queue_depth": measurements.max_queue_depth,
            "enqueue_latency_ms": enqueue_summary,
            "end_to_end_commit_visible_ack_latency_ms": ack_summary,
            "storage_commit_latency_per_batch_ms": commit_summary,
            "oldest_record_age_at_batch_ack_ms": oldest_summary,
            "producer_schedule_lateness_ms": scheduling_summary,
            "batches": len(batch_sizes),
            "batch_size_distribution": size_summary(batch_sizes),
            "cpu_seconds": round(cpu_seconds, 6),
            "cpu_percent_of_one_core": round(cpu_seconds / elapsed_s * 100.0, 3),
            "rss_baseline_peak_mib_after_workload_and_store_setup": round(rss_before, 3),
            "rss_process_peak_mib": round(rss_after, 3),
            "rss_peak_delta_mib": round(max(0.0, rss_after - rss_before), 3),
            "disk": storage.disk_usage(root),
            "verification": verification,
            "passed_lossless_integrity_checks": passed,
        },
    }


def segment_capacity_analysis():
    profiles_mib = (512.0, 256.0, 64.0)
    segment_sizes_mib = (4.0, 2.0, 1.0, 0.5)
    rows = []
    for profile_mib in profiles_mib:
        for segment_mib in segment_sizes_mib:
            single_mib = segment_mib
            partitioned_mib = segment_mib * len(PARTITION_NAMES)
            rows.append(
                {
                    "profile_mib": profile_mib,
                    "segment_mib": segment_mib,
                    "single_global_active_segment": {
                        "reserved_mib": single_mib,
                        "percent_of_budget": round(single_mib / profile_mib * 100.0, 4),
                    },
                    "eight_partition_active_segments_worst_case": {
                        "active_segment_count": len(PARTITION_NAMES),
                        "reserved_mib": partitioned_mib,
                        "percent_of_budget": round(partitioned_mib / profile_mib * 100.0, 4),
                        "budget_remaining_mib": profile_mib - partitioned_mib,
                    },
                }
            )
    return {
        "partition_count": len(PARTITION_NAMES),
        "partitions": list(PARTITION_NAMES),
        "assumption": (
            "Worst case physically preallocates one active segment per quota-isolated partition, as the POS design does. "
            "A single mixed append stream reserves only one segment but weakens whole-segment partition eviction."
        ),
        "rows": rows,
        "recommendation": {
            "512_mib_profile": {
                "segment_mib": 4.0,
                "worst_case_active_reserve_mib": 32.0,
                "percent": 6.25,
            },
            "256_mib_profile": {
                "segment_mib": 2.0,
                "worst_case_active_reserve_mib": 16.0,
                "percent": 6.25,
            },
            "64_mib_profile_strict": {
                "segment_mib": 0.5,
                "worst_case_active_reserve_mib": 4.0,
                "percent": 6.25,
            },
            "64_mib_profile_lazy_alternative": {
                "segment_mib": 1.0,
                "condition": "allocate lazily and cap concurrently active partitions at four",
                "four_active_reserve_mib": 4.0,
                "percent": 6.25,
                "eight_active_worst_case_percent": 12.5,
            },
        },
    }


def run_matrix(args):
    temporary = tempfile.mkdtemp(prefix="ai-app-bridge-storage-stream-")
    results = []
    try:
        for engine in ENGINE_NAMES:
            for batch_age in args.batch_ages_ms:
                root = pathlib.Path(temporary) / "{}-{}ms".format(engine, batch_age)
                root.mkdir(parents=True)
                command = [
                    sys.executable,
                    str(pathlib.Path(__file__).resolve()),
                    "--worker",
                    engine,
                    "--root",
                    str(root),
                    "--duration-seconds",
                    str(args.duration_seconds),
                    "--aggregate-rate",
                    str(args.aggregate_rate),
                    "--producer-count",
                    str(args.producer_count),
                    "--queue-capacity",
                    str(args.queue_capacity),
                    "--batch-size",
                    str(args.batch_size),
                    "--max-batch-age-ms",
                    str(batch_age),
                    "--payload-bytes",
                    str(args.payload_bytes),
                ]
                completed = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=max(60.0, args.duration_seconds * 5.0),
                )
                if completed.returncode != 0:
                    raise RuntimeError(
                        "{} {}ms failed (exit {}):\n{}\n{}".format(
                            engine,
                            batch_age,
                            completed.returncode,
                            completed.stdout,
                            completed.stderr,
                        )
                    )
                results.append(json.loads(completed.stdout))
        output = {
            "prototype": True,
            "production_code_modified": False,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "host": {
                "platform": platform.platform(),
                "python": platform.python_version(),
                "sqlite": sqlite3.sqlite_version,
            },
            "matrix": results,
            "validation": {
                "all_runs_lossless_and_integrity_clean": all(
                    row["result"]["passed_lossless_integrity_checks"] for row in results
                ),
                "run_count": len(results),
            },
            "segment_capacity_analysis": segment_capacity_analysis(),
            "limitations": [
                "This is a macOS CPython threading benchmark, not Node Worker/JNI/device code. Python's GIL and scheduler affect enqueue and writer timing.",
                "The producer payload JSON is pre-generated, so capture, redaction, serialization, IPC, and transport costs are outside the timed ingest path.",
                "SQLite uses synchronous=FULL to make the ACK boundary stronger than the current FactCache synchronous=NORMAL setting; results should not be directly mixed with the earlier NORMAL-sync throughput benchmark.",
                "Hybrid ACK flushes and fsyncs the mmap segment before FULL-sync index commit. Python mmap cannot prove the JNI commit marker's atomic release-store semantics.",
                "The OS, SSD, and filesystem may still have hardware-specific power-loss behavior beyond fsync. 'Durable' here means the strongest application-visible flush/commit boundary exercised by this prototype.",
                "Only one writer and one process are measured. Multi-process producer IPC and writer-daemon failover remain separate risks.",
                "The 512/256/64 MiB segment table is arithmetic capacity analysis. Only 4 MiB segments are exercised by this stream benchmark.",
                "Peak RSS is process-level high-water memory above a baseline that already contains the identical pre-generated fact stream and initialized store, including the hybrid's active mmap mapping.",
            ],
        }
        print(json.dumps(output, indent=2, sort_keys=True))
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def parse_batch_ages(value):
    ages = tuple(float(part.strip()) for part in value.split(",") if part.strip())
    if not ages or any(age <= 0 for age in ages):
        raise argparse.ArgumentTypeError("batch ages must be comma-separated positive milliseconds")
    return ages


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", choices=ENGINE_NAMES)
    parser.add_argument("--root")
    parser.add_argument("--duration-seconds", type=float, default=8.0)
    parser.add_argument("--aggregate-rate", type=int, default=1000)
    parser.add_argument("--producer-count", type=int, default=4)
    parser.add_argument("--queue-capacity", type=int, default=2048)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--batch-ages-ms", type=parse_batch_ages, default=DEFAULT_BATCH_AGES_MS)
    parser.add_argument("--max-batch-age-ms", type=float, default=5.0)
    parser.add_argument("--payload-bytes", type=int, default=512)
    args = parser.parse_args(argv)
    if args.worker and not args.root:
        parser.error("--root is required with --worker")
    if args.duration_seconds <= 0 or args.aggregate_rate <= 0 or args.producer_count <= 0:
        parser.error("duration, aggregate rate, and producer count must be positive")
    if args.queue_capacity <= 0 or args.batch_size <= 0 or args.payload_bytes < 0:
        parser.error("queue/batch must be positive; payload bytes cannot be negative")
    if args.max_batch_age_ms <= 0:
        parser.error("max batch age must be positive")
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.worker:
        result = run_stream_worker(
            args.worker,
            args.root,
            args.duration_seconds,
            args.aggregate_rate,
            args.producer_count,
            args.queue_capacity,
            args.batch_size,
            args.max_batch_age_ms,
            args.payload_bytes,
        )
        print(json.dumps(result, sort_keys=True))
    else:
        run_matrix(args)


if __name__ == "__main__":
    main()
