package io.github.mobileaidev.aiappbridge.android

import android.app.AlertDialog
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.widget.LinearLayout
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class H5ExecutionFaultTest {
    @get:Rule val testName = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val workers = Executors.newCachedThreadPool()
    private val traces = Collections.synchronizedList(mutableListOf<JSONObject>())
    private lateinit var activity: H5FaultActivity
    private lateinit var observedPage: JSONObject
    private var epoch = ""
    private var socketName = ""
    private val mutation = "window.aabExecutionCount=(window.aabExecutionCount||0)+1;Witness.mark(window.aabExecutionCount);document.getElementById('count').innerText=window.aabExecutionCount;'done'"

    @Before fun start() {
        activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, H5FaultActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as H5FaultActivity
        assertTrue(activity.ready.await(8, TimeUnit.SECONDS)); instrumentation.waitForIdleSync()
        awaitWindow(activity.window.decorView)
        assertEquals("H5 execution fixture", directJavascript("document.title"))
        socketName = JSONObject(File(activity.filesDir, "ai_app_bridge_endpoint.json").readText()).getString("socketName")
        val status = request("/v1/status").getJSONObject("debugBridge")
        observedPage = request("/v1/h5/dom").getJSONObject("pageRef")
        epoch = status.getString("runtimeEpoch"); assertEquals(ManagedActionProtocol.H5.schema, status.getString("h5ExecutionSchema"))
    }
    @After fun finish() {
        if (::activity.isInitialized) {
            onUi { activity.held?.invoke(); activity.held = null }
            instrumentation.waitForIdleSync()
            traces.add(JSONObject().put("kind", "independent-JavascriptInterface-state").put("writes", activity.writes.get())
                .put("changedText", activity.changedText.get() ?: JSONObject.NULL))
            val directory = File(activity.filesDir, "h5-execution-faults").apply { mkdirs() }
            File(directory, "${System.currentTimeMillis()}-${testName.methodName}.json").writeText(JSONArray(traces).toString(2))
            onUi { activity.webView.destroy(); activity.finish() }
        }
        workers.shutdownNow()
    }
    private fun body(script: String = mutation, timeoutMs: Int = 5000): JSONObject {
        val id = "h5-test-${System.nanoTime()}"
        return JSONObject().put("payload", JSONObject().put("action", "eval").put("script", script).put("pageRef", observedPage)).put("actionId", id).put("execution", JSONObject()
            .put("schemaVersion", ManagedActionProtocol.H5.schema).put("runtimeEpoch", epoch).put("actionId", id).put("timeoutMs", timeoutMs))
    }
    private fun identity(body: JSONObject) = JSONObject().put("actionId", body.getString("actionId")).put("runtimeEpoch", epoch)
    private fun assertRejected(result: JSONObject, error: String, dispatched: Boolean) {
        assertFalse(result.toString(), result.getBoolean("ok")); assertEquals(error, result.getString("error"))
        assertEquals(dispatched, result.getBoolean("dispatched"))
    }
    private fun blockedMain(block: () -> Unit) {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post { entered.countDown(); check(release.await(6, TimeUnit.SECONDS)) }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        try { block() } finally { release.countDown() }
        instrumentation.waitForIdleSync()
    }

    @Test fun queuedTimeoutPreventsLateJavascriptMutation() {
        blockedMain {
            val response = request("/v1/h5/action", body(timeoutMs = 60))
            assertRejected(response, "h5_action_timeout", false); assertTrue(response.getBoolean("settled"))
        }
        assertEquals(0, activity.writes.get())
        assertTrue(request("/v1/h5/action", body()).getBoolean("ok")); assertEquals(1, activity.writes.get())
    }

    @Test fun queuedCancellationPreventsLateJavascriptMutation() {
        val original = body()
        blockedMain {
            val response = workers.submit<JSONObject> { request("/v1/h5/action", original) }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (request("/v1/status").getJSONObject("debugBridge").isNull("h5Action")) {
                check(System.nanoTime() < deadline); Thread.sleep(10)
            }
            val cancelled = request("/v1/h5/cancel", identity(original)).getJSONObject("executionResult")
            assertRejected(cancelled, "h5_action_cancelled", false); assertTrue(cancelled.getBoolean("settled"))
            assertRejected(response.get(2, TimeUnit.SECONDS), "h5_action_cancelled", false)
        }
        assertEquals(0, activity.writes.get())
    }

    @Test fun submittedJavascriptKeepsAdmissionUntilTheOriginalCallbackReturns() {
        val original = body("/* hold_callback */" + mutation)
        val response = workers.submit<JSONObject> { request("/v1/h5/action", original) }
        assertTrue(activity.callbackHeld.await(3, TimeUnit.SECONDS)); assertEquals(1, activity.writes.get())
        val cancelled = request("/v1/h5/cancel", identity(original))
        assertEquals("h5_action_cancel_pending", cancelled.getString("error")); assertFalse(cancelled.getBoolean("settled"))
        assertFalse(response.get(3, TimeUnit.SECONDS).getBoolean("settled"))
        assertRejected(request("/v1/h5/action", body()), "h5_action_busy", false)
        assertRejected(request("/v1/action/tap", JSONObject()), "h5_action_busy", false)
        assertRejected(request("/v1/flutter/action", JSONObject()), "h5_action_busy", false)
        assertRejected(request("/v1/app/clear-data", JSONObject()), "h5_action_busy", false)
        assertRejected(request("/v1/h5/cancel", identity(original).put("runtimeEpoch", "different")), "h5_action_not_active", false)
        onUi { activity.held!!.invoke(); activity.held = null }
        val terminal = request("/v1/h5/cancel", identity(original)).getJSONObject("executionResult")
        assertTrue(terminal.getBoolean("settled")); assertRejected(terminal, "h5_action_cancelled", true)
        assertEquals(1, activity.writes.get()); assertTrue(request("/v1/status").getJSONObject("debugBridge").isNull("h5Action"))
    }

    @Test fun completedCallbackIsRecoverableWithoutRepeatingJavascript() {
        val original = body(); val response = request("/v1/h5/action", original)
        assertTrue(response.toString(), response.getBoolean("ok")); assertEquals("done", response.getString("result"))
        val recovered = request("/v1/h5/cancel", identity(original)).getJSONObject("executionResult")
        assertEquals(response.toString(), recovered.toString()); assertEquals(1, activity.writes.get())
        assertRejected(request("/v1/h5/action", original), "h5_action_id_reused", false); assertEquals(1, activity.writes.get())
    }

    @Test fun timeoutAfterSubmissionKeepsAdmissionUntilTheOriginalCallbackReturns() {
        val original = body("/* hold_callback */" + mutation, timeoutMs = 400)
        val response = workers.submit<JSONObject> { request("/v1/h5/action", original) }
        assertTrue(activity.callbackHeld.await(3, TimeUnit.SECONDS)); assertEquals(1, activity.writes.get())
        val unknown = response.get(3, TimeUnit.SECONDS)
        assertEquals("h5_action_timeout", unknown.getString("error")); assertFalse(unknown.getBoolean("settled"))
        assertRejected(request("/v1/h5/action", body()), "h5_action_busy", false)
        onUi { activity.held!!.invoke(); activity.held = null }
        val terminal = request("/v1/h5/cancel", identity(original)).getJSONObject("executionResult")
        assertRejected(terminal, "h5_action_timeout", true); assertTrue(terminal.getBoolean("settled"))
        assertEquals(1, activity.writes.get())
    }

    private fun typed(action: String, elementId: String, text: String? = null, tree: JSONObject = request("/v1/h5/dom")): JSONObject {
        val controls = tree.getJSONObject("dom").getJSONArray("controls")
        val control = (0 until controls.length()).map { controls.getJSONObject(it) }.single { it.getString("id") == elementId }
        val element = JSONObject()
        listOf("elementId", "tag", "id", "name", "type", "text", "ariaLabel", "href").forEach { element.put(it, control.get(it)) }
        val payload = JSONObject().put("action", action).put("pageRef", tree.getJSONObject("pageRef")).put("element", element)
        if (text != null) payload.put("text", text)
        return body().put("payload", payload)
    }

    @Test fun typedClickAndInputRunInTheRealRenderer() {
        val click = request("/v1/h5/action", typed("click", "count-button"))
        assertTrue(click.toString(), click.getBoolean("ok")); assertEquals(1, activity.writes.get())
        assertTrue(click.getJSONObject("nativeHit").getBoolean("ok"))
        assertEquals("1", directJavascript("document.getElementById('count').innerText"))
        val clear = request("/v1/h5/action", typed("input", "editor", ""))
        assertTrue(clear.toString(), clear.getBoolean("ok")); assertEquals("", activity.changedText.get())
        assertEquals("", directJavascript("document.getElementById('editor').value"))
        val unicode = request("/v1/h5/action", typed("input", "editor", "回归验证 café 🧪"))
        assertTrue(unicode.toString(), unicode.getBoolean("ok")); assertEquals("回归验证 café 🧪", activity.changedText.get())
        assertEquals("回归验证 café 🧪", directJavascript("document.getElementById('editor').value"))
    }

    @Test fun replacedElementsAndChangedRoutesCannotReceiveAnObservedAction() {
        val original = typed("click", "count-button")
        directJavascript("document.getElementById('count-button').outerHTML=document.getElementById('count-button').outerHTML;true")
        assertRejected(request("/v1/h5/action", original), "reobserve_required", false)
        val next = typed("click", "count-button")
        directJavascript("history.pushState({},'', '/other');history.replaceState({},'', '/');true")
        assertRejected(request("/v1/h5/action", next), "reobserve_required", false)
        assertEquals(0, activity.writes.get())
    }

    @Test fun focusCallbackChangesAreNotOverwritten() {
        onUi { activity.webView.requestFocus() }
        directJavascript("document.body.tabIndex=-1;document.body.focus();document.getElementById('editor').onfocus=function(){this.value='focus-callback';};true")
        assertRejected(request("/v1/h5/action", typed("input", "editor", "replacement")), "android_h5_target_changed", true)
        assertEquals("focus-callback", directJavascript("document.getElementById('editor').value")); assertNull(activity.changedText.get())
    }

    @Test fun moreThanOneVisibleWebViewRequiresAnExplicitOriginalIdentity() {
        onUi { activity.root.addView(WebView(activity), LinearLayout.LayoutParams(-1, 300)) }
        instrumentation.waitForIdleSync()
        val ambiguous = request("/v1/h5/dom")
        assertEquals("android_h5_webview_ambiguous", ambiguous.getString("error"))
        assertEquals(2, ambiguous.getJSONArray("webViews").length())
        // The observed ID remains an explicit selection even when another view appears.
        val selected = request("/v1/h5/dom?webViewId=" + observedPage.getString("webViewId"))
        assertTrue(selected.toString(), selected.getBoolean("ok"))
        assertTrue(request("/v1/h5/action", body()).getBoolean("ok")); assertEquals(1, activity.writes.get())
    }

    @Test fun cancellationAfterTheReadOnlyProbePreventsTheTypedMutation() {
        val original = typed("click", "count-button")
        onUi { activity.webView.holdProbe = true }
        val response = workers.submit<JSONObject> { request("/v1/h5/action", original) }
        assertTrue(activity.callbackHeld.await(3, TimeUnit.SECONDS)); assertEquals(0, activity.writes.get())
        assertFalse(request("/v1/h5/cancel", identity(original)).getBoolean("settled"))
        assertFalse(response.get(3, TimeUnit.SECONDS).getBoolean("settled"))
        onUi { activity.held!!.invoke(); activity.held = null }
        val terminal = request("/v1/h5/cancel", identity(original)).getJSONObject("executionResult")
        assertTrue(terminal.getBoolean("settled")); assertRejected(terminal, "h5_action_cancelled", false)
        assertEquals(0, activity.writes.get())
    }

    @Test fun nativeOverlayCannotBeBypassedByADomClick() {
        val original = typed("click", "count-button")
        onUi {
            activity.root.removeView(activity.webView)
            val frame = android.widget.FrameLayout(activity)
            frame.addView(activity.webView, android.widget.FrameLayout.LayoutParams(-1, -1))
            frame.addView(android.view.View(activity).apply { isClickable = true; setBackgroundColor(android.graphics.Color.GRAY) },
                android.widget.FrameLayout.LayoutParams(-1, -1))
            activity.root.addView(frame, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        instrumentation.waitForIdleSync()
        assertRejected(request("/v1/h5/action", original), "android_h5_native_target_obscured", false)
        assertEquals(0, activity.writes.get())
    }

    @Test fun exceptionAfterTypedSubmissionRetainsTheOriginalCallback() {
        val original = typed("click", "count-button")
        onUi { activity.webView.throwAfterActionSubmission = true }
        val response = request("/v1/h5/action", original)
        assertRejected(response, "h5_submission_failed", true)
        assertTrue(response.getBoolean("ambiguous")); assertTrue(response.getBoolean("settled"))
        assertEquals(1, activity.writes.get())
        val recovered = request("/v1/h5/cancel", identity(original)).getJSONObject("executionResult")
        assertEquals(response.toString(), recovered.toString()); assertEquals(1, activity.writes.get())
    }

    @Test fun publicIntentAndScriptWindow() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("publicH5") == "true")
        val directory = File(activity.filesDir, "h5-public").apply { mkdirs() }
        val done = File(directory, "done")
        check(!done.exists()) { "A previous public workflow marker must be archived before this test" }
        File(directory, "ready.json").writeText(JSONObject().put("runtimeEpoch", epoch).put("pageRef", observedPage).toString())
        val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(5)
        while (!done.exists() && System.nanoTime() < deadline) {
            File(directory, "oracle.json").writeText(JSONObject().put("writes", activity.writes.get())
                .put("changedText", activity.changedText.get() ?: JSONObject.NULL).toString())
            Thread.sleep(200)
        }
        assertTrue("Public workflow did not finish", done.exists())
        assertEquals(4, activity.writes.get())
        assertEquals("Android H5 回归 café 🧪", activity.changedText.get())
        File(directory, "final-oracle.json").writeText(JSONObject().put("writes", activity.writes.get())
            .put("changedText", activity.changedText.get()).put("passed", true).toString())
    }

    @Test fun nonFocusableWebViewPopupUsesItsOwnerFocus() {
        val ready = CountDownLatch(1)
        val webView = onUi { WebView(activity).apply {
            settings.javaScriptEnabled = true
            addJavascriptInterface(object {
                @android.webkit.JavascriptInterface fun clicked() { activity.writes.incrementAndGet() }
            }, "PopupWitness")
            webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { ready.countDown() }
            }
            loadDataWithBaseURL("https://popup.test/", "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body><button id='popup-button' onclick='PopupWitness.clicked();this.innerText=\"Clicked\"'>Popup H5</button></body></html>", "text/html", "UTF-8", null)
        } }
        val popup = onUi { android.widget.PopupWindow(webView, 720, 600, false).apply {
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.WHITE))
            showAtLocation(activity.root, android.view.Gravity.TOP or android.view.Gravity.LEFT, 120, 660)
        } }
        try {
            assertTrue(ready.await(5, TimeUnit.SECONDS)); instrumentation.waitForIdleSync()
            assertFalse(onUi { webView.hasWindowFocus() }); assertTrue(onUi { activity.window.decorView.hasWindowFocus() })
            val snapshot = request("/v1/h5/dom")
            assertTrue(snapshot.toString(), snapshot.getBoolean("ok"))
            assertEquals("https://popup.test/", snapshot.getJSONObject("pageRef").getString("url"))
            assertNotEquals(observedPage.getString("webViewId"), snapshot.getJSONObject("pageRef").getString("webViewId"))
            val result = request("/v1/h5/action", typed("click", "popup-button", tree = snapshot))
            assertTrue(result.toString(), result.getBoolean("ok")); assertEquals(1, activity.writes.get())
            assertEquals("Clicked", request("/v1/h5/dom").getJSONObject("dom").getJSONArray("controls").getJSONObject(0).getString("text"))
        } finally { onUi { popup.dismiss(); webView.destroy() } }
    }

    @Test fun aDialogCannotExposeTheBackgroundWebViewToMutation() {
        val dialog = onUi { AlertDialog.Builder(activity).setMessage("Foreground dialog").setPositiveButton("OK", null).show() }
        try {
            awaitWindow(dialog.window!!.decorView)
            val windows = request("/v1/view/tree").getJSONArray("windows")
            assertEquals(2, windows.length()); assertTrue(windows.getJSONObject(1).getBoolean("focused"))
            assertRejected(request("/v1/h5/action", body()), "android_h5_webview_not_found", false)
            assertEquals("android_h5_webview_not_found", request("/v1/h5/dom").getString("error")); assertEquals(0, activity.writes.get())
        }
        finally { onUi { dialog.dismiss() } }
    }

    @Test fun theWebViewInsideTheForegroundDialogRemainsUsable() {
        val ready = CountDownLatch(1)
        val foreground = onUi { WebView(activity).apply {
            settings.javaScriptEnabled = true
            webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { ready.countDown() }
            }
            loadDataWithBaseURL("https://dialog.test/", "<html><head><title>Foreground H5 dialog</title><meta name='viewport' content='width=device-width,initial-scale=1'></head><body><button id='dialog-button' onclick='this.innerText=\"Clicked\"'>Dialog</button></body></html>", "text/html", "UTF-8", null)
        } }
        val dialog = onUi { AlertDialog.Builder(activity).setView(android.widget.FrameLayout(activity).apply {
            addView(foreground, android.widget.FrameLayout.LayoutParams(-1, 600))
        }).show() }
        try {
            assertTrue(ready.await(5, TimeUnit.SECONDS)); awaitWindow(dialog.window!!.decorView)
            val hierarchy = onUi {
                var current: android.view.View? = foreground
                val nodes = JSONArray()
                while (current != null) {
                    val rect = android.graphics.Rect()
                    nodes.put(JSONObject().put("class", current.javaClass.name).put("shown", current.isShown)
                        .put("attached", current.isAttachedToWindow).put("enabled", current.isEnabled).put("alpha", current.alpha)
                        .put("width", current.width).put("height", current.height).put("visibleRect", current.getGlobalVisibleRect(rect))
                        .put("rect", rect.toString()))
                    current = current.parent as? android.view.View
                }
                nodes
            }
            traces.add(JSONObject().put("kind", "dialog-native-hierarchy").put("nodes", hierarchy))
            val snapshot = request("/v1/h5/dom")
            assertTrue(snapshot.toString() + " hierarchy=" + hierarchy, snapshot.getBoolean("ok"))
            observedPage = snapshot.getJSONObject("pageRef")
            val response = request("/v1/h5/action", body("document.title"))
            assertTrue(response.toString(), response.getBoolean("ok")); assertEquals("Foreground H5 dialog", response.getString("result"))
            assertEquals("Foreground H5 dialog", request("/v1/h5/dom").getJSONObject("dom").getString("title"))
            val click = request("/v1/h5/action", typed("click", "dialog-button", tree = snapshot))
            assertTrue(click.toString(), click.getBoolean("ok"))
            val after = request("/v1/h5/dom").getJSONObject("dom")
            assertEquals("Clicked", after.getJSONArray("controls").getJSONObject(0).getString("text"))
            assertEquals(0, activity.writes.get())
        } finally { onUi { dialog.dismiss(); foreground.destroy() } }
    }

    @Test fun legacyAndUnknownRequestFieldsCannotQueueJavascript() {
        assertRejected(request("/v1/h5/action", JSONObject().put("script", mutation)), "invalid_h5_request", false)
        assertRejected(request("/v1/h5/action", body().put("unexpected", true)), "invalid_h5_request", false)
        assertRejected(request("/v1/h5/action", body().apply { getJSONObject("execution").put("timeoutMs", "100") }), "invalid_h5_execution", false)
        assertEquals(0, activity.writes.get())
    }

    private fun awaitWindow(root: android.view.View) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        while (!onUi { root.isAttachedToWindow && root.width > 0 && root.hasWindowFocus() }) {
            check(System.nanoTime() < deadline) { "Fixture window did not become focused" }; Thread.sleep(20)
        }
        instrumentation.waitForIdleSync()
    }

    // Independent test-side renderer read/setup, outside the SDK HTTP decoder.
    private fun directJavascript(script: String): Any {
        val finished = CountDownLatch(1); var raw: String? = null
        onUi { activity.webView.evaluateJavascript(script) { raw = it; finished.countDown() } }
        assertTrue(finished.await(3, TimeUnit.SECONDS))
        traces.add(JSONObject().put("kind", "independent-renderer-read-or-fixture-setup").put("script", script).put("raw", raw))
        return JSONTokener(raw!!).nextValue()
    }

    private fun request(path: String, payload: JSONObject? = null): JSONObject {
        val result = SdkTestHttp.request(socketName, path, payload?.toString(), 6000)
        traces.add(JSONObject().put("path", path).put("request", payload ?: JSONObject.NULL).put("response", result))
        return result
    }
    private fun <T> onUi(block: () -> T): T {
        var value: T? = null; instrumentation.runOnMainSync { value = block() }
        @Suppress("UNCHECKED_CAST") return value as T
    }
}
