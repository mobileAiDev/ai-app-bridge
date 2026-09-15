package io.github.mobileaidev.aiappbridge.android

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class UiObserverPerformanceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val main = Handler(Looper.getMainLooper())
    private val mainThread = Looper.getMainLooper().thread

    @Test fun compareContinuousObservationOnOffOn() {
        assumeTrue("Opt-in performance diagnostic", InstrumentationRegistry.getArguments().getString("uiObserverPerformance") == "true")
        val activity = instrumentation.startActivitySync(
            Intent(instrumentation.targetContext, UiObserverPerformanceActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        ) as UiObserverPerformanceActivity
        val observer = AiAppBridge::class.java.getDeclaredField("uiObserver").apply {
            isAccessible = true
        }.get(null) as AndroidUiObserver
        val report = JSONObject()
            .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
            .put("api", Build.VERSION.SDK_INT).put("packageName", activity.packageName)
            .put("fixture", "600 static text rows; one small redrawing view; same Activity throughout")
        try {
            assertFalse(onMain { observer.status().getBoolean("active") })
            Thread.sleep(700)
            assertEquals(0L, onMain { observer.status().getLong("sampleCount") })
            onMain { observer.stop() }
            Thread.sleep(1000)
            val discover = AndroidUiObserver::class.java.getDeclaredMethod("discoverWindowRoots", Activity::class.java).apply { isAccessible = true }
            val capture = AndroidUiObserver::class.java.getDeclaredMethod("captureFingerprint", Activity::class.java, List::class.java).apply { isAccessible = true }
            val captureTimes = JSONArray()
            repeat(7) {
                captureTimes.put(onMain {
                    val roots = discover.invoke(observer, activity)
                    val cpu = Debug.threadCpuTimeNanos()
                    val start = SystemClock.elapsedRealtimeNanos()
                    val fingerprint = capture.invoke(observer, activity, roots) as UiFingerprint
                    JSONObject().put("elapsedMs", (SystemClock.elapsedRealtimeNanos() - start) / 1_000_000.0)
                        .put("cpuMs", (Debug.threadCpuTimeNanos() - cpu) / 1_000_000.0)
                        .put("nodes", fingerprint.nodeCount).put("truncated", fingerprint.truncated)
                })
            }
            report.put("singleFingerprint", captureTimes)
            val phases = JSONArray()
            for ((name, enabled) in listOf("enabled-1" to true, "disabled" to false, "enabled-2" to true, "static-enabled" to true, "static-disabled" to false)) {
                onMain {
                    activity.pulse.continuousRedraw = !name.startsWith("static-")
                    observer.stop()
                    if (enabled) {
                        observer.attach(activity, "performance-probe")
                        assertTrue(observer.control(JSONObject().put("operation", "start").put("durationMs", 5000)).getBoolean("active"))
                    }
                }
                Thread.sleep(500)
                phases.put(measurePhase(name, activity))
                phases.getJSONObject(phases.length() - 1).put("observer", onMain { observer.status() })
            }
            report.put("phases", phases)
            val peak = maxOf(phases.getJSONObject(0).getDouble("mainCpuPercent"), phases.getJSONObject(2).getDouble("mainCpuPercent"))
            report.put("continuousObserverCpuBudgetPercent", 25).put("withinCpuBudget", peak < 25.0)
            onMain {
                observer.stop()
                observer.control(JSONObject().put("operation", "start").put("durationMs", 200))
            }
            Thread.sleep(500)
            assertFalse(onMain { observer.status().getBoolean("sampling") })
            val count = onMain { observer.status().getLong("sampleCount") }
            onMain { observer.onLifecycle(activity, "resumed") }
            Thread.sleep(500)
            assertEquals(count, onMain { observer.status().getLong("sampleCount") })
            report.put("expiryAndResumeRemainOff", true)
        } finally {
            onMain { observer.stop() }
            File(activity.filesDir, "ui-observer-performance.json").writeText(report.toString(2))
            onMain { activity.finish() }
        }
        assertTrue("Continuous UI observation exceeds 25% of one main-thread CPU; see ui-observer-performance.json", report.getBoolean("withinCpuBudget"))
    }

    private fun measurePhase(name: String, activity: UiObserverPerformanceActivity): JSONObject {
        val before = onMain { Triple(SystemClock.elapsedRealtimeNanos(), Debug.threadCpuTimeNanos(), activity.pulse.frames) }
        val delays = Collections.synchronizedList(mutableListOf<Double>())
        val samples = JSONArray()
        // Vary the interval so a 100 ms probe cannot alias the observer's 100 ms timer.
        val intervals = longArrayOf(73, 97, 113, 137, 83, 127, 109, 89)
        repeat(40) { index ->
            val stack = mainThread.stackTrace
            samples.put(JSONObject()
                .put("fingerprint", stack.any { frame -> frame.className.endsWith("AndroidUiObserver") && frame.methodName == "captureFingerprint" })
                .put("idle", stack.any { frame -> frame.className == "android.os.MessageQueue" && frame.methodName == "nativePollOnce" })
                .put("stack", JSONArray(stack.map { frame -> frame.toString() })))
            val submitted = SystemClock.elapsedRealtimeNanos()
            main.post { delays.add((SystemClock.elapsedRealtimeNanos() - submitted) / 1_000_000.0) }
            Thread.sleep(intervals[index % intervals.size])
        }
        val after = onMain { Triple(SystemClock.elapsedRealtimeNanos(), Debug.threadCpuTimeNanos(), activity.pulse.frames) }
        val elapsed = (after.first - before.first) / 1_000_000.0
        val cpu = (after.second - before.second) / 1_000_000.0
        val sorted = synchronized(delays) { delays.sorted() }
        return JSONObject().put("name", name).put("elapsedMs", elapsed).put("mainCpuMs", cpu)
            .put("mainCpuPercent", cpu / elapsed * 100).put("frames", after.third - before.third)
            .put("fingerprintSamples", (0 until samples.length()).count { samples.getJSONObject(it).getBoolean("fingerprint") })
            .put("idleSamples", (0 until samples.length()).count { samples.getJSONObject(it).getBoolean("idle") })
            .put("mainQueueDelayMs", JSONObject().put("median", sorted[sorted.size / 2])
                .put("p95", sorted[((sorted.size - 1) * 0.95).toInt()]).put("max", sorted.last()))
            .put("samples", samples)
    }

    private fun <T> onMain(action: () -> T): T {
        val done = CountDownLatch(1)
        var result: Result<T>? = null
        main.post { result = runCatching(action); done.countDown() }
        check(done.await(30, TimeUnit.SECONDS)) { "Main thread did not respond within 30 seconds" }
        return result!!.getOrThrow()
    }
}
