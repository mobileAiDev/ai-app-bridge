package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class G8HotQueryBenchTest {
    @Test
    fun twoHundredLogHotQueryP95IsAtMostTenMs() {
        val store = MobileCaptureStore()
        repeat(200) { index ->
            store.append(
                CaptureInput(
                    stream = "logs",
                    targetKey = "t",
                    runtimeEpoch = "e",
                    captureId = index.toLong(),
                    timestampMs = index.toLong(),
                    record = JSONObject().put("id", index).put("message", "m$index"),
                ),
            )
        }
        val query = CaptureQuery(view = "legacy-live", stream = "logs", limit = 200)
        store.query(query)
        val samples = LongArray(40)
        repeat(40) { index ->
            val started = System.nanoTime()
            val page = store.query(query)
            samples[index] = System.nanoTime() - started
            assertEquals(200, page.items.size)
            assertEquals("unavailable", page.coverage.status)
        }
        samples.sort()
        val p50Ns = samples[((samples.size * 50 + 99) / 100) - 1]
        val p95Ns = samples[((samples.size * 95 + 99) / 100) - 1]
        val p99Ns = samples[((samples.size * 99 + 99) / 100) - 1]
        println("G8_hotQuery p50=${p50Ns / 1_000_000.0} p95=${p95Ns / 1_000_000.0} p99=${p99Ns / 1_000_000.0}")
        assertTrue("hot query p95 ${p95Ns / 1_000_000.0}ms", p95Ns <= 10_000_000)
    }

    @Test
    fun twoHundredLogColdQueryP95IsAtMostOneHundredMs() {
        val samples = LongArray(20)
        repeat(20) { run ->
            val store = MobileCaptureStore()
            repeat(200) { index ->
                store.append(
                    CaptureInput(
                        stream = "logs",
                        targetKey = "t",
                        runtimeEpoch = "e",
                        captureId = index.toLong(),
                        timestampMs = index.toLong(),
                        record = JSONObject().put("id", index).put("message", "m$index"),
                    ),
                )
            }
            val query = CaptureQuery(view = "legacy-live", stream = "logs", limit = 200)
            val started = System.nanoTime()
            val page = store.query(query)
            samples[run] = System.nanoTime() - started
            assertEquals(200, page.items.size)
        }
        samples.sort()
        val p50Ns = samples[((samples.size * 50 + 99) / 100) - 1]
        val p95Ns = samples[((samples.size * 95 + 99) / 100) - 1]
        val p99Ns = samples[((samples.size * 99 + 99) / 100) - 1]
        println("G8_coldQuery p50=${p50Ns / 1_000_000.0} p95=${p95Ns / 1_000_000.0} p99=${p99Ns / 1_000_000.0}")
        assertTrue("cold query p95 ${p95Ns / 1_000_000.0}ms", p95Ns <= 100_000_000)
    }
}
