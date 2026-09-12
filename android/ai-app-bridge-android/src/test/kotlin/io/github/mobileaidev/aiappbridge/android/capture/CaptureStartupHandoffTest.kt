package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class CaptureStartupHandoffTest {
    @Test
    fun startupRecordsAndOverwrittenStatesSurviveAttachmentAndDiskReopen() = fixture { f ->
        listOf("logs", "network", "events", "state").forEach { stream ->
            f.capture.append(input(1, stream))
            f.capture.append(input(2, stream))
        }
        assertEquals(listOf(2L), ids(f.capture.query(CaptureQuery("legacy-live", "state"))))
        f.attach()
        val refs = listOf("logs", "network", "events", "state").map { stream ->
            val page = f.capture.query(CaptureQuery("connected-history", stream))
            assertTrue(page.toString(), page.ok)
            assertEquals("complete", page.coverage.status)
            assertTrue(page.coverage.committed)
            assertEquals(listOf(1L, 2L), ids(page))
            stream to page.refs.first().mobileFactId
        }
        f.reopen()
        refs.forEach { (stream, ref) ->
            val page = f.capture.query(CaptureQuery("connected-history", stream, mobileFactId = ref))
            assertTrue(page.ok)
            assertEquals(listOf(1L), ids(page))
            assertEquals(ref, page.refs.single().mobileFactId)
            assertEquals("epoch-1", page.refs.single().runtimeEpoch)
        }
    }

    @Test
    fun actualStartupEvictionKeepsItsStreamGapAcrossAttachment() = fixture(CountCaps(logs = 2, state = 2)) { f ->
        repeat(3) { f.capture.append(input((it + 1).toLong(), "logs")) }
        repeat(3) { f.capture.append(input((it + 1).toLong(), "state")) }
        f.capture.append(input(1, "events"))
        f.attach()
        for (stream in listOf("logs", "state")) {
            val page = f.capture.query(CaptureQuery("connected-history", stream))
            assertEquals(listOf(2L, 3L), ids(page))
            assertEquals("partial", page.coverage.status)
            assertEquals("capture_gap", page.reason)
            assertTrue(page.coverage.committed)
        }
        assertEquals("complete", f.capture.query(CaptureQuery("connected-history", "events")).coverage.status)
        f.reopen()
        assertEquals("partial", f.capture.query(CaptureQuery("connected-history", "logs")).coverage.status)
    }

    @Test
    fun strongMemoryReadExplainsWhyItCannotSupplyDurableEvidence() {
        val capture = MobileCaptureStore()
        capture.append(input(1, "logs"))
        for (view in listOf("decision-window", "connected-history")) {
            val body = LegacyLiveView.fromHttp(capture, "logs", mapOf("view" to view), 1)
            assertFalse(body.toString(), body.getBoolean("ok"))
            assertEquals("capture_not_persistent", body.getString("reason"))
            assertFalse(body.getJSONObject("coverage").getBoolean("committed"))
            assertEquals(0, body.getJSONArray("refs").length())
        }
        assertTrue(LegacyLiveView.fromHttp(capture, "logs", emptyMap(), 1).getBoolean("ok"))
    }

    private fun input(id: Long, stream: String) = CaptureInput(stream, "sample", "epoch-1", id, 1000 + id,
        JSONObject().put("id", id).put("value", id), actionId = "startup", stateKey = if (stream == "state") "ready" else null)
    private fun ids(page: CapturePage) = page.items.map { it.getLong("id") }
    private fun fixture(caps: CountCaps = CountCaps(), block: (Fixture) -> Unit) {
        val fixture = Fixture(caps)
        try { block(fixture) } finally { fixture.close(); fixture.directory.deleteRecursively() }
    }

    private class Fixture(private val caps: CountCaps) {
        val directory = Files.createTempDirectory("capture-startup-handoff-").toFile()
        private val options = SegmentedFactStoreOptions(directory, segmentSizeBytes = 64 * 1024,
            partitionQuotas = LongArray(8) { 1024L * 1024 }, receiveObservationFacts = false)
        private fun newStore() = SegmentedFactStore(nativeFactory = { MappedSegmentedFactStore() },
            writer = Executors.newSingleThreadExecutor(), maxQueuedRecords = 256)
        private var store = newStore()
        var capture = MobileCaptureStore(caps = caps)
        fun attach(epoch: String = "epoch-1") {
            val opened = CountDownLatch(1)
            store.open(options) { assertTrue(it.isSuccess); opened.countDown() }
            assertTrue(opened.await(5, TimeUnit.SECONDS))
            val attached = CountDownLatch(1)
            val error = AtomicReference<Throwable>()
            // This is the production writer callback; handoff must enqueue without waiting on itself.
            store.status { status ->
                try {
                    capture.usePersistentStore(store, directory, "sample", epoch, status.nextSequence - 1, status.recordCount)
                } catch (failure: Throwable) { error.set(failure) }
                finally { attached.countDown() }
            }
            assertTrue(attached.await(5, TimeUnit.SECONDS))
            error.get()?.let { throw it }
        }
        fun reopen() { close(); store = newStore(); capture = MobileCaptureStore(caps = caps); attach("epoch-2") }
        fun close() {
            val closed = CountDownLatch(1)
            store.close { closed.countDown() }
            assertTrue(closed.await(5, TimeUnit.SECONDS))
        }
    }
}
