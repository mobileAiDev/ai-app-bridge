#!/usr/bin/env python3
"""Throwaway benchmark for bounded UI-tree history encodings.

This file intentionally lives outside production code. It models a normalized
XML/UI tree with 600 nodes, sampled at 10 Hz for 10 seconds, and compares four
history formats:

1. Full snapshots.
2. Field patches with a full checkpoint every 20 ticks.
3. Content-addressed immutable chunks of 20 nodes.
4. Exact semantic changes plus a lossy render-animation burst summary.

The fourth format preserves every semantic transition, the exact final state,
and verifiable animation presence/extrema. It deliberately does not preserve
exact intermediate bounds/alpha/transform values.

Only Python's standard library is used. Results are deterministic for a fixed
seed. "Compressed bytes" means zlib level 6 over the complete encoded stream;
it is an upper-bound comparison, not a proposed on-disk framing decision.
Memory numbers are peak additional Python allocations reported by tracemalloc;
they exclude the already-built input states, native allocator overhead, and OS
page cache.
"""

from __future__ import annotations

import argparse
import copy
import gc
import hashlib
import io
import json
import random
import statistics
import time
import tracemalloc
import zlib
from collections.abc import Callable, Iterable, Iterator
from typing import Any


NODE_COUNT = 600
SAMPLE_HZ = 10
DURATION_SECONDS = 10
TICK_COUNT = SAMPLE_HZ * DURATION_SECONDS
CHECKPOINT_INTERVAL = 20
CHUNK_SIZE = 20
DEFAULT_SEED = 20260830
CHANGE_COUNTS = (1, 10, 100, 600)
SEMANTIC_FIELDS = ("text", "visible", "enabled", "checked", "focused")
RENDER_FIELDS = ("bounds", "alpha", "transform")

Node = dict[str, Any]
State = list[Node]
Encoder = Callable[[list[State]], bytes]
Decoder = Callable[[bytes], Iterator[State]]


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def encode_json_lines(records: Iterable[dict[str, Any]]) -> bytes:
    output = bytearray()
    for record in records:
        output.extend(canonical_bytes(record))
        output.append(10)
    return bytes(output)


