package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.AiAppBridge
import io.github.mobileaidev.aiappbridge.android.CaptureActionContext
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class FlutterCaptureIngressTest {
    @Before fun before() { AiAppBridge.captureStore.clear() }
    @After fun after() { AiAppBridge.captureStore.clear() }

    @Test fun channelIngressKeepsAllFourStreamsAndClearsUnrelatedNativeContext() {
        // Invoke the exact public reflection seam used by the optional Flutter plugin.
        val ingress = AiAppBridge::class.java.getMethod("recordFlutterCapture", String::class.java, String::class.java)
        val cases = listOf(
            Triple("logs", "recordLog", """{"tag":"origin","message":"hello"}"""),
            Triple("network", "recordNetwork", """{"url":"https://example.test/","requestHeaders":{"Authorization":"secret"},"requestBody":"{\"token\":\"secret\"}"}"""),
            Triple("state", "recordState", """{"namespace":"app","key":"theme","value":"dark"}"""),
            Triple("events", "recordEvent", """{"category":"ui","name":"ui.route.changed","data":{"semanticChanged":true}}"""),
        )
        CaptureActionContext.withActionId("unrelated-native") {
            for ((_, method, body) in cases) {
                val attributed = JSONObject(body).put("actionId", "flutter-A")
                if (method == "recordState") attributed.put("key", "theme-A")
                ingress.invoke(null, method, attributed.toString())
                ingress.invoke(null, method, body)
                assertEquals("unrelated-native", CaptureActionContext.currentActionId())
            }
        }
        assertNull(CaptureActionContext.currentActionId())
        for ((stream, _, _) in cases) {
            val items = live(stream).items.sortedBy { it.getLong("id") }
            assertEquals(2, items.size)
            assertEquals("flutter-A", items[0].getString("actionId"))
            assertFalse(items[1].has("actionId"))
            assertFalse(items.toString().contains("secret"))
        }
    }

    @Test fun httpIngressUsesExplicitScopeAndRejectsMalformedActionIdsBeforeAppending() {
        for ((method, stream) in listOf("postLog" to "logs", "postNetwork" to "network", "postState" to "state", "postEvent" to "events")) {
            val post = AiAppBridge::class.java.getDeclaredMethod(method, String::class.java).apply { isAccessible = true }
            CaptureActionContext.withActionId("unrelated-native") {
                val result = post.invoke(AiAppBridge, """{"actionId":"http-A","key":"A"}""") as JSONObject
                assertEquals("http-A", result.getJSONObject("event").getString("actionId"))
                val background = post.invoke(AiAppBridge, """{"key":"background"}""") as JSONObject
                assertFalse(background.getJSONObject("event").has("actionId"))
                for (bad in listOf("7", "null", "\" \"")) {
                    try {
                        post.invoke(AiAppBridge, "{\"actionId\":$bad}")
                        fail("Malformed actionId must not append: $bad")
                    } catch (error: java.lang.reflect.InvocationTargetException) {
                        assertTrue(error.cause is IllegalArgumentException)
                    }
                }
                assertEquals("unrelated-native", CaptureActionContext.currentActionId())
            }
            assertEquals(2, live(stream).items.size)
        }
        assertNull(CaptureActionContext.currentActionId())
    }

    private fun live(stream: String) = AiAppBridge.captureStore.query(
        CaptureQuery(view = "legacy-live", stream = stream, platform = "android"),
    )
}
