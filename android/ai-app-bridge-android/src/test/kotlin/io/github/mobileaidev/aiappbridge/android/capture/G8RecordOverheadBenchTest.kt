package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import org.junit.Assert.assertTrue
import org.junit.Test

class G8RecordOverheadBenchTest {
    @Test
    fun publicRecordStarThreadOverheadP95IsAtMostOneMs() {
        AiAppBridge.captureStore.clear()
        try {
            bench("recordLog") { index ->
                AiAppBridge.recordLog("info", "g8", "m$index", null)
            }
            bench("recordNetwork") { index ->
                AiAppBridge.recordNetwork("GET", "https://example.test/$index", 200, 1, null, null, null)
            }
            bench("recordState") { index ->
                AiAppBridge.recordState("app", "k$index", """{"n":$index}""")
            }
            bench("recordEvent") { index ->
                AiAppBridge.recordEvent("app", "e$index", null)
            }
        } finally {
            AiAppBridge.captureStore.clear()
        }
    }

    private fun bench(name: String, record: (Int) -> Unit) {
        repeat(20) { index -> record(index) }
        val samples = LongArray(40)
        repeat(40) { index ->
            val started = System.nanoTime()
            record(100 + index)
            samples[index] = System.nanoTime() - started
        }
        samples.sort()
        val p50Ns = samples[((samples.size * 50 + 99) / 100) - 1]
        val p95Ns = samples[((samples.size * 95 + 99) / 100) - 1]
        val p99Ns = samples[((samples.size * 99 + 99) / 100) - 1]
        println("G8_$name p50=${p50Ns / 1_000_000.0} p95=${p95Ns / 1_000_000.0} p99=${p99Ns / 1_000_000.0}")
        assertTrue("$name p95 ${p95Ns / 1_000_000.0}ms", p95Ns <= 1_000_000)
        assertTrue("$name p99 ${p99Ns / 1_000_000.0}ms", p99Ns <= 3_000_000)
    }
}
