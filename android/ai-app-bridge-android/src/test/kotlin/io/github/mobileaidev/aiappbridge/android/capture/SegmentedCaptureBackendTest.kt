package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises the real mapped segmented engine and the exact HTTP response adapter used by the SDK. */
class SegmentedCaptureBackendTest {
    @Test
    fun recentTimeWindowsDoNotHydrateTheCurrentEpochPrefixOrOrdinaryLogPayloads() = fixture { f ->
        for (id in 1L..1200L) {
            assertTrue(f.capture.append(input(id, "events")).accepted)
            assertEquals(SegmentedFactRecordEnqueueResult.ACCEPTED,
                f.store.record("{\"ordinaryLog\":true}".toByteArray(), MobileFactPartition.APP_LOG.id))
            if (id % 64 == 0L) f.drain()
        }
        f.drain()
        f.scanCursors.clear()
        val recent = f.http("events", "view" to "decision-window", "sinceMs" to "2198")
        assertEquals(listOf(1198L, 1199L, 1200L), itemIds(recent))
        assertEquals("complete", recent.getJSONObject("coverage").getString("status"))
        assertTrue("Recent query hydrated ${f.scanCursors.size} historical payloads", f.scanCursors.size <= 130)
        f.scanCursors.clear()
        assertEquals(0, f.http("logs", "view" to "decision-window", "sinceMs" to "2198").getInt("count"))
        assertTrue("Empty capture stream hydrated ordinary logs", f.scanCursors.size <= 1)
    }

    @Test
    fun recentLargeFactsDoNotHydrateMegabytesOfExcludedPayloads() = fixture(quota = 16 * 1024 * 1024) { f ->
        for (id in 1L..150L) {
            assertTrue(f.capture.append(input(id, "events").copy(record =
                JSONObject().put("id", id).put("message", "x".repeat(60 * 1024)))).accepted)
            if (id % 16 == 0L) f.drain()
        }
        f.drain()
        f.scanCursors.clear()
        assertEquals(listOf(149L, 150L), itemIds(f.http("events", "view" to "decision-window", "sinceMs" to "1149")))
        assertTrue("Recent large-fact query hydrated ${f.scanCursors.size} old payloads", f.scanCursors.size <= 4)
    }

    @Test
    fun cursorAcknowledgesOnlyLossesBeforeItsIssuedWatermarkIncludingSameSequenceLoss() = fixture { f ->
        fun lose(id: Long) = f.capture.append(input(id, "events").copy(
            record = JSONObject().put("id", id).put("body", "x".repeat(1024 * 1024))))
        assertFalse(lose(1).accepted)
        val before = f.http("events", "view" to "decision-window", "sinceMs" to "1002")
        assertFalse(before.getBoolean("gap"))
        val cursor = before.getString("watermarkCursor")
        val after = f.http("events", "view" to "decision-window", "factCursor" to cursor)
        assertFalse("Historical loss leaked into an issued cursor window", after.getBoolean("gap"))
        // No successful append and no advancing store sequence separates these two windows.
        assertFalse(lose(2).accepted)
        val loss = f.http("events", "view" to "decision-window", "factCursor" to cursor)
        assertTrue("Loss after watermark was hidden", loss.getBoolean("gap"))
        val acknowledged = loss.getString("watermarkCursor")
        assertNotEquals(cursor, acknowledged)
        f.capture.append(input(3, "events"))
        val next = f.http("events", "view" to "decision-window", "factCursor" to acknowledged)
        assertEquals(listOf(3L), itemIds(next))
        assertFalse(next.getBoolean("gap"))
        f.reopen("epoch-2")
        assertTrue("Reopen must retain durable historical loss", f.http("events", "view" to "connected-history").getBoolean("gap"))
        val reopened = f.http("events", "view" to "decision-window", "sinceMs" to "2000")
        assertFalse(f.http("events", "view" to "decision-window", "factCursor" to reopened.getString("watermarkCursor")).getBoolean("gap"))
    }

