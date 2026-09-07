package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.SegmentedFactRecordEnqueueResult
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStore
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreCursor
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreDurability
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreReadResult
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreRecord
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreResultCode
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class FactReceipt(
    val status: String,
    val accepted: Boolean,
    val committed: Boolean,
    val storeGeneration: Long,
    val mobileFactId: String?,
    val globalSequence: Long?,
)

data class FactCursor(
    val storeGeneration: Long,
    val afterSequence: Long = 0,
)

data class FactPageItem(
    val mobileFactId: String,
    val payload: ByteArray,
    val partitionId: Int,
    val globalSequence: Long,
    val committed: Boolean,
)

data class FactPage(
    val items: List<FactPageItem>,
    val storeGeneration: Long,
    val generationMismatch: Boolean = false,
)

data class DrainResult(
    val ok: Boolean,
    val committed: Int,
)

data class ThroughWatermark(
    val throughSequence: Long,
    val storeGeneration: Long,
)

internal class FactStoreReceiptPort(
    private val store: SegmentedFactStore,
    private val directory: File,
) {
    private val lock = Any()
    private val pending = LinkedHashMap<String, PendingFact>()
    private val aliases = LinkedHashMap<String, String>()
    private val dropped = LinkedHashSet<String>()
    private val index = LinkedHashMap<String, IndexEntry>()
    private var generation = 1L
    private var sequence = 0L
    private var generationFloor = 0L
    private var storeHighWater = 0L
    private val sidecar: File = File(directory, SIDECAR_NAME)

    init {
        directory.mkdirs()
        loadSidecar()
        hydrateFromStore()
        storeHighWater = index.values.maxOfOrNull { it.globalSequence } ?: 0L
    }

    fun appendWithReceipt(
        payload: ByteArray,
        partitionId: Int = 0,
        durability: String = "async",
    ): FactReceipt {
        val enqueue = store.recordForReceipt(payload, partitionId, durabilityOf(durability))
        if (enqueue != SegmentedFactRecordEnqueueResult.ACCEPTED) {
            return receiptOf(enqueue)
        }
        synchronized(lock) {
            sequence += 1
            val mobileFactId = "mf1:$generation:$sequence:${hashPrefix(payload)}"
            pending[mobileFactId] = PendingFact(mobileFactId, payload.copyOf(), partitionId, sequence)
            return FactReceipt(
                status = "accepted",
                accepted = true,
                committed = false,
                storeGeneration = generation,
                mobileFactId = mobileFactId,
                globalSequence = null,
            )
        }
    }

    fun commitWait(mobileFactId: String, timeoutMs: Long): FactReceipt {
        if (!drainWriter(timeoutMs)) {
            synchronized(lock) {
                return receiptAfterWait(mobileFactId, drained = false)
            }
        }
        promoteCommitted(markUnmatchedDropped = true)
        synchronized(lock) {
            return receiptAfterWait(mobileFactId, drained = true)
        }
    }

    fun readPage(cursor: FactCursor, limit: Int): FactPage {
        synchronized(lock) {
            if (cursor.storeGeneration != generation) {
                return FactPage(emptyList(), generation, generationMismatch = true)
            }
            val items = ArrayList<FactPageItem>(limit)
            for (entry in index.values) {
                if (entry.globalSequence <= cursor.afterSequence) continue
                if (items.size == limit) break
                items.add(entry.toItem())
            }
            for (held in pending.values) {
                if (items.size == limit) break
                items.add(held.toItem())
            }
            return FactPage(items, generation)
        }
    }

    fun flushDrain(timeoutMs: Long): DrainResult {
        if (!awaitFlush(timeoutMs)) return DrainResult(ok = false, committed = 0)
        val before: Int
        synchronized(lock) { before = index.size }
        promoteCommitted(markUnmatchedDropped = true)
        val after: Int
        synchronized(lock) { after = index.size }
        return DrainResult(ok = true, committed = after - before)
    }

    fun clear(): Long {
        val floor = readAllStoreRecords().maxOfOrNull { it.sequence } ?: 0L
        store.takeReceiptOutcomes()
        synchronized(lock) {
            generation += 1
            sequence = 0
            generationFloor = maxOf(generationFloor, floor)
            storeHighWater = maxOf(storeHighWater, generationFloor)
            pending.clear()
            aliases.clear()
            dropped.clear()
            index.clear()
            appendSidecarLine(
                JSONObject()
                    .put("op", "clear")
                    .put("generation", generation)
                    .put("throughSequence", generationFloor)
                    .toString() + "\n",
            )
            return generation
        }
    }

    fun storeGeneration(): Long = synchronized(lock) { generation }

    fun throughWatermark(): ThroughWatermark = synchronized(lock) {
        ThroughWatermark(
            throughSequence = index.values.maxOfOrNull { it.globalSequence } ?: 0L,
            storeGeneration = generation,
        )
    }

    private fun receiptAfterWait(mobileFactId: String, drained: Boolean): FactReceipt {
        if (dropped.contains(mobileFactId)) {
            return dropped(mobileFactId, generation)
        }
        pending[mobileFactId]?.let { return it.toReceipt(generation) }
        aliases[mobileFactId]?.let { aliased -> index[aliased]?.let { return it.toReceipt(generation) } }
        index[mobileFactId]?.let { return it.toReceipt(generation) }
        if (drained) {
            return dropped(mobileFactId, generation)
        }
        return dropped(mobileFactId, generation)
    }

    private fun promoteCommitted(markUnmatchedDropped: Boolean) {
        val records = readAllStoreRecords()
        val outcomes = store.takeReceiptOutcomes()
        synchronized(lock) {
            val taken = index.values.map { it.globalSequence }.toMutableSet()
            val fresh = records
                .filter { record -> record.sequence > generationFloor && record.sequence !in taken }
                .sortedBy { it.sequence }
            val successCount = outcomes.count { it }
            val newlyWritten = if (successCount == 0) emptyList() else fresh.takeLast(successCount)
            val preexisting = if (successCount == 0) fresh else fresh.dropLast(successCount)
            val remaining = LinkedHashMap(pending)
            val promoted = ArrayList<IndexEntry>()
            for (record in preexisting) {
                promoted.add(commitStoreRecord(record, null))
            }
            var writtenIndex = 0
            var outcomeIndex = 0
            for (id in pending.keys.toList()) {
                if (!remaining.containsKey(id)) continue
                if (outcomeIndex >= outcomes.size) break
                val success = outcomes[outcomeIndex]
                outcomeIndex += 1
                remaining.remove(id)
                if (!success) {
                    if (markUnmatchedDropped) dropped.add(id)
                    else remaining[id] = pending[id]!!
                    continue
                }
                if (writtenIndex >= newlyWritten.size) {
                    if (markUnmatchedDropped) dropped.add(id)
                    continue
                }
                val record = newlyWritten[writtenIndex]
                writtenIndex += 1
                promoted.add(commitStoreRecord(record, id))
            }
            while (writtenIndex < newlyWritten.size) {
                promoted.add(commitStoreRecord(newlyWritten[writtenIndex], null))
                writtenIndex += 1
            }
            if (markUnmatchedDropped) {
                for (id in remaining.keys) {
                    dropped.add(id)
                }
                remaining.clear()
            }
            pending.clear()
            pending.putAll(remaining)
            storeHighWater = maxOf(
                storeHighWater,
                promoted.maxOfOrNull { it.globalSequence } ?: 0L,
            )
            for (entry in promoted) {
                appendSidecarLine(entry.toJson().toString() + "\n")
            }
        }
    }

    private fun commitStoreRecord(record: SegmentedFactStoreRecord, acceptId: String?): IndexEntry {
        val hash = hashPrefix(record.payload)
        val committedId = "mf1:$generation:${record.sequence}:$hash"
        if (acceptId != null && acceptId != committedId) {
            aliases[acceptId] = committedId
        }
        val entry = IndexEntry(
            committedId,
            record.payload.copyOf(),
            record.partitionId,
            record.sequence,
            generation,
        )
        index[committedId] = entry
        return entry
    }

    private fun appendSidecarLine(line: String) {
        if (sidecar.isFile && sidecar.length() > 0L) {
            RandomAccessFile(sidecar, "rw").use { raf ->
                raf.seek(raf.length() - 1)
                if (raf.read() != '\n'.code) {
                    raf.write('\n'.code)
                }
            }
        }
        sidecar.appendText(line)
    }

    private fun readAllStoreRecords(): List<SegmentedFactStoreRecord> {
        val records = ArrayList<SegmentedFactStoreRecord>()
        var cursor = SegmentedFactStoreCursor()
        while (true) {
            val page = awaitRead(cursor) ?: break
            val record = page.record
            if (page.isEnd || record == null) break
            records.add(record)
            cursor = page.cursor
        }
        return records
    }

    private fun drainWriter(timeoutMs: Long): Boolean {
        val latch = CountDownLatch(1)
        store.status { latch.countDown() }
        return latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    private fun awaitFlush(timeoutMs: Long): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        store.flush {
            ok = it.isSuccess
            latch.countDown()
        }
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) return false
        return ok
    }

    private fun awaitRead(cursor: SegmentedFactStoreCursor): SegmentedFactStoreReadResult? {
        var capacity = 64 * 1024
        repeat(2) {
            val page = awaitReadOnce(cursor, capacity) ?: return null
            if (page.operation.code != SegmentedFactStoreResultCode.BUFFER_TOO_SMALL) return page
            if (page.requiredCapacity <= capacity) return page
            capacity = page.requiredCapacity
        }
        return awaitReadOnce(cursor, capacity)
    }

    private fun awaitReadOnce(
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int,
    ): SegmentedFactStoreReadResult? {
        val latch = CountDownLatch(1)
        var value: SegmentedFactStoreReadResult? = null
        store.read(cursor, bufferCapacity) {
            value = it
            latch.countDown()
        }
        if (!latch.await(5, TimeUnit.SECONDS)) return null
        return value
    }

    private fun loadSidecar() {
        if (!sidecar.isFile) return
        sidecar.useLines { lines ->
            for (line in lines) {
                if (line.isEmpty()) continue
                val row = try {
                    JSONObject(line)
                } catch (_: Exception) {
                    continue
                }
                if (row.optString("op") == "clear") {
                    generation = row.getLong("generation")
                    sequence = 0
                    generationFloor = maxOf(generationFloor, row.optLong("throughSequence", 0L))
                    index.clear()
                    continue
                }
                val entry = IndexEntry(
                    mobileFactId = row.getString("mobileFactId"),
                    payload = ByteArray(0),
                    partitionId = row.getInt("partitionId"),
                    globalSequence = row.getLong("globalSequence"),
                    generation = row.getLong("generation"),
                )
                if (entry.generation == generation) {
                    index[entry.mobileFactId] = entry
                    sequence = maxOf(sequence, entry.localSequence())
                }
            }
        }
    }

    private fun hydrateFromStore() {
        if (index.isEmpty()) return
        val records = readAllStoreRecords()
        synchronized(lock) {
            val bySequence = records.associateBy { it.sequence }
            val hydrated = LinkedHashMap<String, IndexEntry>()
            for ((id, entry) in index) {
                val record = bySequence[entry.globalSequence] ?: continue
                if (hashPrefix(record.payload) != hashFromId(id)) continue
                hydrated[id] = IndexEntry(
                    mobileFactId = entry.mobileFactId,
                    payload = record.payload.copyOf(),
                    partitionId = record.partitionId,
                    globalSequence = record.sequence,
                    generation = entry.generation,
                )
            }
            index.clear()
            index.putAll(hydrated)
        }
    }

    private fun receiptOf(enqueue: SegmentedFactRecordEnqueueResult): FactReceipt {
        val status = when (enqueue) {
            SegmentedFactRecordEnqueueResult.QUEUE_FULL -> "queue-full"
            SegmentedFactRecordEnqueueResult.CLOSED -> "closed"
            SegmentedFactRecordEnqueueResult.DISABLED -> "disabled"
            SegmentedFactRecordEnqueueResult.PAYLOAD_TOO_LARGE -> "payload-too-large"
            SegmentedFactRecordEnqueueResult.ACCEPTED -> "accepted"
        }
        return FactReceipt(
            status = status,
            accepted = false,
            committed = false,
            storeGeneration = synchronized(lock) { generation },
            mobileFactId = null,
            globalSequence = null,
        )
    }

    private fun dropped(mobileFactId: String, storeGeneration: Long): FactReceipt = FactReceipt(
        status = "dropped",
        accepted = false,
        committed = false,
        storeGeneration = storeGeneration,
        mobileFactId = mobileFactId,
        globalSequence = null,
    )

    private fun durabilityOf(value: String): SegmentedFactStoreDurability {
        if (value == "sync") return SegmentedFactStoreDurability.SYNC
        if (value == "async") return SegmentedFactStoreDurability.MEMORY
        throw IllegalArgumentException(value)
    }

    private class PendingFact(
        val mobileFactId: String,
        val payload: ByteArray,
        val partitionId: Int,
        val localSequence: Long,
    ) {
        fun toReceipt(generation: Long) = FactReceipt(
            status = "accepted",
            accepted = true,
            committed = false,
            storeGeneration = generation,
            mobileFactId = mobileFactId,
            globalSequence = null,
        )

        fun toItem() = FactPageItem(mobileFactId, payload, partitionId, localSequence, committed = false)
    }

    private class IndexEntry(
        val mobileFactId: String,
        val payload: ByteArray,
        val partitionId: Int,
        val globalSequence: Long,
        val generation: Long,
    ) {
        fun toReceipt(currentGeneration: Long) = FactReceipt(
            status = "committed",
            accepted = true,
            committed = true,
            storeGeneration = currentGeneration,
            mobileFactId = mobileFactId,
            globalSequence = globalSequence,
        )

        fun toItem() = FactPageItem(mobileFactId, payload, partitionId, globalSequence, committed = true)

        fun toJson() = JSONObject()
            .put("mobileFactId", mobileFactId)
            .put("partitionId", partitionId)
            .put("globalSequence", globalSequence)
            .put("generation", generation)

        fun localSequence(): Long {
            val parts = mobileFactId.split(':')
            return parts[2].toLong()
        }
    }

    companion object {
        const val SIDECAR_NAME = "receipt-index-v1.jsonl"
    }
}

private fun hashFromId(mobileFactId: String): String {
    val parts = mobileFactId.split(':')
    return parts[3]
}
