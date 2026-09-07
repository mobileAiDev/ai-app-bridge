package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONObject
import java.util.ArrayDeque
import java.util.LinkedHashMap

internal class BoundedMemoryCaptureBackend(
    private val budgets: ByteBudgets,
    private val caps: CountCaps,
) : CaptureBackend {
    private var generation = 1L
    private var sequence = 0L
    private val streams = listOf("logs", "network", "events", "state").associateWith { StreamBuffer(it) }

    override fun append(record: CaptureInput, durability: String): AppendReceipt {
        val stream = streams[record.stream] ?: return AppendReceipt(
            status = "dropped",
            accepted = false,
            committed = false,
            dropped = true,
            deduplicated = false,
            mobileFactId = null,
            reason = "unknown_stream",
        )
        val identity = "${record.targetKey}|${record.runtimeEpoch}|${record.stream}|${record.captureId}"
        if (stream.factId(identity) != null) {
            return AppendReceipt(
                status = "volatile",
                accepted = true,
                committed = false,
                dropped = false,
                deduplicated = true,
                mobileFactId = null,
            )
        }
        val bytes = record.record.toString().toByteArray(Charsets.UTF_8)
        sequence += 1
        val factId = "mf1:$generation:$sequence:${hashPrefix(bytes)}"
        val stored = stream.append(
            StoredFact(
                identity = identity,
                stream = record.stream,
                stateKey = record.stateKey,
                captureId = record.captureId,
                timestampMs = record.timestampMs,
                actionId = record.actionId,
                bytes = bytes,
                mobileFactId = factId,
                globalSequence = sequence,
            ),
        )
        if (!stored) {
            sequence -= 1
            stream.gap = true
            stream.dropped += 1
            return AppendReceipt(
                status = "dropped",
                accepted = false,
                committed = false,
                dropped = true,
                deduplicated = false,
                mobileFactId = null,
                reason = "queue-full",
            )
        }
        stream.ids[identity] = factId
        return AppendReceipt(
            status = "volatile",
            accepted = true,
            committed = false,
            dropped = false,
            deduplicated = false,
            mobileFactId = null,
        )
    }

    override fun mark(names: List<String>): CaptureWatermark {
        val marked = linkedMapOf<String, Long>()
        for (name in names) {
            val last = streams[name]?.facts?.lastOrNull()?.captureId ?: 0L
            marked[name] = last
        }
        return CaptureWatermark(marked)
    }

    override fun query(query: CaptureQuery): CapturePage {
        val stream = streams[query.stream]
            ?: return CapturePage(
                ok = false,
                type = query.stream,
                items = emptyList(),
                count = 0,
                coverage = CaptureCoverage("unavailable", gap = true, committed = false),
                gap = true,
                hasMore = false,
                refs = emptyList(),
            )
        val filtered = stream.visible().filter { fact ->
            if (query.sinceId != null && fact.captureId <= query.sinceId) return@filter false
            if (query.sinceMs != null && fact.timestampMs < query.sinceMs) return@filter false
            if (query.view == "decision-window" && query.afterActionId != null && fact.actionId != query.afterActionId) {
                return@filter false
            }
            true
        }
        val limit = resolveLimit(query)
        val limited = if (filtered.size > limit) filtered.takeLast(limit) else filtered
        val items = limited.map { JSONObject(String(it.bytes, Charsets.UTF_8)) }
        val refs = emptyList<CaptureFactRef>()
        val values = if (query.stream == "state") {
            limited.associate { fact ->
                val parsed = JSONObject(String(fact.bytes, Charsets.UTF_8))
                (fact.stateKey ?: parsed.optString("stateKey")) to parsed.opt("value")
            }
        } else {
            emptyMap()
        }
        val gap = stream.gap
        return CapturePage(
            ok = true,
            type = query.stream,
            items = items,
            count = items.size,
            coverage = CaptureCoverage(if (gap) "partial" else "unavailable", gap = gap, committed = false),
            gap = gap,
            hasMore = filtered.size > limited.size,
            refs = refs,
            values = values,
        )
    }

    override fun status(): CaptureStoreStatus {
        val streamStatus = streams.mapValues { (_, stream) ->
            StreamStatus(
                count = stream.visible().size,
                ownedBytes = stream.ownedBytes,
                dropped = stream.dropped,
                gap = stream.gap,
            )
        }
        return CaptureStoreStatus(
            persistent = false,
            generation = generation,
            ownedBytes = streamStatus.values.sumOf { it.ownedBytes },
            budgetBytes = budgets.total().toLong(),
            dropped = streamStatus.values.sumOf { it.dropped },
            streams = streamStatus,
        )
    }

    override fun clear(scope: String): ClearReceipt {
        if (scope == "all") {
            streams.values.forEach { it.clear() }
        } else {
            streams[scope]?.clear()
        }
        generation += 1
        return ClearReceipt(ok = true, generation = generation)
    }

    private fun resolveLimit(query: CaptureQuery): Int {
        return (query.limit ?: 200).coerceAtLeast(1)
    }

    private inner class StreamBuffer(private val name: String) {
        val facts = ArrayDeque<StoredFact>()
        val ids = mutableMapOf<String, String>()
        val stateOrder = LinkedHashMap<String, StoredFact>(16, 0.75f, true)
        var ownedBytes = 0L
        var dropped = 0L
        var gap = false

        fun append(fact: StoredFact): Boolean {
            if (fact.bytes.size > budgets.forStream(name)) return false
            if (name == "state") {
                val key = fact.stateKey ?: return false
                val existing = stateOrder.remove(key)
                if (existing != null) {
                    facts.remove(existing)
                    ownedBytes -= existing.bytes.size
                    ids.remove(existing.identity)
                }
            }
            evictWhileNeeded(fact.bytes.size)
            if (facts.size >= caps.forStream(name) || ownedBytes + fact.bytes.size > budgets.forStream(name)) {
                return false
            }
            facts.addLast(fact)
            ownedBytes += fact.bytes.size
            if (name == "state" && fact.stateKey != null) {
                stateOrder[fact.stateKey] = fact
            }
            return true
        }

        fun visible(): List<StoredFact> {
            return if (name == "state") stateOrder.values.toList() else facts.toList()
        }

        fun factId(identity: String): String? = ids[identity]

        fun clear() {
            facts.clear()
            ids.clear()
            stateOrder.clear()
            ownedBytes = 0
            dropped = 0
            gap = false
        }

        private fun evictWhileNeeded(incoming: Int) {
            val budget = budgets.forStream(name)
            val cap = caps.forStream(name)
            while (facts.isNotEmpty() && (facts.size >= cap || ownedBytes + incoming > budget)) {
                evictOldest()
            }
        }

        private fun evictOldest() {
            gap = true
            dropped += 1
            if (name == "state") {
                val eldest = stateOrder.entries.firstOrNull() ?: return
                stateOrder.remove(eldest.key)
                facts.remove(eldest.value)
                ownedBytes -= eldest.value.bytes.size
                ids.remove(eldest.value.identity)
                return
            }
            val first = facts.removeFirst()
            ownedBytes -= first.bytes.size
            ids.remove(first.identity)
        }
    }
}

internal class StoredFact(
    val identity: String,
    val stream: String,
    val stateKey: String?,
    val captureId: Long,
    val timestampMs: Long,
    val actionId: String?,
    val bytes: ByteArray,
    var mobileFactId: String? = null,
    var globalSequence: Long = 0,
)

internal fun hashPrefix(bytes: ByteArray): String {
    var hash = 0x811c9dc5.toInt()
    for (byte in bytes) {
        hash = hash xor (byte.toInt() and 0xff)
        hash *= 16777619
    }
    return String.format("%08x", hash)
}
