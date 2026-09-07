package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class G8StressBenchTest {
    @Test
    fun oneHundredThousandLogsKeepOwnedBytesBounded() {
        val store = MobileCaptureStore()
        var afterTenThousand = -1L
        var heapAtTenThousand = -1L
        repeat(100_000) { index ->
            val accepted = store.append(
                CaptureInput(
                    stream = "logs",
                    targetKey = "t",
                    runtimeEpoch = "e",
                    captureId = index.toLong(),
                    timestampMs = index.toLong(),
                    record = JSONObject().put("id", index).put("message", "m$index"),
                ),
            )
            assertTrue(accepted.accepted || accepted.dropped)
            if (index == 9_999) {
                afterTenThousand = store.status().ownedBytes
                heapAtTenThousand = usedHeapBytes()
            }
        }
        val status = store.status()
        val logs = status.streams.getValue("logs")
        val heapAtOneHundredThousand = usedHeapBytes()
        assertTrue(status.ownedBytes <= status.budgetBytes)
        assertTrue(logs.count <= 4096)
        assertTrue(status.ownedBytes <= afterTenThousand + 64 * 1024)
        assertTrue(
            "heap grew linearly: $heapAtTenThousand -> $heapAtOneHundredThousand",
            heapAtOneHundredThousand < heapAtTenThousand * 4 + 32L * 1024 * 1024,
        )
        println("G8_HEAP logs ownedBytes=${status.ownedBytes} budgetBytes=${status.budgetBytes} heap10k=$heapAtTenThousand heap100k=$heapAtOneHundredThousand")
        val page = store.query(CaptureQuery(view = "legacy-live", stream = "logs", limit = 200))
        assertEquals(200, page.items.size)
        assertEquals("partial", page.coverage.status)
    }

    @Test
    fun oneHundredClearCyclesLeaveEmptyLiveView() {
        val store = MobileCaptureStore()
        repeat(100) { cycle ->
            repeat(50) { index ->
                store.append(
                    CaptureInput(
                        stream = "logs",
                        targetKey = "t",
                        runtimeEpoch = "e",
                        captureId = (cycle * 50 + index).toLong(),
                        timestampMs = index.toLong(),
                        record = JSONObject().put("id", index).put("message", "c$cycle"),
                    ),
                )
            }
            val cleared = store.clear()
            assertTrue(cleared.ok)
            assertEquals(0, store.status().ownedBytes)
            val page = store.query(CaptureQuery(view = "legacy-live", stream = "logs", limit = 200))
            assertEquals(0, page.count)
        }
    }

    @Test
    fun tenThousandStateKeysKeepOwnedBytesBounded() {
        val store = MobileCaptureStore()
        repeat(10_000) { index ->
            store.append(
                CaptureInput(
                    stream = "state",
                    targetKey = "t",
                    runtimeEpoch = "e",
                    captureId = index.toLong(),
                    timestampMs = index.toLong(),
                    stateKey = "app.k$index",
                    record = JSONObject()
                        .put("namespace", "app")
                        .put("key", "k$index")
                        .put("value", index)
                        .put("stateKey", "app.k$index"),
                ),
            )
        }
        val status = store.status()
        val state = status.streams.getValue("state")
        assertTrue(status.ownedBytes <= status.budgetBytes)
        assertTrue(state.count <= 512)
        val page = store.query(CaptureQuery(view = "legacy-live", stream = "state", limit = 200))
        assertTrue(page.count <= 200)
    }

    @Test
    fun twentyThousandMaxBodyNetworkRecordsStayUnderBudget() {
        val store = MobileCaptureStore()
        val body = "x".repeat(20_000)
        var afterTwoThousand = -1L
        repeat(20_000) { index ->
            store.append(
                CaptureInput(
                    stream = "network",
                    targetKey = "t",
                    runtimeEpoch = "e",
                    captureId = index.toLong(),
                    timestampMs = index.toLong(),
                    record = JSONObject()
                        .put("id", index)
                        .put("method", "POST")
                        .put("url", "https://example.test/$index")
                        .put("statusCode", 200)
                        .put("requestBody", body)
                        .put("responseBody", body),
                ),
            )
            if (index == 1_999) {
                afterTwoThousand = store.status().ownedBytes
            }
        }
        val status = store.status()
        val network = status.streams.getValue("network")
        assertTrue(status.ownedBytes <= status.budgetBytes)
        assertTrue(network.count <= 2048)
        assertTrue(status.ownedBytes <= afterTwoThousand + 64 * 1024)
        println("G8_HEAP network ownedBytes=${status.ownedBytes} count=${network.count}")
    }

    @Test
    fun oneHundredThousandEventsKeepOwnedBytesAndHeapBounded() {
        val store = MobileCaptureStore()
        var afterTenThousand = -1L
        var heapAtTenThousand = -1L
        repeat(100_000) { index ->
            store.append(
                CaptureInput(
                    stream = "events",
                    targetKey = "t",
                    runtimeEpoch = "e",
                    captureId = index.toLong(),
                    timestampMs = index.toLong(),
                    record = JSONObject().put("id", index).put("name", "e$index"),
                ),
            )
            if (index == 9_999) {
                afterTenThousand = store.status().ownedBytes
                heapAtTenThousand = usedHeapBytes()
            }
        }
        val status = store.status()
        val events = status.streams.getValue("events")
        val heapAtOneHundredThousand = usedHeapBytes()
        assertTrue(status.ownedBytes <= status.budgetBytes)
        assertTrue(events.count <= 4096)
        assertTrue(status.ownedBytes <= afterTenThousand + 64 * 1024)
        assertTrue(
            "heap grew linearly: $heapAtTenThousand -> $heapAtOneHundredThousand",
            heapAtOneHundredThousand < heapAtTenThousand * 4 + 32L * 1024 * 1024,
        )
        println("G8_HEAP events ownedBytes=${status.ownedBytes} budgetBytes=${status.budgetBytes} heap10k=$heapAtTenThousand heap100k=$heapAtOneHundredThousand")
    }

    private fun usedHeapBytes(): Long {
        val runtime = Runtime.getRuntime()
        repeat(3) {
            System.gc()
            Thread.sleep(20)
        }
        return runtime.totalMemory() - runtime.freeMemory()
    }
}
