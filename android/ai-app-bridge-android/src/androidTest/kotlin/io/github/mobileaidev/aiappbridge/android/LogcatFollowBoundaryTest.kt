package io.github.mobileaidev.aiappbridge.android

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LogcatFollowBoundaryTest {
    @Test fun followsNewLinesWithoutReplayingThePreviousRuntimeBuffer() {
        val tag = "AabLogcatBoundary"
        val marker = UUID.randomUUID().toString()
        val old = "previous-$marker"
        val current = "current-$marker"
        Log.i(tag, old)
        Thread.sleep(100)
        val command = logcatFollowCommand() + listOf("$tag:I", "*:S")
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val source = ProcessLogcatSource(process)
        val worker = Executors.newSingleThreadExecutor()
        try {
            val lines = worker.submit<List<String>> {
                val seen = mutableListOf<String>()
                source.use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        seen.add(line)
                        if (line.contains(current)) break
                    }
                }
                seen
            }
            Log.i(tag, current)
            val seen = lines.get(5, TimeUnit.SECONDS)
            val output = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,
                "logcat-follow-boundary-${System.currentTimeMillis()}.json")
            output.writeText(JSONObject().put("command", JSONArray(command)).put("lines", JSONArray(seen)).toString(2))
            assertTrue(seen.toString(), seen.any { it.contains(current) })
            assertFalse("Historical log replayed: $seen", seen.any { it.contains(old) })
        } finally {
            process.destroy()
            worker.shutdownNow()
        }
    }
}