    @Test
    fun prefixSeekPreservesBackdatedFactsFutureClocksAndNonmonotonicCaptureIds() = fixture { f ->
        f.capture.append(input(5000, "events").copy(timestampMs = 9000))
        for (id in 1L..260L) {
            f.capture.append(input(id, "events"))
            if (id % 64 == 0L) f.drain()
        }
        f.capture.append(input(261, "events").copy(timestampMs = 1000))
        assertEquals(listOf(5000L, 258L, 259L, 260L), itemIds(f.http("events", "view" to "decision-window", "sinceMs" to "1258")))
        assertEquals(listOf(5000L, 260L, 261L), itemIds(f.http("events", "view" to "decision-window", "sinceId" to "259")))
        assertEquals(listOf(5000L, 260L), itemIds(f.http("events", "view" to "decision-window", "sinceMs" to "1258", "sinceId" to "259")))
        f.capture.clear("events")
        f.capture.append(input(1, "events").copy(timestampMs = 500))
        val cleared = f.http("events", "view" to "decision-window", "sinceMs" to "499")
        assertEquals(listOf(1L), itemIds(cleared))
        assertEquals(1L, cleared.getLong("throughWatermark"))
    }

    @Test
    fun pageCursorDoesNotAcknowledgeLossBeyondThePageOrLoseANewBackdatedDrop() = fixture { f ->
        f.capture.append(input(1, "events"))
        f.capture.append(input(2, "events"))
        val rejected = input(100, "events").copy(record = JSONObject().put("body", "x".repeat(1024 * 1024)))
        assertFalse(f.capture.append(rejected).accepted)
        val first = f.http("events", "view" to "decision-window", "limit" to "1")
        assertTrue(first.getBoolean("gap"))
        assertTrue(first.getBoolean("hasMore"))
        val second = f.http("events", "view" to "decision-window", "factCursor" to first.getString("nextCursor"))
        assertEquals(listOf(2L), itemIds(second))
        assertTrue(second.getBoolean("gap"))
        val watermark = second.getString("watermarkCursor")
        assertFalse(f.http("events", "view" to "decision-window", "factCursor" to watermark).getBoolean("gap"))
        // The persistent timestamp/id maxima do not advance, but this is a NEW loss after the cursor.
        assertFalse(f.capture.append(rejected.copy(captureId = 3, timestampMs = 900)).accepted)
        assertTrue(f.http("events", "view" to "decision-window", "factCursor" to watermark).getBoolean("gap"))
    }

    @Test
    fun currentEpochReadsSkipHistoricalPayloadsButExplicitHistoryRetainsThem() = fixture { f ->
        val first = f.capture.append(input(1, "logs")).mobileFactId!!
        f.capture.append(input(2, "logs"))
        assertEquals(2, f.http("logs").getInt("count"))
        f.reopen("epoch-2")
        f.scanCursors.clear()
        assertEquals(0, f.http("logs", "view" to "decision-window").getInt("count"))
        assertTrue("Current epoch scanned old payloads", f.scanCursors.isNotEmpty() && f.scanCursors.all { it.afterSequence >= 2 })
        f.capture.append(input(3, "logs").copy(runtimeEpoch = "epoch-2"))
        assertEquals(listOf(3L), itemIds(f.http("logs")))
        assertEquals(listOf(1L), itemIds(f.http("logs", "view" to "connected-history", "mobileFactId" to first)))
    }
    @Test
    fun actualDiskReceiptHttpContractAndReferenceSurviveNewProcessEpoch() = fixture { f ->
        val receipt = f.capture.append(input(1, "logs"))
        assertTrue(receipt.accepted)
        assertFalse(receipt.committed)
        val legacy = f.http("logs")
        assertEquals(setOf("ok", "type", "items", "count", "sinceId", "sinceMs", "limit", "updatedAtMs"), legacy.keys().asSequence().toSet())
        assertEquals("value-1", legacy.getJSONArray("items").getJSONObject(0).getString("message"))
        val decision = f.http("logs", "view" to "decision-window")
        assertTrue(decision.getJSONObject("coverage").getBoolean("committed"))
        assertEquals("complete", decision.getJSONObject("coverage").getString("status"))
        assertEquals("epoch-1", decision.getString("runtimeEpoch"))
        assertEquals(receipt.mobileFactId, decision.getJSONArray("refs").getJSONObject(0).getString("mobileFactId"))
        val reference = receipt.mobileFactId!!
        f.reopen("epoch-2")
        assertEquals(0, f.http("logs").getInt("count"))
        val stale = f.http("logs", "view" to "decision-window", "runtimeEpoch" to "epoch-1")
        assertFalse(stale.getBoolean("ok"))
        assertEquals("runtime_epoch_changed", stale.getString("reason"))
        assertFalse(stale.has("window"))
        val history = f.http("logs", "view" to "connected-history", "mobileFactId" to reference)
        assertTrue(history.getBoolean("ok"))
        assertEquals(reference, history.getJSONArray("refs").getJSONObject(0).getString("mobileFactId"))
        assertEquals("epoch-1", history.getJSONArray("refs").getJSONObject(0).getString("runtimeEpoch"))
        assertEquals(1, history.getJSONArray("items").getJSONObject(0).getLong("id"))
    }