def json_line_records(payload: bytes) -> Iterator[dict[str, Any]]:
    with io.BytesIO(payload) as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def make_initial_state(seed: int) -> State:
    rng = random.Random(seed)
    roles = ("container", "text", "button", "input", "checkbox", "image")
    state: State = []
    for index in range(NODE_COUNT):
        parent_index = (index - 1) // 4 if index else None
        x = (index % 6) * 180
        y = ((index // 6) % 20) * 72
        state.append(
            {
                "id": f"node-{index:03d}",
                "parent": None if parent_index is None else f"node-{parent_index:03d}",
                "role": roles[index % len(roles)],
                "semantic": {
                    "text": f"label-{index:03d}-v0",
                    "visible": True,
                    "enabled": rng.random() > 0.08,
                    "checked": index % 11 == 0,
                    "focused": index == 3,
                },
                "render": {
                    "bounds": [x, y, 160 + index % 3, 56 + index % 5],
                    "alpha": 1000,
                    "transform": [0, 0, 1000],
                },
            }
        )
    return state


def mutate_semantic(node: Node, index: int, tick: int) -> None:
    semantic = node["semantic"]
    field = SEMANTIC_FIELDS[(tick + index) % len(SEMANTIC_FIELDS)]
    if field == "text":
        semantic[field] = f"label-{index:03d}-v{tick}"
    else:
        semantic[field] = not semantic[field]


def mutate_render(node: Node, index: int, tick: int) -> None:
    render = node["render"]
    direction = 1 if (tick + index) % 2 == 0 else -1
    old_bounds = render["bounds"]
    render["bounds"] = [
        old_bounds[0] + direction * (1 + tick % 3),
        old_bounds[1] - direction * (1 + index % 2),
        old_bounds[2] + direction,
        old_bounds[3] - direction,
    ]
    render["alpha"] = 650 + ((tick * 37 + index * 11) % 351)
    render["transform"] = [
        ((tick * 3 + index) % 17) - 8,
        ((tick * 5 + index * 2) % 19) - 9,
        970 + ((tick * 7 + index) % 61),
    ]


def make_states(change_kind: str, change_count: int, seed: int) -> list[State]:
    current = make_initial_state(seed)
    states = [copy.deepcopy(current)]
    scenario_seed = seed + change_count * 1009 + (1 if change_kind == "render" else 0)
    rng = random.Random(scenario_seed)
    for tick in range(1, TICK_COUNT + 1):
        selected = rng.sample(range(NODE_COUNT), change_count)
        for index in selected:
            if change_kind == "semantic":
                mutate_semantic(current[index], index, tick)
            else:
                mutate_render(current[index], index, tick)
        states.append(copy.deepcopy(current))
    return states


def changed_fields(before: Node, after: Node, groups: tuple[str, ...]) -> dict[str, Any]:
    change: dict[str, Any] = {}
    for group in groups:
        group_change = {
            field: after[group][field]
            for field in after[group]
            if before[group][field] != after[group][field]
        }
        if group_change:
            change[group] = group_change
    return change


def apply_changes(node: Node, changes: dict[str, Any]) -> None:
    for group, group_changes in changes.items():
        node[group].update(group_changes)


def encode_full(states: list[State]) -> bytes:
    return encode_json_lines(
        {"type": "snapshot", "tick": tick, "nodes": state}
        for tick, state in enumerate(states)
    )


def decode_full(payload: bytes) -> Iterator[State]:
    for record in json_line_records(payload):
        yield record["nodes"]


def encode_patch(states: list[State]) -> bytes:
    def records() -> Iterator[dict[str, Any]]:
        for tick, state in enumerate(states):
            if tick % CHECKPOINT_INTERVAL == 0:
                yield {"type": "checkpoint", "tick": tick, "nodes": state}
                continue
            before = states[tick - 1]
            changes = []
            for index, (old_node, new_node) in enumerate(zip(before, state)):
                change = changed_fields(old_node, new_node, ("semantic", "render"))
                if change:
                    changes.append([index, change])
            yield {"type": "patch", "tick": tick, "changes": changes}

    return encode_json_lines(records())


def decode_patch(payload: bytes) -> Iterator[State]:
    current: State | None = None
    for record in json_line_records(payload):
        if record["type"] == "checkpoint":
            current = record["nodes"]
        else:
            if current is None:
                raise ValueError("patch before checkpoint")
            for index, changes in record["changes"]:
                apply_changes(current[index], changes)
        if current is None:
            raise ValueError("missing checkpoint")
        yield current


def encode_chunks(states: list[State]) -> bytes:
    def records() -> Iterator[dict[str, Any]]:
        known_hashes: set[str] = set()
        for tick, state in enumerate(states):
            manifest = []
            for start in range(0, len(state), CHUNK_SIZE):
                nodes = state[start : start + CHUNK_SIZE]
                serialized = canonical_bytes(nodes)
                content_hash = hashlib.blake2b(serialized, digest_size=16).hexdigest()
                manifest.append(content_hash)
                if content_hash not in known_hashes:
                    known_hashes.add(content_hash)
                    yield {"type": "chunk", "hash": content_hash, "nodes": nodes}
            yield {"type": "manifest", "tick": tick, "chunks": manifest}

    return encode_json_lines(records())


def decode_chunks(payload: bytes) -> Iterator[State]:
    chunks: dict[str, State] = {}
    for record in json_line_records(payload):
        if record["type"] == "chunk":
            chunks[record["hash"]] = record["nodes"]
            continue
        state: State = []
        for content_hash in record["chunks"]:
            state.extend(chunks[content_hash])
        yield state


def value_min(left: Any, right: Any) -> Any:
    if isinstance(left, list):
        return [min(a, b) for a, b in zip(left, right)]
    return min(left, right)


def value_max(left: Any, right: Any) -> Any:
    if isinstance(left, list):
        return [max(a, b) for a, b in zip(left, right)]
    return max(left, right)


def summarize_render(states: list[State]) -> dict[str, Any]:
    bursts: dict[str, Any] = {}
    for tick in range(1, len(states)):
        before = states[tick - 1]
        after = states[tick]
        for index, (old_node, new_node) in enumerate(zip(before, after)):
            changed = [
                field
                for field in RENDER_FIELDS
                if old_node["render"][field] != new_node["render"][field]
            ]
            if not changed:
                continue
            key = str(index)
            burst = bursts.setdefault(
                key,
                {
                    "first_tick": tick,
                    "last_tick": tick,
                    "sample_count": 0,
                    "fields": {},
                },
            )
            burst["last_tick"] = tick
            burst["sample_count"] += 1
            for field in changed:
                old_value = old_node["render"][field]
                new_value = new_node["render"][field]
                summary = burst["fields"].setdefault(
                    field,
                    {
                        "first_tick": tick,
                        "last_tick": tick,
                        "sample_count": 0,
                        "min": copy.deepcopy(old_value),
                        "max": copy.deepcopy(old_value),
                        "final": copy.deepcopy(new_value),
                    },
                )
                summary["last_tick"] = tick
                summary["sample_count"] += 1
                summary["min"] = value_min(summary["min"], new_value)
                summary["max"] = value_max(summary["max"], new_value)
                summary["final"] = copy.deepcopy(new_value)
    return bursts


def encode_semantic_render_summary(states: list[State]) -> bytes:
    semantic_records = []
    for tick in range(1, len(states)):
        changes = []
        for index, (old_node, new_node) in enumerate(
            zip(states[tick - 1], states[tick])
        ):
            change = changed_fields(old_node, new_node, ("semantic",))
            if change:
                changes.append([index, change["semantic"]])
        semantic_records.append({"type": "semantic", "tick": tick, "changes": changes})

    bursts = summarize_render(states)
    final_render = [
        [int(index), states[-1][int(index)]["render"]]
        for index in sorted(bursts, key=int)
    ]
    records: list[dict[str, Any]] = [
        {
            "type": "base",
            "ticks": len(states) - 1,
            "nodes": states[0],
        },
        {
            "type": "render_summary",
            "policy": "intermediate_render_values_are_lossy",
            "bursts": bursts,
            "final_render": final_render,
        },
    ]
    records.extend(semantic_records)
    return encode_json_lines(records)


def decode_semantic_render_summary(payload: bytes) -> Iterator[State]:
    base: State | None = None
    ticks: int | None = None
    final_render: list[list[Any]] = []
    semantic_by_tick: dict[int, list[list[Any]]] = {}
    for record in json_line_records(payload):
        record_type = record["type"]
        if record_type == "base":
            base = record["nodes"]
            ticks = record["ticks"]
        elif record_type == "render_summary":
            final_render = record["final_render"]
        else:
            semantic_by_tick[record["tick"]] = record["changes"]

    if base is None or ticks is None:
        raise ValueError("missing base record")
    current = base
    yield current
    for tick in range(1, ticks + 1):
        for index, changes in semantic_by_tick.get(tick, []):
            current[index]["semantic"].update(changes)
        if tick == ticks:
            for index, render in final_render:
                current[index]["render"] = render
        yield current


SCHEMES: tuple[tuple[str, Encoder, Decoder, str], ...] = (
    ("full", encode_full, decode_full, "lossless"),
    ("patch", encode_patch, decode_patch, "lossless"),
    ("chunks", encode_chunks, decode_chunks, "lossless"),
    (
        "semantic+render-burst",
        encode_semantic_render_summary,
        decode_semantic_render_summary,
        "semantic_exact_render_intermediate_lossy",
    ),
)


def consume(decoder: Decoder, payload: bytes) -> tuple[int, int]:
    state_count = 0
    node_visits = 0
    for state in decoder(payload):
        state_count += 1
        node_visits += len(state)
    return state_count, node_visits


def median_cpu_ms(function: Callable[[], Any], repeats: int) -> tuple[float, Any]:
    samples = []
    result: Any = None
    for _ in range(repeats):
        gc.collect()
        start = time.process_time_ns()
        result = function()
        samples.append((time.process_time_ns() - start) / 1_000_000)
    return statistics.median(samples), result


def additional_python_peak(function: Callable[[], Any]) -> int:
    gc.collect()
    tracemalloc.start()
    result = function()
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    del result
    return peak


def state_digest(state: State) -> str:
    return hashlib.sha256(canonical_bytes(state)).hexdigest()


def semantic_digest(state: State) -> str:
    projection = [[node["id"], node["semantic"]] for node in state]
    return hashlib.sha256(canonical_bytes(projection)).hexdigest()


def verify_reconstruction(
    decoder: Decoder,
    payload: bytes,
    truth: list[State],
) -> dict[str, Any]:
    reconstructed = decoder(payload)
    exact_steps = True
    semantic_steps = True
    final_exact = False
    count = 0
    for tick, state in enumerate(reconstructed):
        if tick >= len(truth):
            exact_steps = False
            semantic_steps = False
            count += 1
            continue
        exact = state_digest(state) == state_digest(truth[tick])
        semantic_exact = semantic_digest(state) == semantic_digest(truth[tick])
        exact_steps = exact_steps and exact
        semantic_steps = semantic_steps and semantic_exact
        final_exact = tick == len(truth) - 1 and exact
        count += 1
    if count != len(truth):
        exact_steps = False
        semantic_steps = False
        final_exact = False
    return {
        "reconstructed_states": count,
        "all_steps_exact": exact_steps,
        "semantic_steps_exact": semantic_steps,
        "final_state_exact": final_exact,
    }


def render_summary_from_payload(payload: bytes) -> dict[str, Any] | None:
    for record in json_line_records(payload):
        if record["type"] == "render_summary":
            return record["bursts"]
    return None


def inspect_format(name: str, payload: bytes) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in json_line_records(payload):
        record_type = record["type"]
        counts[record_type] = counts.get(record_type, 0) + 1
        if record_type == "render_summary":
            counts["burst_nodes"] = len(record["bursts"])
    if name == "chunks":
        counts["chunk_size"] = CHUNK_SIZE
    if name == "patch":
        counts["checkpoint_interval"] = CHECKPOINT_INTERVAL
    return counts


def benchmark_scheme(
    name: str,
    encoder: Encoder,
    decoder: Decoder,
    policy: str,
    states: list[State],
    change_kind: str,
    change_count: int,
    repeats: int,
) -> dict[str, Any]:
    encode_cpu_ms, payload = median_cpu_ms(lambda: encoder(states), repeats)
    decode_cpu_ms, _ = median_cpu_ms(lambda: consume(decoder, payload), repeats)
    encode_peak = additional_python_peak(lambda: encoder(states))
    decode_peak = additional_python_peak(lambda: consume(decoder, payload))
    verification = verify_reconstruction(decoder, payload, states)

    expected_bursts = summarize_render(states)
    stored_bursts = render_summary_from_payload(payload)
    if stored_bursts is None:
        animation_signal_correct = verification["all_steps_exact"]
        recorded_animation_nodes = len(expected_bursts) if animation_signal_correct else 0
    else:
        animation_signal_correct = stored_bursts == expected_bursts
        recorded_animation_nodes = len(stored_bursts)

    return {
        "workload": change_kind,
        "changed_nodes_per_tick": change_count,
        "scheme": name,
        "intermediate_render_policy": policy,
        "raw_bytes": len(payload),
        "zlib_level_6_bytes": len(zlib.compress(payload, level=6)),
        "encode_cpu_ms": round(encode_cpu_ms, 3),
        "reconstruct_cpu_ms": round(decode_cpu_ms, 3),
        "encode_additional_python_peak_bytes": encode_peak,
        "reconstruct_additional_python_peak_bytes": decode_peak,
        "actual_animation_nodes": len(expected_bursts),
        "recorded_animation_nodes": recorded_animation_nodes,
        "animation_signal_correct": animation_signal_correct,
        "format_stats": inspect_format(name, payload),
        **verification,
    }


def render_table(results: list[dict[str, Any]]) -> str:
    headers = (
        "workload",
        "chg",
        "scheme",
        "raw KiB",
        "zlib KiB",
        "enc ms",
        "dec ms",
        "enc peak MiB",
        "dec peak MiB",
        "final",
        "steps",
        "semantic",
        "anim",
    )
    rows = []
    for result in results:
        rows.append(
            (
                result["workload"],
                str(result["changed_nodes_per_tick"]),
                result["scheme"],
                f'{result["raw_bytes"] / 1024:.1f}',
                f'{result["zlib_level_6_bytes"] / 1024:.1f}',
                f'{result["encode_cpu_ms"]:.1f}',
                f'{result["reconstruct_cpu_ms"]:.1f}',
                f'{result["encode_additional_python_peak_bytes"] / 1024 / 1024:.1f}',
                f'{result["reconstruct_additional_python_peak_bytes"] / 1024 / 1024:.1f}',
                "Y" if result["final_state_exact"] else "N",
                "Y" if result["all_steps_exact"] else "N",
                "Y" if result["semantic_steps_exact"] else "N",
                "Y" if result["animation_signal_correct"] else "N",
            )
        )
    widths = [
        max(len(headers[index]), *(len(row[index]) for row in rows))
        for index in range(len(headers))
    ]

    def format_row(row: tuple[str, ...]) -> str:
        return " | ".join(value.ljust(widths[index]) for index, value in enumerate(row))

    separator = "-+-".join("-" * width for width in widths)
    return "\n".join((format_row(headers), separator, *(format_row(row) for row in rows)))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--format", choices=("table", "json", "both"), default="both")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.repeats < 1:
        raise SystemExit("--repeats must be at least 1")

    results: list[dict[str, Any]] = []
    for change_kind in ("semantic", "render"):
        for change_count in CHANGE_COUNTS:
            states = make_states(change_kind, change_count, args.seed)
            for name, encoder, decoder, policy in SCHEMES:
                results.append(
                    benchmark_scheme(
                        name,
                        encoder,
                        decoder,
                        policy,
                        states,
                        change_kind,
                        change_count,
                        args.repeats,
                    )
                )
            del states
            gc.collect()

    report = {
        "benchmark": "throwaway-ui-history-encoding",
        "seed": args.seed,
        "node_count": NODE_COUNT,
        "sample_hz": SAMPLE_HZ,
        "duration_seconds": DURATION_SECONDS,
        "ticks_after_baseline": TICK_COUNT,
        "state_count": TICK_COUNT + 1,
        "change_counts": list(CHANGE_COUNTS),
        "patch_checkpoint_interval": CHECKPOINT_INTERVAL,
        "content_addressed_chunk_size": CHUNK_SIZE,
        "compressed_size_definition": "zlib level 6 over the complete encoded stream",
        "memory_definition": (
            "tracemalloc peak additional Python allocations; excludes prebuilt input states, "
            "native allocations, and OS page cache"
        ),
        "results": results,
    }

    if args.format in ("table", "both"):
        print(render_table(results))
    if args.format == "both":
        print("\nJSON_RESULT")
    if args.format in ("json", "both"):
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
