package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ObservationFactSinkTest {
    @Test
    fun diskPayloadKeepsBodiesAndNonTokenQueryValues() {
        val payload = SanitizedFactPayload.network(
            context = context(),
            record = JSONObject()
                .put("url", "https://example.test/orders?token=query-secret&station=station-secret#fragment")
                .put("requestBody", "request-secret")
                .put("responseBody", "response-secret")
                .put(
                    "headers",
                    JSONObject()
                        .put("Authorization", "Bearer header-secret")
                        .put("Cookie", "session=cookie-secret"),
                ),
        )

        val encoded = payload.bytes.toString(Charsets.UTF_8)

        assertTrue(encoded.contains("query-secret"))
        assertTrue(encoded.contains("station-secret"))
        assertTrue(encoded.contains("request-secret"))
        assertTrue(encoded.contains("response-secret"))
        assertTrue(encoded.contains("header-secret"))
        assertTrue(encoded.contains("cookie-secret"))
        assertFalse(encoded.contains("\"omitted\":true"))
    }

    @Test
    fun canonicalEnvelopeRoutesEveryAppCaptureStreamAndKeepsPathAndQuery() {
        val context = context()
        val facts = listOf(
            SanitizedFactPayload.log(context, JSONObject().put("message", "ready")),
            SanitizedFactPayload.network(
                context,
                JSONObject().put(
                    "url",
                    "https://example.test/token/path-secret/orders?code=query-secret&view=summary",
                ),
            ),
            SanitizedFactPayload.state(context, JSONObject().put("key", "cart")),
            SanitizedFactPayload.event(
                context,
                category = "app",
                name = "cart.updated",
                data = JSONObject().put("count", 2),
            ),
            SanitizedFactPayload.event(
                context,
                category = "ui",
                name = "ui.changed",
                data = JSONObject().put("nodeCount", 3),
            ),
            SanitizedFactPayload.deviceLog(context, JSONObject().put("message", "logcat-line")),
        )

        assertEquals(listOf(2, 0, 4, 4, 1, 3), facts.map { it.partitionId })
        val deviceLog = JSONObject(facts[5].bytes.toString(Charsets.UTF_8))
        assertEquals("device-log", deviceLog.getString("partition"))
        assertEquals("logcat", deviceLog.getJSONObject("payload").getString("stream"))
        val envelope = JSONObject(facts[1].bytes.toString(Charsets.UTF_8))
        assertEquals("network", envelope.getString("partition"))
        assertEquals("android", envelope.getString("platform"))
        assertEquals("android:sha256:device:com.example.app", envelope.getString("targetKey"))
        assertEquals("runtime-1", envelope.getString("runtimeEpoch"))
        assertEquals("action-7", envelope.getString("actionId"))
        assertEquals(100L, envelope.getJSONObject("timestamps").getLong("occurredAtMs"))
        assertEquals(110L, envelope.getJSONObject("timestamps").getLong("observedAtMs"))
        assertEquals("evidence", envelope.getJSONObject("payload").getString("kind"))
        assertEquals("network", envelope.getJSONObject("payload").getString("stream"))
        val encoded = envelope.toString()
        assertTrue(encoded.contains("path-secret"))
        assertTrue(encoded.contains("query-secret"))
        assertTrue(encoded.contains("view=summary"))
        assertTrue(encoded.contains("packageName"))
        assertTrue(encoded.contains("deviceIdentity"))
        assertTrue(encoded.contains("Pixel Test"))
    }

    @Test
    fun networkFactKeepsMoodlePathAndQueryAsCaptured() {
        val payload = SanitizedFactPayload.network(
            context = context(),
            record = JSONObject().put(
                "url",
                "https://school.example.test/tokenpluginfile.php/path-secret/42/course/image.jpg?offline=1",
            ),
        )

        val envelope = JSONObject(payload.bytes.toString(Charsets.UTF_8))
        val url = envelope
            .getJSONObject("payload")
            .getJSONObject("record")
            .getString("url")

        assertEquals(
            "https://school.example.test/tokenpluginfile.php/path-secret/42/course/image.jpg?offline=1",
            url,
        )
        assertTrue(envelope.toString().contains("path-secret"))
    }

    private fun context() = MobileFactEnvelopeContext(
        platform = "android",
        packageName = "com.example.app",
        bundleId = null,
        model = "Pixel Test",
        deviceIdentity = "sha256:device",
        runtimeEpoch = "runtime-1",
        actionId = "action-7",
        occurredAtMs = 100L,
        observedAtMs = 110L,
    )
}