    @Test
    fun historyIgnoresHotCapsAndClearInvalidatesRefsAndCursorsAcrossReopen() = fixture { f ->
        val ids = (1L..5L).map { f.capture.append(input(it, "events")).mobileFactId!! }
        val page1 = f.http("events", "view" to "connected-history", "limit" to "2")
        assertEquals(listOf(1L, 2L), itemIds(page1))
        assertTrue(page1.getBoolean("hasMore"))
        assertEquals("partial", page1.getJSONObject("coverage").getString("status"))
        val cursor = page1.getString("nextCursor")
        val page2 = f.http("events", "view" to "connected-history", "limit" to "2", "factCursor" to cursor)
        assertEquals(listOf(3L, 4L), itemIds(page2))
        assertEquals(1, f.http("events", "view" to "connected-history", "mobileFactId" to ids.first()).getInt("count"))
        assertEquals(listOf(4L, 5L), itemIds(f.http("events"))) // Legacy count cap remains two.
        assertTrue(f.capture.clear().ok)
        assertEquals("mobile_fact_unavailable", f.http("events", "view" to "connected-history", "mobileFactId" to ids.first()).getString("reason"))
        assertEquals("invalid_capture_cursor", f.http("events", "view" to "connected-history", "factCursor" to cursor).getString("reason"))
        f.reopen("epoch-2")
        assertEquals(0, f.http("events", "view" to "connected-history").getInt("count"))
        assertEquals("mobile_fact_unavailable", f.http("events", "view" to "connected-history", "mobileFactId" to ids.first()).getString("reason"))
    }

    @Test
    fun decisionUsesTheActualEpochCursorAndActionFilters() = fixture { f ->
        f.capture.append(input(1, "network", actionId = "same-action"))
        val before = f.http("network", "view" to "decision-window")
        val cursor = before.getString("watermarkCursor")
        f.capture.append(input(2, "network", actionId = "other-action"))
        f.capture.append(input(3, "network", actionId = "same-action"))
        val params = arrayOf("view" to "decision-window", "factCursor" to cursor,
            "afterActionId" to "same-action", "runtimeEpoch" to "epoch-1")
        val page = f.http("network", *params)
        assertEquals(listOf(3L), itemIds(page))
        val window = page.getJSONObject("window")
        assertTrue(window.getBoolean("filterApplied"))
        assertEquals(cursor, window.getString("factCursor"))
        assertEquals("same-action", window.getString("afterActionId"))
        assertEquals("epoch-1", window.getString("runtimeEpoch"))
        assertEquals("decision_watermark_required", f.http("network", "view" to "decision-window", "afterActionId" to "same-action").getString("reason"))
        val empty = f.http("network", "view" to "decision-window", "factCursor" to cursor, "afterActionId" to "missing")
        assertEquals(0, empty.getInt("count"))
        assertEquals(0, empty.getJSONArray("refs").length())
        assertEquals("invalid_argument", f.http("network", "view" to "decision-window", "sinceId" to "oops").getString("reason"))
        assertEquals("invalid_argument", f.http("network", "view" to "decision-window", "limit" to "oops").getString("reason"))
        assertEquals("invalid_argument", f.http("network", "view" to "bad-view").getString("reason"))
        assertEquals("target_mismatch", f.http("network", "view" to "decision-window", "targetKey" to "wrong.app").getString("reason"))
    }

