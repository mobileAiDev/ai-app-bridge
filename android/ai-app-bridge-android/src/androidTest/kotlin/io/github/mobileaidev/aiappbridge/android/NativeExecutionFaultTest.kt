package io.github.mobileaidev.aiappbridge.android

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TestName
import java.io.File
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NativeExecutionFaultTest {
    @get:Rule val testName = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val workers = Executors.newCachedThreadPool()
    private lateinit var activity: NativeFaultActivity
    private var epoch = ""
    private var socketName = ""
    private val sequence = AtomicInteger()
    private val traces = Collections.synchronizedList(mutableListOf<JSONObject>())

    @Before fun startActivity() {
        activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, NativeFaultActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as NativeFaultActivity
        instrumentation.waitForIdleSync()
        val state = JSONObject(File(activity.filesDir, "ai_app_bridge_endpoint.json").readText())
        socketName = state.getString("socketName")
        epoch = request("/v1/status").getJSONObject("debugBridge").getString("runtimeEpoch")
        assertTrue(onUi { activity.window.decorView.hasWindowFocus() })
    }

    @After fun finishActivity() {
        if (::activity.isInitialized) traces.add(onUi {
            JSONObject().put("kind", "independent-view-state").put("test", testName.methodName)
                .put("editorText", activity.editor.text.toString()).put("otherEditorText", activity.otherEditor.text.toString())
                .put("editorFocused", activity.editor.isFocused).put("otherEditorFocused", activity.otherEditor.isFocused)
                .put("clicks", activity.clicks.get())
        })
        val directory = File(instrumentation.targetContext.filesDir, "native-execution-faults").apply { mkdirs() }
        File(directory, "${System.currentTimeMillis()}-${testName.methodName}.json")
            .writeText(org.json.JSONArray(traces).toString(2))
        if (::activity.isInitialized) onUi { activity.finish() }
        workers.shutdownNow()
        instrumentation.waitForIdleSync()
    }

    @Test fun queuedTapTimesOutWithoutADeferredClick() {
        val request = target("atomic-count")
        blockedMain { response ->
            response.set(request("/v1/action/tap-target", request))
            assertRejected(response.get(), "native_action_timeout", false)
            assertEquals(0, activity.clicks.get())
        }
        assertEquals(0, activity.clicks.get())
        assertTrue(request("/v1/action/tap-target", target("atomic-count")).getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertEquals(1, activity.clicks.get())
    }

    @Test fun queuedInputTimesOutWithoutALateTextWrite() {
        val body = target("atomic-editor").put("text", "forbidden-late-input")
        blockedMain { response ->
            response.set(request("/v1/action/input-target", body))
            assertRejected(response.get(), "native_action_timeout", false)
        }
        assertEquals("initial", onUi { activity.editor.text.toString() })
    }

    @Test fun timeoutDuringAnAlreadyStartedTouchIsAmbiguous() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        onUi {
            activity.button.setOnTouchListener { _, event ->
                if (event.action == MotionEvent.ACTION_DOWN) {
                    entered.countDown()
                    check(release.await(4, TimeUnit.SECONDS)) { "test touch release timed out" }
                }
                false
            }
        }
        val body = target("atomic-count")
        try {
            val response = request("/v1/action/tap-target", body)
            assertEquals(0L, entered.count)
            assertEquals("native_action_timeout", response.getString("error"))
            assertTrue(response.isNull("dispatched"))
            assertTrue(response.getBoolean("ambiguous"))
            assertEquals(0, activity.clicks.get())
        } finally { release.countDown() }
        instrumentation.waitForIdleSync()
        assertEquals(0, activity.clicks.get())
        val completion = request("/v1/action/cancel", JSONObject().put("actionId", body.getString("actionId")).put("runtimeEpoch", epoch))
        assertTrue(completion.toString(), completion.getJSONObject("executionResult").getBoolean("settled"))
    }

    @Test fun synchronousFocusChangeCannotBeOverwrittenByInput() {
        val body = target("atomic-editor").put("text", "forbidden-overwrite")
        onUi { activity.editor.onFocusChangeListener = View.OnFocusChangeListener { view, focused ->
            if (focused) (view as NativeFaultActivity.FaultEditor).setText("changed-by-focus")
        } }
        assertRejected(request("/v1/action/input-target", body), "native_target_changed", true)
        assertEquals("changed-by-focus", onUi { activity.editor.text.toString() })
    }

    @Test fun cancellationDuringAnInputCallbackRetainsOwnershipAndPreventsTextCommit() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val body = managed(target("atomic-editor").put("text", "must-not-be-committed"), 10000)
        onUi { activity.editor.connectionHook = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) } }
        val response = workers.submit<JSONObject> { request("/v1/action/input-target", body) }
        val identity = JSONObject().put("actionId", body.getString("actionId")).put("runtimeEpoch", epoch)
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            val cancel = request("/v1/action/cancel", identity)
            assertEquals("native_action_cancel_pending", cancel.getString("error"))
            assertFalse(cancel.getBoolean("settled"))
            val active = request("/v1/status").getJSONObject("debugBridge").getJSONObject("nativeAction")
            assertEquals(body.getString("actionId"), active.getString("actionId"))
            assertRejected(request("/v1/action/tap", managed(JSONObject().put("x", 20).put("y", 30))), "native_action_busy", false)
        } finally { release.countDown() }
        val original = response.get(3, TimeUnit.SECONDS)
        assertEquals("native_action_cancelled", original.getString("error"))
        assertFalse(original.getBoolean("settled"))
        // Releasing the callback is not itself a terminal SDK receipt. Let the
        // original main-thread task finish, then query its retained completion.
        instrumentation.waitForIdleSync()
        val recovered = request("/v1/action/cancel", identity).getJSONObject("executionResult")
        assertEquals(body.getString("actionId"), recovered.getString("actionId"))
        assertTrue(recovered.getBoolean("settled")); assertTrue(recovered.getBoolean("dispatched"))
        assertEquals("initial", onUi { activity.editor.text.toString() })
        assertEquals("other-initial", onUi { activity.otherEditor.text.toString() })
        assertTrue(request("/v1/status").getJSONObject("debugBridge").isNull("nativeAction"))
    }

    @Test fun aCompletedInputCanBeRecoveredByIdentityWithoutRepeatingItsWrite() {
        val body = managed(target("atomic-editor").put("text", "single-commit"))
        val result = request("/v1/action/input-target", body)
        assertTrue(result.toString(), result.getBoolean("ok"))
        val identity = JSONObject().put("actionId", body.getString("actionId")).put("runtimeEpoch", epoch)
        val receipt = request("/v1/action/cancel", identity).getJSONObject("executionResult")
        assertEquals(result.toString(), receipt.toString())
        assertRejected(request("/v1/action/input-target", body.put("text", "replay-forbidden")), "native_action_id_reused", false)
        assertEquals("single-commit", onUi { activity.editor.text.toString() })
        assertRejected(request("/v1/action/cancel", identity.put("runtimeEpoch", "different-runtime")), "native_action_not_active", false)
    }

    @Test fun replacementFromInputConnectionCallbackReceivesNoText() {
        val body = target("atomic-editor").put("text", "forbidden-replacement-input")
        val oldEditor = onUi { activity.editor.also { it.connectionHook = { activity.replaceEditor() } } }
        val response = request("/v1/action/input-target", body)
        onUi {
            assertNotSame(oldEditor, activity.editor)
            assertEquals("initial", oldEditor.text.toString())
            assertEquals("replacement", activity.editor.text.toString())
        }
        assertRejected(response, "native_target_replaced", true)
    }

    @Test fun inputConnectionCannotRedirectFocusBeforeSemanticInput() {
        val body = target("atomic-editor").put("text", "forbidden-unfocused-input")
        onUi { activity.editor.connectionHook = { activity.otherEditor.requestFocus() } }
        val response = request("/v1/action/input-target", body)
        assertOriginalEditorsUnchanged()
        assertRejected(response, "input_focus_changed", true)
    }

    @Test fun selectionCallbackCannotRedirectFocusBeforeCommit() {
        val body = target("atomic-editor").put("text", "forbidden-selection-input")
        onUi { activity.editor.selectionHook = { activity.otherEditor.requestFocus() } }
        val response = request("/v1/action/input-target", body)
        assertOriginalEditorsUnchanged()
        assertRejected(response, "input_focus_changed", true)
    }

    @Test fun coordinateInputCannotWriteToAnEditorDetachedByItsConnectionCallback() {
        val body = point("atomic-editor").put("text", "forbidden-detached-input")
        val oldEditor = onUi { activity.editor.also { it.connectionHook = { activity.replaceEditor() } } }
        val response = request("/v1/action/input-text", body)
        onUi {
            assertNotSame(oldEditor, activity.editor)
            assertEquals("initial", oldEditor.text.toString())
            assertEquals("replacement", activity.editor.text.toString())
        }
        assertRejected(response, "native_target_replaced", true)
    }

    @Test fun coordinateInputCannotContinueAfterAConnectionCallbackMovesFocus() {
        val body = point("atomic-editor").put("text", "forbidden-coordinate-input")
        onUi { activity.editor.connectionHook = { activity.otherEditor.requestFocus() } }
        val response = request("/v1/action/input-text", body)
        assertOriginalEditorsUnchanged()
        assertRejected(response, "input_focus_changed", true)
    }

    @Test fun semanticInputStillReplacesAndClearsTheSelectedEditor() {
        val body = target("atomic-editor").put("text", "accepted-semantic-input")
        val response = request("/v1/action/input-target", body)
        assertTrue(response.toString(), response.getBoolean("ok"))
        assertEquals(body.getString("actionId"), response.getString("actionId"))
        assertEquals("accepted-semantic-input", onUi { activity.editor.text.toString() })
        val clear = request("/v1/action/input-target", target("atomic-editor").put("text", ""))
        assertTrue(clear.toString(), clear.getBoolean("ok"))
        assertEquals("", onUi { activity.editor.text.toString() })
    }

    @Test fun coordinateAndFocusedInputStillUseTheSelectedEditor() {
        val response = request("/v1/action/input-text", point("atomic-other-editor").put("text", "accepted-coordinate"))
        assertTrue(response.toString(), response.getBoolean("ok"))
        assertEquals("accepted-coordinate", onUi { activity.otherEditor.text.toString() })
        val focused = request("/v1/action/input-text", JSONObject().put("text", "accepted-focused"))
        assertTrue(focused.toString(), focused.getBoolean("ok"))
        onUi {
            assertEquals("initial", activity.editor.text.toString())
            assertEquals("accepted-focused", activity.otherEditor.text.toString())
        }
    }

    private fun assertOriginalEditorsUnchanged() = onUi {
        assertTrue(activity.otherEditor.isFocused)
        assertEquals("initial", activity.editor.text.toString())
        assertEquals("other-initial", activity.otherEditor.text.toString())
    }

    private fun point(label: String): JSONObject {
        val bounds = node(label).getJSONObject("bounds")
        return JSONObject().put("x", (bounds.getInt("left") + bounds.getInt("right")) / 2)
            .put("y", (bounds.getInt("top") + bounds.getInt("bottom")) / 2)
            .put("actionId", "fault-point-${System.nanoTime()}")
    }

    @Test fun sameViewMovementUsesItsCurrentPositionInsideTheSdk() {
        val body = target("atomic-count")
        val old = node("atomic-count")
        onUi { activity.button.translationY = 160f }
        instrumentation.waitForIdleSync()
        val current = node("atomic-count")
        assertEquals(old.getJSONObject("targetRef").toString(), current.getJSONObject("targetRef").toString())
        assertEquals(160, current.getJSONObject("bounds").getInt("top") - old.getJSONObject("bounds").getInt("top"))
        val response = request("/v1/action/tap-target", body)
        assertTrue(response.toString(), response.getBoolean("ok"))
        val bounds = current.getJSONObject("bounds")
        assertEquals((bounds.getInt("top") + bounds.getInt("bottom")) / 2, response.getInt("y"))
        instrumentation.waitForIdleSync()
        assertEquals(1, activity.clicks.get())
    }

    @Test fun movementUnderAnotherEditorRejectsTheTap() {
        val body = target("atomic-count")
        onUi { activity.button.translationY = (activity.otherEditor.top - activity.button.top).toFloat() }
        instrumentation.waitForIdleSync()
        assertRejected(request("/v1/action/tap-target", body), "native_target_obscured", false)
        assertEquals(0, activity.clicks.get())
    }

    private fun passivePlayerContainer(): android.widget.FrameLayout = onUi {
        val stage = android.widget.FrameLayout(activity)
        val player = android.widget.FrameLayout(activity).apply {
            contentDescription = "passive-player-container"
            addView(android.view.SurfaceView(activity), android.widget.FrameLayout.LayoutParams(-1, -1))
            // VLC has a passive UI layer above its video surface. Touches are
            // handled by the containing player without setting isClickable.
            addView(android.widget.FrameLayout(activity), android.widget.FrameLayout.LayoutParams(-1, -1))
            setOnTouchListener { _, event ->
                if (event.actionMasked == MotionEvent.ACTION_UP) activity.clicks.incrementAndGet()
                true
            }
        }
        stage.addView(player, android.widget.FrameLayout.LayoutParams(-1, -1))
        activity.root.removeAllViews()
        activity.root.addView(stage, android.widget.LinearLayout.LayoutParams(-1, 700))
        player
    }

    @Test fun semanticContainerTapPassesThroughItsPassiveDescendants() {
        passivePlayerContainer()
        instrumentation.waitForIdleSync()
        val response = request("/v1/action/tap-target", target("passive-player-container"))
        assertTrue(response.toString(), response.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertEquals(1, activity.clicks.get())
    }

    @Test fun semanticContainerSwipePassesThroughItsPassiveDescendants() {
        passivePlayerContainer()
        instrumentation.waitForIdleSync()
        val body = target("passive-player-container").put("action", "swipe")
            .put("deltaX", 150).put("deltaY", 0).put("durationMs", 120)
        val response = request("/v1/action/gesture-target", body)
        assertTrue(response.toString(), response.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertEquals(1, activity.clicks.get())
    }

    @Test fun semanticContainerCannotTapAnInteractiveDescendant() {
        val player = passivePlayerContainer()
        val childClicks = AtomicInteger()
        onUi {
            player.addView(android.widget.Button(activity).apply {
                text = "Independent action"
                setOnClickListener { childClicks.incrementAndGet() }
            }, android.widget.FrameLayout.LayoutParams(-1, -1))
        }
        instrumentation.waitForIdleSync()
        assertRejected(request("/v1/action/tap-target", target("passive-player-container")), "native_target_obscured", false)
        assertEquals(0, childClicks.get())
        assertEquals(0, activity.clicks.get())
    }

    @Test fun semanticContainerCannotTapThroughAnUnrelatedPassiveOverlay() {
        val player = passivePlayerContainer()
        onUi {
            (player.parent as android.widget.FrameLayout).addView(android.widget.FrameLayout(activity),
                android.widget.FrameLayout.LayoutParams(-1, -1))
        }
        instrumentation.waitForIdleSync()
        assertRejected(request("/v1/action/tap-target", target("passive-player-container")), "native_target_obscured", false)
        assertEquals(0, activity.clicks.get())
    }

    private fun blockedMain(block: (java.util.concurrent.atomic.AtomicReference<JSONObject>) -> Unit) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            entered.countDown()
            check(release.await(4, TimeUnit.SECONDS)) { "test main-thread release timed out" }
        }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        try { block(java.util.concurrent.atomic.AtomicReference()) }
        finally { release.countDown() }
        instrumentation.waitForIdleSync()
    }

    private fun popup(touchable: Boolean = true): android.widget.PopupWindow = onUi {
        val button = android.widget.Button(activity).apply {
            text = "Got it"; contentDescription = "popup-count"
            setOnClickListener { activity.clicks.incrementAndGet() }
        }
        android.widget.PopupWindow(button, 480, 240, false).apply {
            isTouchable = touchable
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.WHITE))
            showAtLocation(activity.root, android.view.Gravity.TOP or android.view.Gravity.LEFT, 180, 720)
        }
    }

    @Test fun nonFocusablePopupAcceptsOnlyItsObservedPointerTarget() {
        val background = target("atomic-count")
        val popup = popup()
        try {
            instrumentation.waitForIdleSync()
            val windows = request("/v1/view/tree").getJSONArray("windows")
            val current = windows.getJSONObject(windows.length() - 1)
            assertFalse(current.getBoolean("focused")); assertFalse(current.getBoolean("focusable"))
            assertTrue(current.getBoolean("touchable")); assertFalse(current.isNull("focusOwnerWindowId"))
            assertRejected(request("/v1/action/tap-target", background), "native_selector_not_found", false)
            val response = request("/v1/action/tap-target", target("popup-count"))
            assertTrue(response.toString(), response.getBoolean("ok"))
            instrumentation.waitForIdleSync(); assertEquals(1, activity.clicks.get())
        } finally { onUi { popup.dismiss() } }
    }

    @Test fun replacingAPopupCannotReplayItsOldTarget() {
        val first = popup(); instrumentation.waitForIdleSync()
        val original = target("popup-count")
        onUi { first.dismiss() }; instrumentation.waitForIdleSync()
        val second = popup()
        try {
            instrumentation.waitForIdleSync()
            assertRejected(request("/v1/action/tap-target", original), "native_window_changed", false)
            assertEquals(0, activity.clicks.get())
        } finally { onUi { second.dismiss() } }
    }

    private fun observePopupTouches(popup: android.widget.PopupWindow): MutableList<JSONObject> {
        val events = Collections.synchronizedList(mutableListOf<JSONObject>())
        onUi {
            popup.setTouchInterceptor { view, event ->
                val origin = IntArray(2).also(view::getLocationOnScreen)
                val sample = JSONObject().put("kind", "popup-touch").put("action", event.actionMasked)
                    .put("x", event.x).put("y", event.y).put("rawX", event.rawX).put("rawY", event.rawY)
                    .put("originX", origin[0]).put("originY", origin[1]).put("source", event.source)
                events.add(sample); traces.add(sample)
                event.actionMasked == MotionEvent.ACTION_UP &&
                    (event.rawX < origin[0] || event.rawX >= origin[0] + view.width ||
                        event.rawY < origin[1] || event.rawY >= origin[1] + view.height)
            }
        }
        return events
    }

    private fun assertPopupTouchCoordinates(events: List<JSONObject>) {
        assertEquals(MotionEvent.ACTION_DOWN, events.first().getInt("action"))
        assertEquals(MotionEvent.ACTION_UP, events.last().getInt("action"))
        events.forEach { event ->
            assertEquals(event.getDouble("x") + event.getInt("originX"), event.getDouble("rawX"), 0.01)
            assertEquals(event.getDouble("y") + event.getInt("originY"), event.getDouble("rawY"), 0.01)
            assertEquals(android.view.InputDevice.SOURCE_TOUCHSCREEN, event.getInt("source"))
        }
    }

    @Test fun popupTapPreservesScreenCoordinatesForOutsideTouchInterceptors() {
        val popup = popup()
        try {
            instrumentation.waitForIdleSync()
            val events = observePopupTouches(popup)
            val response = request("/v1/action/tap-target", target("popup-count"))
            assertTrue(response.toString(), response.getBoolean("ok"))
            instrumentation.waitForIdleSync()
            assertPopupTouchCoordinates(events)
            assertEquals(1, activity.clicks.get())
        } finally { onUi { popup.dismiss() } }
    }

    @Test fun popupSwipePreservesScreenCoordinatesForEveryTouchEvent() {
        val popup = popup()
        try {
            instrumentation.waitForIdleSync()
            val events = observePopupTouches(popup)
            val body = target("popup-count").put("action", "swipe").put("durationMs", 120)
                .put("deltaX", 0).put("deltaY", 40)
            val response = request("/v1/action/gesture-target", body)
            assertTrue(response.toString(), response.getBoolean("ok"))
            assertTrue(events.any { it.getInt("action") == MotionEvent.ACTION_MOVE })
            assertPopupTouchCoordinates(events)
        } finally { onUi { popup.dismiss() } }
    }

    @Test fun aNonTouchablePopupDoesNotDispatchToItselfOrTheBackground() {
        val background = target("atomic-count")
        val popup = popup(touchable = false)
        try {
            instrumentation.waitForIdleSync()
            assertRejected(request("/v1/action/tap-target", target("popup-count")), "native_window_not_touchable", false)
            assertRejected(request("/v1/action/tap-target", background), "native_window_not_touchable", false)
            assertEquals(0, activity.clicks.get())
        } finally { onUi { popup.dismiss() } }
    }

    @Test fun checkableTreeStatesAndStaleTapAreVerifiedAgainstTheRealControl() {
        val checkbox = onUi {
            android.widget.CheckBox(activity).apply {
                text = "Download local map"
                contentDescription = "native-map-checkbox"
                isChecked = false
                activity.root.addView(this, 0)
            }
        }
        instrumentation.waitForIdleSync()
        assertFalse(node("native-map-checkbox").getBoolean("checked"))
        assertTrue(node("atomic-count").has("checked"))
        assertTrue(node("atomic-count").isNull("checked"))
        val staleTarget = target("native-map-checkbox")
        onUi { checkbox.isChecked = true }
        assertTrue(node("native-map-checkbox").getBoolean("checked"))
        assertRejected(request("/v1/action/tap-target", staleTarget), "native_target_changed", false)
        assertTrue(onUi { checkbox.isChecked })
        val response = request("/v1/action/tap-target", target("native-map-checkbox"))
        assertTrue(response.toString(), response.getBoolean("ok"))
        assertFalse(onUi { checkbox.isChecked })
        assertFalse(node("native-map-checkbox").getBoolean("checked"))
    }

    private fun target(label: String) = JSONObject().put("selector", JSONObject().put("contentDescription", label))
        .put("targetRef", node(label).getJSONObject("targetRef")).put("actionId", "fault-${System.nanoTime()}")

    private fun node(label: String): JSONObject {
        val tree = request("/v1/view/tree")
        assertTrue(tree.toString(), tree.getBoolean("ok"))
        val windows = tree.getJSONArray("windows")
        val matches = mutableListOf<JSONObject>()
        fun visit(node: JSONObject) {
            if (node.optBoolean("visible") && node.opt("contentDescription") == label) matches.add(node)
            val children = node.optJSONArray("children") ?: return
            for (index in 0 until children.length()) visit(children.getJSONObject(index))
        }
        visit(windows.getJSONObject(windows.length() - 1).getJSONObject("root"))
        assertEquals("Unique current target $label", 1, matches.size)
        return matches.single()
    }

    // The fixture speaks the current SDK wire contract explicitly.
    private fun managed(body: JSONObject, timeoutMs: Int = 1500): JSONObject {
        if (!body.has("actionId")) body.put("actionId", "native-test-${System.nanoTime()}")
        if (!body.has("execution")) body.put("execution", JSONObject().put("schemaVersion", ManagedActionProtocol.NATIVE.schema)
            .put("actionId", body.getString("actionId")).put("runtimeEpoch", epoch).put("timeoutMs", timeoutMs))
        return body
    }

    private fun request(path: String, payload: JSONObject? = null): JSONObject {
        if (payload != null && path.startsWith("/v1/action/") && path != "/v1/action/cancel") managed(payload)
        val started = System.nanoTime()
        val result = SdkTestHttp.request(socketName, path, payload?.toString(), 4000)
        traces.add(JSONObject().put("sequence", sequence.incrementAndGet()).put("path", path).put("request", payload ?: JSONObject.NULL)
            .put("response", result).put("elapsedMs", (System.nanoTime() - started) / 1_000_000))
        return result
    }

    private fun assertRejected(response: JSONObject, error: String, dispatched: Boolean) {
        assertFalse(response.toString(), response.getBoolean("ok"))
        assertEquals(response.toString(), error, response.getString("error"))
        assertEquals(dispatched, response.getBoolean("dispatched"))
        assertFalse(response.getBoolean("ambiguous"))
    }

    private fun <T> onUi(block: () -> T): T {
        var value: T? = null
        instrumentation.runOnMainSync { value = block() }
        @Suppress("UNCHECKED_CAST")
        return value as T
    }
}
