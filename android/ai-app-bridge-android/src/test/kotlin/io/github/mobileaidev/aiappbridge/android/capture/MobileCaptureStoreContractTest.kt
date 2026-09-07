package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MobileCaptureStoreContractTest {
    @Test
    fun sharedFixturesPassThroughTheStoreInterface() {
        val root = JSONObject(fixtureFile().readText())
        val defaults = root.getJSONObject("defaults")
        val cases = root.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val spec = cases.getJSONObject(index)
            val store = MobileCaptureStore(budgetsOf(spec, defaults), capsOf(spec, defaults))
            val generationBefore = store.status().generation
            var lastReceipt = appendAll(store, spec.getJSONArray("appends"), defaults)
            if (spec.has("mark")) {
                val names = spec.getJSONArray("mark")
                store.mark((0 until names.length()).map { names.getString(it) })
            }
            if (spec.has("moreAppends")) {
                lastReceipt = appendAll(store, spec.getJSONArray("moreAppends"), defaults)
            }
            if (spec.optString("clear") == "all") {
                store.clear("all")
            }
            val query = queryOf(spec.getJSONObject("query"))
            val page = store.query(query)
            val expect = spec.getJSONObject("expect")
            assertEquals(spec.getString("name"), idsOf(expect), idsOf(page))
            // G1 fixtures still define the Legacy item projection. Their old memory-only
            // committed/complete expectations are superseded by the durable evidence contract.
            assertFalse(page.coverage.committed)
            assertTrue(page.refs.isEmpty())
            if (expect.has("persistent")) {
                assertEquals(false, store.status().persistent)
            }
            if (expect.has("messages")) {
                val messages = page.items.map { it.getString("message") }
                assertEquals(spec.getString("name"), stringsOf(expect.getJSONArray("messages")), messages)
            }
            if (expect.has("stateValues")) {
                val expected = expect.getJSONObject("stateValues")
                for (key in expected.keys()) {
                    assertEquals(spec.getString("name"), expected.get(key), page.values[key])
                }
            }
            if (expect.optString("secondAppend") == "deduplicated") {
                assertTrue(spec.getString("name"), lastReceipt.deduplicated)
            }
            if (expect.optString("secondAppend") == "dropped") {
                assertTrue(spec.getString("name"), lastReceipt.dropped)
            }
            if (expect.optBoolean("generationChanged")) {
                assertTrue(store.status().generation > generationBefore)
            }
            assertTrue(store.status().ownedBytes <= store.status().budgetBytes)
        }
    }

    @Test
    fun oneMillionSmallRecordsStayInsideByteBudget() {
        val store = MobileCaptureStore()
        repeat(1_000_000) { index ->
            store.append(
                CaptureInput(
                    stream = "logs",
                    targetKey = "t",
                    runtimeEpoch = "e",
                    captureId = index.toLong(),
                    timestampMs = index.toLong(),
                    record = JSONObject().put("id", index),
                ),
            )
        }
        val status = store.status()
        assertFalse(status.persistent)
        assertTrue(status.ownedBytes <= status.budgetBytes)
        assertTrue(status.streams.getValue("logs").ownedBytes <= 256 * 1024)
    }

    @Test
    fun tenThousandNetworkRecordsStayInsideByteBudget() {
        val store = MobileCaptureStore()
        val body = "n".repeat(20_000)
        repeat(10_000) { index ->
            store.append(
                CaptureInput(
                    stream = "network",
                    targetKey = "t",
                    runtimeEpoch = "e",
                    captureId = index.toLong(),
                    timestampMs = index.toLong(),
                    record = JSONObject().put("id", index).put("body", body),
                ),
            )
        }
        val status = store.status()
        assertTrue(status.ownedBytes <= status.budgetBytes)
        assertTrue(status.streams.getValue("network").ownedBytes <= 384 * 1024)
    }

    @Test
    fun appendQueryAndClearShareOneLock() {
        val store = MobileCaptureStore()
        val errors = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
        val workers = (1..4).map { worker ->
            Thread {
                try {
                    repeat(80) { index ->
                        val id = worker * 1_000L + index
                        store.append(
                            CaptureInput(
                                stream = "logs",
                                targetKey = "t",
                                runtimeEpoch = "e",
                                captureId = id,
                                timestampMs = id,
                                record = JSONObject().put("id", id).put("message", "m$id"),
                            ),
                        )
                        store.query(CaptureQuery(view = "legacy-live", stream = "logs"))
                        if (index % 20 == 0) {
                            store.clear("all")
                        }
                    }
                } catch (error: Throwable) {
                    errors.add(error)
                }
            }
        }
        workers.forEach { it.start() }
        workers.forEach { it.join() }
        assertTrue(errors.isEmpty())
        store.clear("all")
        assertEquals(0, store.query(CaptureQuery(view = "legacy-live", stream = "logs")).count)
    }

    private fun appendAll(store: MobileCaptureStore, items: JSONArray, defaults: JSONObject): AppendReceipt {
        var last = AppendReceipt("dropped", false, false, true, false, null, null)
        for (index in 0 until items.length()) {
            last = store.append(inputOf(items.getJSONObject(index), defaults))
        }
        return last
    }

    private fun inputOf(item: JSONObject, defaults: JSONObject): CaptureInput {
        return CaptureInput(
            stream = item.getString("stream"),
            targetKey = defaults.getString("targetKey"),
            runtimeEpoch = defaults.getString("runtimeEpoch"),
            captureId = item.getLong("captureId"),
            timestampMs = item.getLong("timestampMs"),
            record = item.getJSONObject("record"),
            actionId = if (item.has("actionId")) item.getString("actionId") else null,
            stateKey = if (item.has("stateKey")) item.getString("stateKey") else null,
        )
    }

    private fun queryOf(item: JSONObject): CaptureQuery {
        return CaptureQuery(
            view = item.getString("view"),
            stream = item.getString("stream"),
            sinceId = if (item.has("sinceId")) item.getLong("sinceId") else null,
            sinceMs = if (item.has("sinceMs")) item.getLong("sinceMs") else null,
            limit = if (item.has("limit")) item.getInt("limit") else null,
            afterActionId = if (item.has("afterActionId")) item.getString("afterActionId") else null,
        )
    }

    private fun budgetsOf(spec: JSONObject, defaults: JSONObject): ByteBudgets {
        val raw = if (spec.has("budgetBytes")) spec.getJSONObject("budgetBytes") else defaults.getJSONObject("budgetBytes")
        return ByteBudgets(
            logs = raw.getInt("logs"),
            network = raw.getInt("network"),
            events = raw.getInt("events"),
            state = raw.getInt("state"),
        )
    }

    private fun capsOf(spec: JSONObject, defaults: JSONObject): CountCaps {
        val raw = if (spec.has("countCaps")) spec.getJSONObject("countCaps") else defaults.getJSONObject("countCaps")
        return CountCaps(
            logs = raw.getInt("logs"),
            network = raw.getInt("network"),
            events = raw.getInt("events"),
            state = raw.getInt("state"),
        )
    }

    private fun idsOf(expect: JSONObject): List<Long> {
        val ids = expect.getJSONArray("ids")
        return (0 until ids.length()).map { ids.getLong(it) }
    }

    private fun idsOf(page: CapturePage): List<Long> {
        return page.items.map { it.getLong("id") }
    }

    private fun stringsOf(array: JSONArray): List<String> {
        return (0 until array.length()).map { array.getString(it) }
    }

    private fun fixtureFile(): File {
        var dir = File(System.getProperty("user.dir"))
        while (true) {
            val candidate = File(dir, "shared/mobile-capture-store/g1-contract-fixtures.json")
            if (candidate.isFile) return candidate
            val parent = dir.parentFile ?: break
            dir = parent
        }
        throw IllegalStateException("g1-contract-fixtures.json not found from ${System.getProperty("user.dir")}")
    }
}