    @Test
    fun partitionPagesSkipOrdinaryRecordsAndRespectOtherStreamsGlobalWatermarks() = fixture { f ->
        f.capture.append(input(1, "events"))
        val old = f.http("events", "view" to "decision-window").getString("watermarkCursor")
        // More than one native page of ordinary records shares the STATE_EVENT partition.
        repeat(3) { chunk ->
            repeat(110) {
                assertEquals(SegmentedFactRecordEnqueueResult.ACCEPTED,
                    f.store.record("{\"ordinary\":true}".toByteArray(), MobileFactPartition.STATE_EVENT.id))
            }
            f.capture.append(input(20L + chunk, "state", key = "shared-$chunk"))
            f.capture.append(input(2L + chunk, "events"))
            // A query drains the writer between chunks; no queue saturation is part of this test.
            assertTrue(f.http("state", "view" to "decision-window").getBoolean("ok"))
        }
        f.capture.append(input(10, "network"))
        val first = f.http("events", "view" to "decision-window", "factCursor" to old, "limit" to "2")
        assertEquals(listOf(2L, 3L), itemIds(first))
        assertTrue(first.getBoolean("hasMore"))
        val last = f.http("events", "view" to "decision-window", "factCursor" to first.getString("nextCursor"), "limit" to "2")
        assertEquals(listOf(4L), itemIds(last))
        assertFalse(last.getBoolean("gap"))
        assertEquals("complete", last.getJSONObject("coverage").getString("status"))
        // This watermark ends at another partition's sequence and must still be usable for events.
        val baseline = last.getString("watermarkCursor")
        assertTrue(baseline.substringAfterLast(':').toLong() > first.getString("nextCursor").substringAfterLast(':').toLong())
        assertEquals(0, f.http("events", "view" to "decision-window", "factCursor" to baseline).getInt("count"))
        f.capture.append(input(11, "network"))
        f.capture.append(input(5, "events"))
        val after = f.http("events", "view" to "decision-window", "factCursor" to baseline)
        assertEquals(listOf(5L), itemIds(after))
        assertFalse(after.getBoolean("gap"))
        assertEquals("complete", after.getJSONObject("coverage").getString("status"))
    }

    @Test
    fun invalidFutureCursorAndRepeatedProducerIdentityCannotManufactureEvidence() = fixture { f ->
        val first = f.capture.append(input(1, "events"))
        val duplicate = f.capture.append(input(1, "events"))
        assertFalse(duplicate.accepted)
        assertFalse(duplicate.deduplicated)
        assertEquals("duplicate_capture_identity", duplicate.reason)
        val collision = f.capture.append(input(1, "events").copy(record = JSONObject().put("id", 1).put("message", "changed")))
        assertFalse(collision.accepted)
        assertEquals("capture_identity_collision", collision.reason)
        val page = f.http("events", "view" to "connected-history", "mobileFactId" to first.mobileFactId!!)
        assertEquals("value-1", page.getJSONArray("items").getJSONObject(0).getString("message"))
        val cursor = page.getString("watermarkCursor")
        val future = cursor.substringBeforeLast(':') + ":999999"
        assertEquals("invalid_capture_cursor", f.http("events", "view" to "connected-history", "factCursor" to future).getString("reason"))
    }

