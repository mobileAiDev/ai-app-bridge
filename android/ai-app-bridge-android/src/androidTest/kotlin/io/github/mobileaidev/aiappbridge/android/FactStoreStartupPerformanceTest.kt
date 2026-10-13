package io.github.mobileaidev.aiappbridge.android

import android.os.Debug
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Exercises retained frame recovery, including the unused tails of all eight partitions. */
class FactStoreStartupPerformanceTest {
    @Test fun retainedRecordsAndEmptyPartitionsReopenWithoutSecondsOfCpuScanning() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "fact-startup-${System.nanoTime()}").apply { mkdirs() }
        val report = JSONObject()
        val samples = JSONArray()
        val segmentBytes = 2L * 1024 * 1024
        val quotas = LongArray(8) { segmentBytes * 2 }
        val payload = ByteArray(24 * 1024) { ((it * 31 + 7) and 255).toByte() }
        val records = 64
        try {
            val initial = MappedSegmentedFactStore()
            val opened = initial.open(directory.path, segmentBytes, 1, quotas)
            assertTrue(opened.operation.isSuccess)
            repeat(records) { assertTrue(initial.append(opened.handle, 2, payload, 0).operation.isSuccess) }
            assertTrue(initial.close(opened.handle).isSuccess)
            // Appends warm this process's byte-buffer and CRC methods. Recover the
            // same retained files in a fresh ART process before the warm controls.
            val process = ProcessBuilder("/system/bin/app_process", "/system/bin",
                FactStoreColdRecoveryProbe::class.java.name, directory.path).apply {
                environment()["CLASSPATH"] = InstrumentationRegistry.getInstrumentation().context.applicationInfo.sourceDir
                redirectErrorStream(true)
            }.start()
            val worker = Executors.newSingleThreadExecutor()
            try {
                val output = worker.submit<String> { process.inputStream.bufferedReader().readText() }.get(45, TimeUnit.SECONDS)
                assertEquals(output.takeLast(2000), 0, process.waitFor())
                val cold = JSONObject(output.lineSequence().last { it.startsWith("{") })
                report.put("cold", cold)
                assertTrue(cold.toString(), cold.getBoolean("ok"))
                assertEquals(records.toLong(), cold.getLong("records"))
            } finally { process.destroy(); worker.shutdownNow() }
            repeat(3) {
                val store = MappedSegmentedFactStore()
                val cpu = Debug.threadCpuTimeNanos()
                val began = SystemClock.elapsedRealtimeNanos()
                val reopened = store.open(directory.path, segmentBytes, 1, quotas)
                val elapsedMs = (SystemClock.elapsedRealtimeNanos() - began) / 1_000_000.0
                val cpuMs = (Debug.threadCpuTimeNanos() - cpu) / 1_000_000.0
                samples.put(JSONObject().put("elapsedMs", elapsedMs).put("cpuMs", cpuMs))
                try {
                    assertTrue(reopened.operation.toString(), reopened.operation.isSuccess)
                    assertEquals(records.toLong(), store.status(reopened.handle).recordCount)
                    var cursor = SegmentedFactStoreCursor(partitionId = 2)
                    repeat(records) { index ->
                        val row = store.scan(reopened.handle, cursor, payload.size)
                        assertEquals(index + 1L, row.record?.sequence)
                        assertArrayEquals(payload, row.record?.payload)
                        cursor = row.cursor
                    }
                    assertTrue(store.scan(reopened.handle, cursor, payload.size).isEnd)
                } finally { store.close(reopened.handle) }
            }
            report.put("records", records).put("payloadBytes", records * payload.size)
                .put("segmentBytes", segmentBytes).put("partitions", quotas.size).put("samples", samples)
                .put("cpuBudgetMs", 1500).put("coldCpuBudgetMs", 1500)
            assertTrue("Cold recovery exceeds 1.5 s CPU; see fact-store-startup-performance.json",
                report.getJSONObject("cold").getDouble("cpuMs") < 1500)
            assertTrue("Reopening 16 MiB of segments exceeds 1.5 s CPU; see fact-store-startup-performance.json",
                (0 until samples.length()).all { samples.getJSONObject(it).getDouble("cpuMs") < 1500 })
        } finally {
            report.put("samples", samples)
            File(context.filesDir, "fact-store-startup-performance.json").writeText(report.toString(2))
            directory.deleteRecursively()
        }
    }
}

/** No Application, Bridge startup, or writes in this process before the recovery timer. */
object FactStoreColdRecoveryProbe {
    @JvmStatic fun main(args: Array<String>) {
        val store = MappedSegmentedFactStore()
        val cpu = Debug.threadCpuTimeNanos()
        val began = SystemClock.elapsedRealtimeNanos()
        val opened = store.open(args.single(), 2L * 1024 * 1024, 1, LongArray(8) { 4L * 1024 * 1024 })
        val elapsedMs = (SystemClock.elapsedRealtimeNanos() - began) / 1_000_000.0
        val cpuMs = (Debug.threadCpuTimeNanos() - cpu) / 1_000_000.0
        val report = JSONObject().put("ok", opened.operation.isSuccess).put("elapsedMs", elapsedMs)
            .put("cpuMs", cpuMs).put("operation", opened.operation.toString())
        try {
            if (opened.operation.isSuccess) report.put("records", store.status(opened.handle).recordCount)
        } finally { store.close(opened.handle) }
        println(report.toString())
    }
}
