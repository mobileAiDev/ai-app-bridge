package io.github.mobileaidev.aiappbridge.android

import android.graphics.Rect
import android.os.Handler
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class NativeGestureTarget(
    val root: View, val rootBounds: Rect, val windowType: String, val targetRef: JSONObject,
    val startX: Float, val startY: Float, val endX: Float, val endY: Float,
    val isCurrent: () -> Boolean,
)

// One native touch stream owns its original window until UP/CANCEL. Selection
// is validated immediately before DOWN; Android owns routing within that stream.
// The network thread stays available for observation and explicit cancellation.
internal class NativeGestureExecutor(
    private val mainHandler: Handler,
    private val interaction: (String, JSONObject) -> Unit,
) {
    fun task(request: NativeGestureRequest, prepare: () -> NativeGestureTarget): ManagedExecutionTask = Gesture(request, prepare)

    private inner class Gesture(val request: NativeGestureRequest, val prepare: () -> NativeGestureTarget) : ManagedExecutionTask {
        private val dispatchGate = MainThreadTaskGate()
        private val finished = AtomicBoolean()
        private val stopReason = AtomicReference<String?>()
        private val result = AtomicReference<JSONObject>()
        private val callback = AtomicReference<((JSONObject) -> Unit)?>()
        private val delivered = AtomicBoolean()
        private val deadline = SystemClock.uptimeMillis() + request.timeoutMs
        private var target: NativeGestureTarget? = null
        private var downTime = 0L
        private var eventsSent = 0
        private var handledDown = false
        private var evidenceError: String? = null
        private val step = Runnable { advance() }
        private val begin = Runnable {
            if (finished.get()) return@Runnable
            try {
                val selected = prepare()
                if (!dispatchGate.begin()) return@Runnable
                target = selected
                downTime = SystemClock.uptimeMillis()
                if (downTime >= deadline || stopReason.get() != null) { finishBeforeDown(stopReason.get() ?: "native_action_timeout"); return@Runnable }
                handledDown = touch(MotionEvent.ACTION_DOWN, 0f)
                recordInteraction(details("started"))
                advance()
            } catch (failure: NativeTargetFailure) { finish(failure.response()) }
            catch (failure: Throwable) { failTouch(failure) }
        }

        override fun start(complete: (JSONObject) -> Unit) {
            callback.set(complete)
            if (finished.get()) { deliver(); return }
            if (!mainHandler.post(begin)) finish(NativeTargetFailure("main_thread_unavailable").response())
        }

        override fun stop(reason: String) {
            stopReason.compareAndSet(null, reason)
            if (finished.get()) return
            if (dispatchGate.cancelQueued()) {
                mainHandler.removeCallbacks(begin)
                finishBeforeDown(stopReason.get()!!)
            } else mainHandler.post(step)
        }

        private fun advance() {
            if (finished.get()) return
            val current = target ?: return
            try {
                val elapsed = SystemClock.uptimeMillis() - downTime
                val fraction = (elapsed.toFloat() / request.durationMs).coerceIn(0f, 1f)
                val reason = stopReason.get() ?: when {
                    SystemClock.uptimeMillis() >= deadline -> "native_action_timeout"
                    !current.isCurrent() -> "native_gesture_window_changed"
                    else -> null
                }
                if (reason != null) {
                    val handled = touch(MotionEvent.ACTION_CANCEL, fraction)
                    val response = details("cancelled").put("ok", false).put("error", reason).put("handledCancel", handled)
                    recordInteraction(response)
                    finish(response); return
                }
                if (elapsed >= request.durationMs) {
                    val handled = touch(MotionEvent.ACTION_UP, 1f)
                    val response = details("completed").put("ok", true).put("handledUp", handled)
                    recordInteraction(response)
                    finish(response); return
                }
                if (request.action != "longPress" && elapsed > 0) touch(MotionEvent.ACTION_MOVE, fraction)
                mainHandler.removeCallbacks(step)
                if (!mainHandler.postDelayed(step, minOf(16L, request.durationMs - elapsed))) {
                    stopReason.compareAndSet(null, "main_thread_unavailable")
                    advance()
                }
            } catch (failure: Throwable) { failTouch(failure) }
        }

        private fun touch(action: Int, fraction: Float): Boolean {
            val current = target!!
            val x = current.startX + (current.endX - current.startX) * fraction
            val y = current.startY + (current.endY - current.startY) * fraction
            val event = nativeTouchEvent(downTime, SystemClock.uptimeMillis(), action, x, y, current.rootBounds)
            eventsSent++
            return try { CaptureActionContext.withActionId(request.actionId) { current.root.dispatchTouchEvent(event) } }
            finally { event.recycle() }
        }

        private fun details(completion: String): JSONObject = JSONObject()
            .put("action", request.action).put("type", request.action).put("actionId", request.actionId).put("completion", completion)
            .put("dispatched", eventsSent > 0).put("ambiguous", false).put("targetValidation", NativeTargetContract.SCHEMA)
            .put("targetRef", target!!.targetRef).put("windowType", target!!.windowType).put("durationMs", request.durationMs)
            .put("elapsedMs", SystemClock.uptimeMillis() - downTime).put("eventsSent", eventsSent).put("handledDown", handledDown)
            .put("startX", target?.startX).put("startY", target?.startY).put("endX", target?.endX).put("endY", target?.endY)

        private fun finishBeforeDown(reason: String) = finish(NativeTargetFailure(reason).response().put("actionId", request.actionId))

        private fun recordInteraction(response: JSONObject) {
            // Capture failure is separate from touch delivery. In particular it
            // must not send a second terminal event after a confirmed UP/CANCEL.
            try { interaction(request.actionId, response) }
            catch (error: Throwable) { evidenceError = error.javaClass.name }
            evidenceError?.let { response.put("evidenceError", it) }
        }

        private fun failTouch(failure: Throwable) {
            // A custom touch handler may have partially consumed an event before
            // throwing. Try to terminate that same stream, preserving uncertainty.
            var cancelError: String? = null
            if (eventsSent > 0) try { touch(MotionEvent.ACTION_CANCEL, 0f) } catch (error: Throwable) { cancelError = error.javaClass.name }
            finish(NativeTargetFailure("native_gesture_dispatch_failed", dispatched = eventsSent > 0).response()
                .put("actionId", request.actionId).put("ambiguous", eventsSent > 0)
                .put("cause", failure.javaClass.name).put("cancelError", cancelError ?: JSONObject.NULL))
        }

        private fun deliver() {
            val response = result.get() ?: return
            val complete = callback.get() ?: return
            if (delivered.compareAndSet(false, true)) complete(response)
        }

        private fun finish(response: JSONObject) {
            if (!finished.compareAndSet(false, true)) return
            mainHandler.removeCallbacks(begin); mainHandler.removeCallbacks(step)
            result.set(response.put("actionId", request.actionId)); deliver()
        }
    }
}