    @Test
    fun stateHistoryRetainsOverwrittenValuesButLegacyProjectsLatestValues() = fixture { f ->
        val old = f.capture.append(input(1, "state", key = "app.a")).mobileFactId!!
        f.capture.append(input(2, "state", key = "app.b"))
        f.capture.append(input(3, "state", key = "app.a"))
        val legacy = f.http("state")
        assertEquals(listOf(2L, 3L), itemIds(legacy))
        assertEquals(3, legacy.getJSONObject("values").getLong("app.a"))
        val history = f.http("state", "view" to "connected-history", "mobileFactId" to old)
        assertEquals(1, history.getJSONObject("values").getLong("app.a"))
        f.capture.clear("state")
        assertEquals("mobile_fact_unavailable", f.http("state", "view" to "connected-history", "mobileFactId" to old).getString("reason"))
    }

    @Test
    fun writerClosedAndRejectedPayloadNeverYieldCompleteEvidence() = fixture { f ->
        val oversized = input(1, "network").copy(record = JSONObject().put("id", 1).put("body", "x".repeat(1024 * 1024)))
        assertFalse(f.capture.append(oversized).accepted)
        val page = f.http("network", "view" to "decision-window")
        assertEquals("partial", page.getJSONObject("coverage").getString("status"))
        assertTrue(page.getBoolean("gap"))
        f.closeStore()
        val closed = f.http("network", "view" to "decision-window")
        assertEquals("unavailable", closed.getJSONObject("coverage").getString("status"))
        assertFalse(closed.getJSONObject("coverage").getBoolean("committed"))
    }

    @Test
    fun acceptedThenPartitionDisabledIsRecordedAsAnActualWriterLoss() = fixture(disableNetwork = true) { f ->
        val receipt = f.capture.append(input(1, "network"))
        assertTrue(receipt.accepted)
        assertFalse(receipt.committed)
        val page = f.http("network", "view" to "decision-window")
        assertEquals(0, page.getInt("count"))
        assertEquals("unavailable", page.getJSONObject("coverage").getString("status"))
        assertEquals("capture_read_failed", page.getString("reason"))
        assertFalse(page.getJSONObject("coverage").getBoolean("committed"))
        assertTrue(page.getBoolean("gap"))
        f.reopen("epoch-2")
        val history = f.http("network", "view" to "connected-history")
        assertEquals("unavailable", history.getJSONObject("coverage").getString("status"))
    }

    @Test
    fun physicalRetentionReportsGapButNewWatermarkedWindowCanBeComplete() = fixture(segmentSize = 4096, quota = 8192) { f ->
        var first: String? = null
        for (id in 1L..70L) {
            val receipt = f.capture.append(input(id, "logs").copy(record = JSONObject().put("id", id).put("message", "x".repeat(600))))
            if (first == null) first = receipt.mobileFactId
        }
        val retained = f.http("logs", "view" to "connected-history", "limit" to "500")
        assertTrue(retained.getBoolean("gap"))
        assertEquals("partial", retained.getJSONObject("coverage").getString("status"))
        assertEquals("mobile_fact_unavailable", f.http("logs", "view" to "connected-history", "mobileFactId" to first!!).getString("reason"))
        val cursor = retained.getString("watermarkCursor")
        f.capture.append(input(71, "logs", actionId = "new"))
        val next = f.http("logs", "view" to "decision-window", "factCursor" to cursor, "afterActionId" to "new")
        assertEquals(listOf(71L), itemIds(next))
        assertEquals("complete", next.getJSONObject("coverage").getString("status"))
        assertFalse(next.getBoolean("gap"))
    }

