package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.*
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The segmented store owns payloads. Queries scan bounded disk pages; no full-payload index is
 * retained. The small atomic metadata file only names the store, clear generations and loss fences.
 * A receipt is accepted at enqueue; a fact is committed only when the writer makes it readable.
 * Neither is a claim of fsync durability (the existing store performs its group flush separately).
 */
internal class SegmentedCaptureBackend(
    private val store: SegmentedFactStore,
    directory: File,
    private val targetKey: String,
    private val runtimeEpoch: String,
    private val epochStartSequence: Long,
    private val budgets: ByteBudgets,
    private val caps: CountCaps,
    initialLoss: Boolean = false,
    existingRecords: Long = 0,
) : CaptureBackend {
    private val metadataFile = File(directory, "capture-store-v2.json")
    private val metadataLock = Any()
    private var namespace: String
    private var generation: Long
    private val streams = listOf("logs", "network", "events", "state")
    private val streamGenerations = streams.associateWith { 1L }.toMutableMap()
    private val lossThroughMs = streams.associateWith { 0L }.toMutableMap()
    private val lossCaptureIds = streams.associateWith { 0L }.toMutableMap()
    private val lossEpochs = streams.associateWith { "" }.toMutableMap()
    // An opaque cursor acknowledges losses seen at its writer barrier. A loss can happen without
    // advancing the store sequence, so a sequence alone cannot distinguish before from after.
    // New attachments issue new acknowledgements; persisted historical loss fences stay intact.
    private val lossVersions = streams.associateWith { UUID.randomUUID().toString() }.toMutableMap()
    private val readIndexes = streams.associateWith { CaptureReadIndex(epochStartSequence) }.toMutableMap()
    private val watermarks = streams.associateWith { 0L }.toMutableMap()
    private val counts = streams.associateWith { 0 }.toMutableMap()
    @Volatile private var metadataError = false
    private var lossSaveScheduled = false
    private val recentIdentities = LinkedHashMap<String, String>()

    init {
        require(epochStartSequence >= 0) { "Committed epoch start sequence required" }
        directory.mkdirs()
        val existingMetadata = metadataFile.isFile
        if (existingMetadata) {
            val row = JSONObject(metadataFile.readText())
            require(row.getInt("version") == 2) { "Unsupported capture metadata version" }
            namespace = row.getString("namespace")
            generation = row.getLong("generation")
            streams.forEach {
                streamGenerations[it] = row.getJSONObject("streams").getLong(it)
                lossThroughMs[it] = row.getJSONObject("lossThroughMs").getLong(it)
                lossCaptureIds[it] = row.getJSONObject("lossCaptureIds").getLong(it)
                lossEpochs[it] = row.getJSONObject("lossEpochs").getString(it)
            }
        } else {
            namespace = UUID.randomUUID().toString()
            generation = 1
            saveMetadata()
        }
        if (initialLoss || (!existingMetadata && existingRecords > 0)) {
            streams.forEach { lossThroughMs[it] = System.currentTimeMillis() }
            saveMetadata()
        }
    }

    override fun append(record: CaptureInput, durability: String): AppendReceipt {
        require(durability == "async" || durability == "sync")
        if ((record.stream == "state" && record.stateKey == null) || record.stream !in streams || record.targetKey != targetKey || record.runtimeEpoch != runtimeEpoch) {
            return rejected("capture_identity_mismatch")
        }
        val streamGeneration = synchronized(metadataLock) { streamGenerations.getValue(record.stream) }
        val identity = "$namespace:$streamGeneration:${record.targetKey}:${record.runtimeEpoch}:${record.stream}:${record.captureId}"
        val contentHash = sha256(JSONObject().put("record", record.record).put("timestampMs", record.timestampMs)
            .put("actionId", record.actionId ?: JSONObject.NULL).put("stateKey", record.stateKey ?: JSONObject.NULL)
            .toString().toByteArray())
        synchronized(metadataLock) {
            recentIdentities[identity]?.let { existing ->
                return rejected(if (existing == contentHash) "duplicate_capture_identity" else "capture_identity_collision")
            }
        }
        // Content is included as well as the producer identity: even an invalid replay beyond the
        // bounded recent-identity guard cannot mutate the payload resolved by a previously issued ref.
        val id = "mf2:$namespace:$streamGeneration:${sha256("$identity:$contentHash".toByteArray())}"
        val payload = JSONObject()
            .put("schema", "aiappbridge.fact.v1")
            .put("targetKey", targetKey)
            .put("runtimeEpoch", runtimeEpoch)
            .put("actionId", record.actionId ?: JSONObject.NULL)
            .put("capture", JSONObject()
                .put("version", 2).put("namespace", namespace).put("generation", streamGeneration)
                .put("mobileFactId", id).put("captureId", record.captureId)
                .put("timestampMs", record.timestampMs).put("stateKey", record.stateKey ?: JSONObject.NULL))
            .put("payload", JSONObject().put("kind", "evidence").put("stream", record.stream)
                .put("record", record.record))
            .toString().toByteArray(Charsets.UTF_8)
        val enqueue = store.appendWithReceipt(
            payload, partitionForStream(record.stream),
            if (durability == "sync") SegmentedFactStoreDurability.SYNC else SegmentedFactStoreDurability.MEMORY,
        ) { receipt ->
            if (!receipt.operation.isSuccess || receipt.sequence <= 0) {
                noteLoss(record.stream, record.timestampMs, record.captureId)
            } else synchronized(metadataLock) {
                if (streamGenerations.getValue(record.stream) == streamGeneration) {
                    readIndexes.getValue(record.stream).committed(receipt.sequence, record.timestampMs, record.captureId, payload.size)
                }
            }
        }
        if (enqueue != SegmentedFactRecordEnqueueResult.ACCEPTED) {
            // Schedule the small loss fence behind the writer, never perform file I/O on App callbacks.
            scheduleLoss(record.stream, record.timestampMs, record.captureId)
            return rejected(enqueue.name.lowercase().replace('_', '-'))
        }
        synchronized(metadataLock) {
            recentIdentities[identity] = contentHash
            while (recentIdentities.size > 1024) recentIdentities.remove(recentIdentities.keys.first())
            watermarks[record.stream] = maxOf(watermarks.getValue(record.stream), record.captureId)
            counts[record.stream] = minOf(counts.getValue(record.stream) + 1, caps.forStream(record.stream))
        }
        return AppendReceipt("accepted", true, false, false, false, id)
    }

    override fun mark(streams: List<String>) = synchronized(metadataLock) { CaptureWatermark(streams.associateWith { watermarks[it] ?: 0L }) }

    override fun query(query: CaptureQuery): CapturePage {
        if (query.stream !in streams) return unavailable(query, "unknown_stream")
        if (query.view !in listOf("legacy-live", "decision-window", "connected-history")) {
            return unavailable(query, "invalid_capture_view")
        }
        if (query.targetKey != null && query.targetKey != targetKey) return unavailable(query, "target_mismatch")
        if (query.view == "decision-window" && query.runtimeEpoch != null && query.runtimeEpoch != runtimeEpoch) {
            return unavailable(query, "runtime_epoch_changed")
        }
        if (query.view == "decision-window" && query.afterActionId != null && query.sinceId == null && query.sinceMs == null && query.cursor == null) {
            return unavailable(query, "decision_watermark_required")
        }
        val currentGeneration = synchronized(metadataLock) { generation }
        val cursor = try { decodeCursor(query.cursor, currentGeneration, query.stream) }
        catch (_: Exception) { return unavailable(query, "invalid_capture_cursor") }
        val snapshot = awaitSnapshot(query) ?: return unavailable(query, "capture_writer_timeout")
        val status = snapshot.status
        if (status.state != SegmentedFactStoreState.OPEN || !status.operation.isSuccess) {
            return unavailable(query, "capture_store_unavailable")
        }
        if (metadataError) return unavailable(query, "capture_metadata_unavailable")
        val throughSequence = status.nextSequence - 1
        if (cursor.disk.afterSequence > throughSequence) return unavailable(query, "invalid_capture_cursor")
        val legacy = query.view == "legacy-live"
        val limit = (query.limit ?: 200).coerceIn(1, 500)
        val selected = LinkedHashMap<String, DiskFact>()
        var selectedBytes = 0
        var observedWatermark = maxOf(query.sinceId ?: 0L, snapshot.captureWatermark)
        var more = false
        var lost = false
        // Attachment is serialized with appends. Current-epoch views cannot contain older
        // records, so avoid hydrating every historical payload merely to reject its epoch.
        // Explicit history/ref queries retain their original cursor and full retained scope.
        var readCursor = cursor.disk.copy(afterSequence = maxOf(cursor.disk.afterSequence, snapshot.skipThrough))
        val requestedStartSequence = readCursor.afterSequence
        var finished = false
        var scanError: String? = null
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        val requestedEpoch = if (legacy || query.view == "decision-window") runtimeEpoch else query.runtimeEpoch
        val streamGeneration = snapshot.streamGeneration
        val pastTimeFence = query.sinceMs != null && query.sinceMs > snapshot.lossThroughMs
        val pastIdFence = requestedEpoch == runtimeEpoch && snapshot.lossEpoch == runtimeEpoch &&
            query.sinceId != null && query.sinceId >= snapshot.lossCaptureId
        val lossInsideWindow = snapshot.lossThroughMs > 0 && !pastTimeFence && !pastIdFence &&
            cursor.lossVersion != snapshot.lossVersion
        if (lossInsideWindow) lost = true
        while (!finished && System.nanoTime() < deadline) {
            val batch = awaitPage(readCursor) ?: return unavailable(query, "capture_read_timeout")
            for (record in batch.first) {
                if (record.sequence > throughSequence) { finished = true; break }
                // A gap fence from the physical reader is relevant only after the requested cursor.
                if (record.gapLastSequence > requestedStartSequence) lost = true
                val fact = try { parse(record) } catch (_: Exception) {
                    scanError = "capture_record_corrupt"; null
                } ?: continue
                if (fact.stream != query.stream || fact.namespace != namespace || fact.generation != streamGeneration) continue
                if (fact.targetKey != targetKey || (requestedEpoch != null && fact.runtimeEpoch != requestedEpoch)) continue
                if (fact.runtimeEpoch == runtimeEpoch) observedWatermark = maxOf(observedWatermark, fact.captureId)
                if (query.sinceId != null && fact.captureId <= query.sinceId) continue
                if (query.sinceMs != null && fact.timestampMs < query.sinceMs) continue
                if (query.mobileFactId != null && fact.mobileFactId != query.mobileFactId) continue
                // An action tag alone is not a temporal boundary; the pre-action watermark above is required.
                if (query.afterActionId != null && fact.actionId != query.afterActionId) continue
                val key = if (legacy && query.stream == "state") fact.stateKey ?: continue else fact.mobileFactId
                val previous = selected.remove(key)
                if (previous != null) selectedBytes -= previous.bytes
                if (!legacy && selected.size >= limit) { more = true; finished = true; break }
                if (fact.bytes > MAX_QUERY_BYTES) { lost = true; continue }
                if (!legacy && selected.isNotEmpty() && selectedBytes + fact.bytes > MAX_QUERY_BYTES) {
                    more = true; finished = true; break
                }
                selected[key] = fact
                selectedBytes += fact.bytes
                if (legacy) {
                    val legacyCap = minOf(limit, caps.forStream(query.stream))
                    while (selected.size > legacyCap || selectedBytes > minOf(MAX_QUERY_BYTES, budgets.forStream(query.stream))) {
                        val first = selected.entries.first()
                        selectedBytes -= first.value.bytes
                        selected.remove(first.key)
                        more = true
                    }
                }
                if (query.mobileFactId != null) { finished = true; break }
            }
            if (finished) break
            if (batch.second.isEnd) { finished = true; break }
            if (!batch.second.operation.isSuccess) {
                scanError = "capture_read_failed"; finished = true; break
            }
            if (batch.second.cursor.afterSequence <= readCursor.afterSequence) {
                scanError = "capture_cursor_stalled"; finished = true; break
            }
            readCursor = batch.second.cursor
        }
        if (!finished) return unavailable(query, "capture_scan_deadline")
        if (scanError != null) return unavailable(query, scanError)
        if (synchronized(metadataLock) { generation } != currentGeneration) return unavailable(query, "capture_store_cleared")
        if (query.mobileFactId != null && selected.isEmpty()) return unavailable(query, "mobile_fact_unavailable")
        // A present exact ref proves that fact survived; unrelated partition retention does not invalidate it.
        if (query.mobileFactId != null && selected.size == 1) lost = false
        val facts = selected.values.toList()
        val refs = facts.map { CaptureFactRef(it.mobileFactId, it.stream, it.captureId, it.targetKey, it.runtimeEpoch, it.timestampMs) }
        val next = if (more && !legacy && facts.isNotEmpty()) {
            // Pagination must not acknowledge losses beyond this page's last returned fact.
            encodeCursor(currentGeneration, query.stream, facts.last().sequence, cursor.lossVersion)
        } else null
        return CapturePage(
            ok = true, type = query.stream, items = facts.map { it.record }, count = facts.size,
            coverage = CaptureCoverage(if (lost || more) "partial" else "complete", lost, true),
            gap = lost, hasMore = more, refs = refs,
            values = if (query.stream == "state") facts.associate { requireNotNull(it.stateKey) to it.record.opt("value") } else emptyMap(),
            nextCursor = next, watermarkCursor = encodeCursor(currentGeneration, query.stream, throughSequence, snapshot.lossVersion), runtimeEpoch = runtimeEpoch, targetKey = targetKey,
            storeGeneration = currentGeneration, throughWatermark = observedWatermark,
            reason = if (lost) "capture_gap" else if (more) "capture_page_limit" else null,
            window = JSONObject().put("afterActionId", query.afterActionId ?: JSONObject.NULL)
                .put("sinceId", query.sinceId ?: JSONObject.NULL).put("sinceMs", query.sinceMs ?: JSONObject.NULL)
                .put("factCursor", query.cursor ?: JSONObject.NULL).put("runtimeEpoch", requestedEpoch ?: JSONObject.NULL)
                .put("targetKey", targetKey).put("throughWatermark", observedWatermark).put("filterApplied", true),
        )
    }

    override fun status(): CaptureStoreStatus = synchronized(metadataLock) {
        CaptureStoreStatus(
            persistent = !metadataError, generation = generation,
            ownedBytes = 0, budgetBytes = budgets.total().toLong(),
            dropped = lossThroughMs.values.count { it > 0 }.toLong(),
            streams = streams.associateWith {
                StreamStatus(counts.getValue(it), 0, if (lossThroughMs.getValue(it) > 0) 1 else 0, lossThroughMs.getValue(it) > 0)
            },
        )
    }

    override fun clear(scope: String): ClearReceipt {
        require(scope == "all" || scope in streams)
        synchronized(metadataLock) {
            val oldGeneration = generation
            val oldStreams = streamGenerations.toMap()
            generation += 1
            (if (scope == "all") streams else listOf(scope)).forEach {
                streamGenerations[it] = streamGenerations.getValue(it) + 1
            }
            try { saveMetadata() } catch (_: Exception) {
                generation = oldGeneration
                streamGenerations.putAll(oldStreams)
                metadataError = true
                return ClearReceipt(false, generation)
            }
            (if (scope == "all") streams else listOf(scope)).forEach {
                counts[it] = 0
                watermarks[it] = 0
                readIndexes[it] = CaptureReadIndex(epochStartSequence)
                // Retain durable historical loss fences; exact refs and post-fence time windows can still be verified.
            }
            return ClearReceipt(true, generation)
        }
    }

    private fun scheduleLoss(stream: String, timestampMs: Long, captureId: Long) {
        val schedule = synchronized(metadataLock) {
            updateLoss(stream, timestampMs, captureId)
            if (lossSaveScheduled) false else { lossSaveScheduled = true; true }
        }
        if (schedule) store.status {
            synchronized(metadataLock) {
                try { saveMetadata() } catch (_: Exception) { metadataError = true }
                lossSaveScheduled = false
            }
        }
    }

    private fun noteLoss(stream: String, timestampMs: Long, captureId: Long) = synchronized(metadataLock) {
        updateLoss(stream, timestampMs, captureId)
        try { saveMetadata() } catch (_: Exception) { metadataError = true }
    }

    private fun updateLoss(stream: String, timestampMs: Long, captureId: Long) {
        lossVersions[stream] = UUID.randomUUID().toString()
        lossThroughMs[stream] = maxOf(lossThroughMs.getValue(stream), timestampMs)
        if (lossEpochs.getValue(stream) != runtimeEpoch) lossCaptureIds[stream] = 0
        lossEpochs[stream] = runtimeEpoch
        lossCaptureIds[stream] = maxOf(lossCaptureIds.getValue(stream), captureId)
    }

    private fun saveMetadata() {
        val row = JSONObject().put("version", 2).put("namespace", namespace).put("generation", generation)
            .put("streams", JSONObject(streamGenerations.toMap())).put("lossThroughMs", JSONObject(lossThroughMs.toMap()))
            .put("lossCaptureIds", JSONObject(lossCaptureIds.toMap())).put("lossEpochs", JSONObject(lossEpochs.toMap()))
        val temporary = File(metadataFile.parentFile, metadataFile.name + ".tmp")
        FileOutputStream(temporary).use { out -> out.write(row.toString().toByteArray()); out.fd.sync() }
        check(temporary.renameTo(metadataFile)) { "Cannot commit capture metadata" }
    }

    private fun parse(record: SegmentedFactStoreRecord): DiskFact? {
        val row = JSONObject(String(record.payload, Charsets.UTF_8))
        val capture = row.optJSONObject("capture") ?: return null // Existing non-capture facts share the same store.
        if (capture.getInt("version") != 2) throw IllegalArgumentException("capture version")
        val payload = row.getJSONObject("payload")
        return DiskFact(
            capture.getString("namespace"), capture.getLong("generation"), capture.getString("mobileFactId"),
            payload.getString("stream"), row.getString("targetKey"), row.getString("runtimeEpoch"),
            capture.getLong("captureId"), capture.getLong("timestampMs"),
            if (row.isNull("actionId")) null else row.getString("actionId"),
            if (capture.isNull("stateKey")) null else capture.getString("stateKey"),
            payload.getJSONObject("record"), record.sequence, record.payloadLength,
        )
    }

    private fun unavailable(query: CaptureQuery, reason: String) = CapturePage(
        false, query.stream, emptyList(), 0, CaptureCoverage("unavailable", true, false), true, false, emptyList(),
        runtimeEpoch = runtimeEpoch, targetKey = targetKey, storeGeneration = generation,
        throughWatermark = watermarks[query.stream], reason = reason,
    )

    private fun awaitSnapshot(query: CaptureQuery): QuerySnapshot? {
        val latch = CountDownLatch(1)
        var result: QuerySnapshot? = null
        store.status { status ->
            synchronized(metadataLock) {
                val index = readIndexes.getValue(query.stream)
                result = QuerySnapshot(status, streamGenerations.getValue(query.stream),
                    if (query.view == "legacy-live" || query.view == "decision-window") {
                        index.skipThrough(query.sinceMs, query.sinceId, status.nextSequence - 1)
                    } else 0L,
                    index.captureWatermark, lossThroughMs.getValue(query.stream), lossCaptureIds.getValue(query.stream),
                    lossEpochs.getValue(query.stream), lossVersions.getValue(query.stream))
            }
            latch.countDown()
        }
        return if (latch.await(5, TimeUnit.SECONDS)) result else null
    }

    private fun awaitPage(cursor: SegmentedFactStoreCursor): Pair<List<SegmentedFactStoreRecord>, SegmentedFactStoreReadResult>? {
        val latch = CountDownLatch(1)
        var result: Pair<List<SegmentedFactStoreRecord>, SegmentedFactStoreReadResult>? = null
        store.readPage(cursor) { records, page -> result = records to page; latch.countDown() }
        return if (latch.await(5, TimeUnit.SECONDS)) result else null
    }

    private data class QuerySnapshot(
        val status: SegmentedFactStoreStatus, val streamGeneration: Long, val skipThrough: Long,
        val captureWatermark: Long, val lossThroughMs: Long, val lossCaptureId: Long, val lossEpoch: String, val lossVersion: String,
    )

    private data class QueryCursor(val disk: SegmentedFactStoreCursor, val lossVersion: String)
    private fun encodeCursor(generation: Long, stream: String, sequence: Long, lossVersion: String) =
        "cf3:$namespace:$generation:$stream:$lossVersion:$sequence"
    private fun decodeCursor(value: String?, generation: Long, stream: String): QueryCursor {
        if (value == null) return QueryCursor(SegmentedFactStoreCursor(partitionId = partitionForStream(stream)), "-")
        val parts = value.split(':')
        require(parts.size == 6 && parts[0] == "cf3" && parts[1] == namespace && parts[2].toLong() == generation && parts[3] == stream)
        require(parts[4] == "-" || UUID.fromString(parts[4]).toString() == parts[4])
        val sequence = parts[5].toLong()
        require(sequence >= 0)
        return QueryCursor(SegmentedFactStoreCursor(partitionId = partitionForStream(stream), afterSequence = sequence), parts[4])
    }

    private fun partitionForStream(stream: String) = when (stream) {
        "network" -> MobileFactPartition.NETWORK.id
        "logs" -> MobileFactPartition.APP_LOG.id
        else -> MobileFactPartition.STATE_EVENT.id
    }

    private fun rejected(reason: String) = AppendReceipt("dropped", false, false, true, false, null, reason)
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private data class DiskFact(
        val namespace: String, val generation: Long, val mobileFactId: String, val stream: String,
        val targetKey: String, val runtimeEpoch: String, val captureId: Long, val timestampMs: Long,
        val actionId: String?, val stateKey: String?, val record: JSONObject, val sequence: Long, val bytes: Int,
    )

    companion object { private const val MAX_QUERY_BYTES = 2 * 1024 * 1024 }
}