    @Test
    fun concurrentAppendQueryAndClearUseOneConsistentGeneration() = fixture { f ->
        val errors = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
        val workers = (1..3).map { worker -> Thread {
            try {
                repeat(30) { offset ->
                    val id = worker * 1000L + offset
                    f.capture.append(input(id, "events"))
                    val page = f.http("events", "view" to "connected-history")
                    if (page.getBoolean("ok")) assertTrue(page.getJSONObject("coverage").getBoolean("committed"))
                    else assertEquals("capture_store_cleared", page.getString("reason"))
                    if (offset % 10 == 0) assertTrue(f.capture.clear().ok)
                }
            } catch (error: Throwable) { errors.add(error) }
        } }
        workers.forEach { it.start() }
        workers.forEach { it.join(20_000); assertFalse("query deadlocked", it.isAlive) }
        assertTrue(errors.joinToString(), errors.isEmpty())
    }

    @Test
    fun blockedDiskQueryDoesNotHoldTheAppAppendLockAndQueueBytesAreBounded() {
        val directory = Files.createTempDirectory("capture-blocked-writer-").toFile()
        val writer = java.util.concurrent.Executors.newSingleThreadExecutor()
        val release = CountDownLatch(1)
        val store = SegmentedFactStore(nativeFactory = { MappedSegmentedFactStore() }, writer = writer,
            maxQueuedRecords = 10, maxQueuedPayloadBytes = 1500)
        try {
            val opened = CountDownLatch(1)
            store.open(SegmentedFactStoreOptions(directory, partitionQuotas = LongArray(8) { 1024L * 1024 }, receiveObservationFacts = false)) {
                assertTrue(it.isSuccess); opened.countDown()
            }
            assertTrue(opened.await(5, TimeUnit.SECONDS))
            val capture = MobileCaptureStore()
            capture.usePersistentStore(store, directory, "com.example.capture", "epoch-1", epochStartSequence = 0)
            writer.execute { release.await() }
            val querying = Thread { capture.query(CaptureQuery("decision-window", "network")) }
            querying.start()
            val appendDone = CountDownLatch(1)
            Thread { assertTrue(capture.append(input(1, "network")).accepted); appendDone.countDown() }.start()
            assertTrue("App callback blocked by disk query", appendDone.await(1, TimeUnit.SECONDS))
            // Less than ten records fit: byte pressure, not the count semaphore, rejects the next record.
            val remaining = (2L..8L).map { capture.append(input(it, "network")) }
            assertTrue(remaining.any { !it.accepted })
            release.countDown()
            querying.join(5000)
            assertFalse(querying.isAlive)
            val drained = CountDownLatch(1)
            store.status { assertEquals(0, it.queuedPayloadBytes); drained.countDown() }
            assertTrue(drained.await(5, TimeUnit.SECONDS))
            assertTrue(capture.append(input(4, "network")).accepted)
        } finally {
            release.countDown()
            val closed = CountDownLatch(1); store.close { closed.countDown() }; assertTrue(closed.await(5, TimeUnit.SECONDS))
            writer.shutdown(); directory.deleteRecursively()
        }
    }

    @Test
    fun diskColdReadAndAppendTimingAreMeasuredOnTheRealEngine() = fixture { f ->
        val appendTimes = ArrayList<Double>()
        for (id in 1L..1000L) {
            val start = System.nanoTime()
            assertTrue(f.capture.append(input(id, "events")).accepted)
            appendTimes.add((System.nanoTime() - start) / 1_000_000.0)
            if (id % 64 == 0L) f.http("events") // Drain before the bounded queue fills; no artificial drops.
        }
        val readTimes = ArrayList<Double>()
        f.reopen("epoch-2")
        repeat(25) {
            val start = System.nanoTime()
            val page = f.http("events", "view" to "connected-history", "sinceId" to "900", "limit" to "200")
            readTimes.add((System.nanoTime() - start) / 1_000_000.0)
            assertEquals(100, page.getInt("count"))
            assertEquals("complete", page.getJSONObject("coverage").getString("status"))
        }
        println(JSONObject().put("benchmark", "real-mapped-capture-1000")
            .put("firstReadAfterReopenMs", readTimes.first()).put("diskReadP95Ms", readTimes.sorted()[23])
            .put("appendP95Ms", appendTimes.sorted()[949]).put("retainedCapturePayloadBytes", f.capture.status().ownedBytes))
    }

    @Test
    fun volatileCacheEvictionCannotProduceCommittedRefs() {
        val store = MobileCaptureStore(caps = CountCaps(logs = 2))
        repeat(3) { store.append(input((it + 1).toLong(), "logs")) }
        val page = store.query(CaptureQuery("connected-history", "logs"))
        assertTrue(page.gap)
        assertFalse(page.coverage.committed)
        assertTrue(page.refs.isEmpty())
        assertFalse(store.status().persistent)
    }

    private fun input(id: Long, stream: String, actionId: String? = null, key: String? = null) = CaptureInput(
        stream, "com.example.capture", "epoch-1", id, 1000 + id,
        JSONObject().put("id", id).put("message", "value-$id").put("value", id), actionId = actionId, stateKey = key,
    )
    private fun itemIds(body: JSONObject): List<Long> = body.getJSONArray("items").let { items ->
        (0 until items.length()).map { items.getJSONObject(it).getLong("id") }
    }

    private fun fixture(segmentSize: Long = 64 * 1024, quota: Long = 1024 * 1024, disableNetwork: Boolean = false, block: (Fixture) -> Unit) {
        val f = Fixture(segmentSize, quota, disableNetwork)
        try { block(f) } finally { f.closeStore(); f.directory.deleteRecursively() }
    }

    private class Fixture(segmentSize: Long, quota: Long, disableNetwork: Boolean) {
        val directory: File = Files.createTempDirectory("capture-real-store-").toFile()
        private val options = SegmentedFactStoreOptions(directory, segmentSizeBytes = segmentSize,
            partitionQuotas = LongArray(8) { if (disableNetwork && it == 0) 0 else quota }, receiveObservationFacts = false)
        val scanCursors = java.util.concurrent.CopyOnWriteArrayList<SegmentedFactStoreCursor>()
        private fun newStore(): SegmentedFactStore {
            val mapped = MappedSegmentedFactStore()
            return SegmentedFactStore(nativeFactory = { object : SegmentedFactStoreNative by mapped {
                override fun scan(handle: Long, cursor: SegmentedFactStoreCursor, bufferCapacity: Int): SegmentedFactStoreReadResult {
                    scanCursors.add(cursor)
                    return mapped.scan(handle, cursor, bufferCapacity)
                }
            } }, writer = java.util.concurrent.Executors.newSingleThreadExecutor(), maxQueuedRecords = 256)
        }
        var store = newStore()
        var capture = newCapture()
        init { open("epoch-1") }
        private fun newCapture() = MobileCaptureStore(caps = CountCaps(logs = 2, network = 2, events = 2, state = 2))
        private fun open(epoch: String) {
            val latch = CountDownLatch(1)
            var ok = false
            store.open(options) { ok = it.isSuccess; latch.countDown() }
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            assertTrue(ok)
            val ready = CountDownLatch(1)
            store.status { status ->
                capture.usePersistentStore(store, directory, "com.example.capture", epoch, epochStartSequence = status.nextSequence - 1)
                ready.countDown()
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
        }
        fun reopen(epoch: String) { closeStore(); store = newStore(); capture = newCapture(); open(epoch) }
        fun http(stream: String, vararg params: Pair<String, String>) = LegacyLiveView.fromHttp(capture, stream, mapOf(*params), 9000)
        fun drain() { val latch = CountDownLatch(1); store.status { assertTrue(it.operation.isSuccess); latch.countDown() }; assertTrue(latch.await(5, TimeUnit.SECONDS)) }
        fun closeStore() { val latch = CountDownLatch(1); store.close { latch.countDown() }; assertTrue(latch.await(5, TimeUnit.SECONDS)) }
    }
}
