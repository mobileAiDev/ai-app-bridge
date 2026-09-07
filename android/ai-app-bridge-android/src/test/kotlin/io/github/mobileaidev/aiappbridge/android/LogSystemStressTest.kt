package io.github.mobileaidev.aiappbridge.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class LogSystemStressTest {
    @Test
    fun parsesFiftyThousandLogcatLinesUnderBudget() {
        val lines = List(PARSE_COUNT) { index -> logcatLine(index, processId = 23521) }
        val startedAt = System.nanoTime()
        val parsed = lines.map(LogcatLineParser::parse)
        val elapsedMs = elapsedMs(startedAt)

        assertEquals(PARSE_COUNT, parsed.size)
        assertTrue(parsed.all { it.parsed && it.processId == 23521 })
        assertEquals(MobileFactPartition.APP_LOG, LogcatLineParser.partition(23521, 23521))
        assertTrue("parse $PARSE_COUNT lines took ${elapsedMs}ms", elapsedMs < 5_000)
        report("logcat-parse", mapOf("count" to PARSE_COUNT, "elapsedMs" to elapsedMs))
    }

    @Test
    fun collectorPersistsTwentyThousandLinesWithoutDrop() {
        val persisted = AtomicInteger(0)
        val done = CountDownLatch(1)
        val collector = ProcessLogcatCollector(
            openSource = { IndexedLogcatSource(COLLECTOR_COUNT) { logcatLine(it) } },
            persist = { line ->
                LogcatLineParser.partition(line.processId, 23521)
                if (persisted.incrementAndGet() == COLLECTOR_COUNT) {
                    done.countDown()
                }
            },
        )

        val startedAt = System.nanoTime()
        collector.start()
        assertTrue(done.await(8, TimeUnit.SECONDS))
        collector.stop()
        val elapsedMs = elapsedMs(startedAt)

        assertEquals(COLLECTOR_COUNT, persisted.get())
        report("logcat-collector", mapOf("count" to COLLECTOR_COUNT, "elapsedMs" to elapsedMs))
    }

    @Test
    fun h5DrainParserKeepsHookBufferCap() {
        val items = JSONArray()
        repeat(H5_BUFFER_CAP) { index ->
            items.put(
                JSONObject()
                    .put("method", if (index % 2 == 0) "log" else "warn")
                    .put("message", "h5-stress-$index")
                    .put("atMs", index.toLong()),
            )
        }
        val startedAt = System.nanoTime()
        val parsed = H5ConsoleDrainParser.parse(items.toString())
        val elapsedMs = elapsedMs(startedAt)

        assertEquals(H5_BUFFER_CAP, parsed.size)
        assertEquals("h5-stress-0", parsed.first().message)
        assertEquals("h5-stress-${H5_BUFFER_CAP - 1}", parsed.last().message)
        report("h5-drain-parse", mapOf("count" to H5_BUFFER_CAP, "elapsedMs" to elapsedMs))
    }

    @Test
    fun measuresCpuMemoryAndDiskAcrossPersistLoadTiers() {
        val tiers = listOf(
            LoadTier("low", 200),
            LoadTier("medium", 2_000),
            LoadTier("high", 10_000),
        )
        val results = JSONArray()
        for (tier in tiers) {
            results.put(runPersistLoad(tier))
        }
        writeMetrics("jvm-persist-load.json", results)
        report("persist-load-tiers", mapOf("tiers" to results.toString()))

        var previousDisk = 0L
        for (index in 0 until results.length()) {
            val row = results.getJSONObject(index)
            // Burst load may exceed the payload-byte budget even when the count limit is large.
            assertEquals(row.getInt("offered"), row.getInt("accepted") + row.getInt("queueFull"))
            assertEquals(row.getInt("accepted"), row.getInt("written"))
            assertEquals(row.getInt("queueFull"), row.getInt("dropped"))
            assertEquals(0, row.getLong("queuedPayloadBytes"))
            val disk = row.getLong("diskDeltaBytes")
            assertTrue("${row.getString("tier")} disk=$disk", disk > previousDisk)
            previousDisk = disk
        }
    }

    @Test
    fun persistPipelineWritesLogEnvelopesToMappedStore() {
        val directory = File.createTempFile("aab-log-stress-store-", "")
        assertTrue(directory.delete())
        assertTrue(directory.mkdirs())
        val store = SegmentedFactStore(maxQueuedRecords = PIPELINE_COUNT)
        try {
            assertTrue(awaitOperation { store.open(storeOptions(directory), it) }.isSuccess)
            val context = envelopeContext()
            val startedAt = System.nanoTime()
            var accepted = 0
            var queueFull = 0
            repeat(PIPELINE_COUNT) { index ->
                val line = LogcatLineParser.parse(logcatLine(index))
                val payload = persistEnvelope(context, line)
                when (store.record(payload.bytes, partitionId = payload.partitionId)) {
                    SegmentedFactRecordEnqueueResult.ACCEPTED -> accepted += 1
                    SegmentedFactRecordEnqueueResult.QUEUE_FULL -> queueFull += 1
                    else -> error("unexpected enqueue result")
                }
            }
            val status = awaitStatus(store, writtenAtLeast = accepted)
            val elapsedMs = elapsedMs(startedAt)

            assertTrue(accepted > 0)
            assertEquals(PIPELINE_COUNT, accepted + queueFull)
            assertEquals(accepted.toLong(), status.acceptedRecords)
            assertEquals(accepted.toLong(), status.writtenRecords)
            assertEquals(queueFull.toLong(), status.droppedRecords)
            assertEquals(0L, status.queuedPayloadBytes)
            report(
                "persist-pipeline",
                mapOf(
                    "count" to PIPELINE_COUNT,
                    "accepted" to accepted,
                    "written" to status.writtenRecords,
                    "dropped" to status.droppedRecords,
                    "elapsedMs" to elapsedMs,
                    "bytesPerFact" to persistEnvelope(context, LogcatLineParser.parse(logcatLine(0))).bytes.size,
                ),
            )
        } finally {
            awaitOperation { store.close(it) }
            directory.deleteRecursively()
        }
    }

    @Test
    fun slowWriterReportsQueueFullInsteadOfBlockingCaller() {
        val native = SlowNative(delayMs = 20)
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "log-stress-slow-writer").apply { isDaemon = true }
            },
            maxQueuedRecords = 32,
            flushIntervalMs = 60_000,
            maxUnflushedRecords = 1_000,
        )
        assertTrue(awaitOperation { store.open(storeOptions(File("build/log-stress-queue")), it) }.isSuccess)

        val startedAt = System.nanoTime()
        var accepted = 0
        var queueFull = 0
        repeat(QUEUE_STRESS_COUNT) {
            when (store.record(logEnvelopeBytes(it), partitionId = 2)) {
                SegmentedFactRecordEnqueueResult.ACCEPTED -> accepted += 1
                SegmentedFactRecordEnqueueResult.QUEUE_FULL -> queueFull += 1
                else -> error("unexpected enqueue result")
            }
        }
        val enqueueMs = elapsedMs(startedAt)
        val status = awaitStatus(store, writtenAtLeast = accepted)

        assertEquals(QUEUE_STRESS_COUNT, accepted + queueFull)
        assertTrue("queue should overflow under a slow writer, full=$queueFull", queueFull > 0)
        assertTrue("enqueue must stay off the writer, took ${enqueueMs}ms", enqueueMs < 1_000)
        assertEquals(accepted.toLong(), status.acceptedRecords)
        assertEquals(accepted.toLong(), status.writtenRecords)
        assertEquals(queueFull.toLong(), status.droppedRecords)
        awaitOperation { store.close(it) }
        report(
            "queue-full",
            mapOf(
                "offered" to QUEUE_STRESS_COUNT,
                "accepted" to accepted,
                "queueFull" to queueFull,
                "enqueueMs" to enqueueMs,
                "written" to status.writtenRecords,
            ),
        )
    }

    @Test
    fun concurrentLogcatAndConsoleEnvelopesReachTheStore() {
        val directory = File.createTempFile("aab-log-stress-concurrent-", "")
        assertTrue(directory.delete())
        assertTrue(directory.mkdirs())
        val store = SegmentedFactStore(maxQueuedRecords = CONCURRENT_PER_SOURCE * 3)
        try {
            assertTrue(awaitOperation { store.open(storeOptions(directory), it) }.isSuccess)
            val context = envelopeContext()
            val workers = Executors.newFixedThreadPool(3)
            val start = CountDownLatch(1)
            val finished = CountDownLatch(3)
            val accepted = AtomicInteger(0)
            val queueFull = AtomicInteger(0)
            val startedAt = System.nanoTime()
            listOf("logcat", "console", "sdk").forEach { source ->
                workers.execute {
                    start.await()
                    repeat(CONCURRENT_PER_SOURCE) { index ->
                        val payload = when (source) {
                            "logcat" -> persistEnvelope(context, LogcatLineParser.parse(logcatLine(index)))
                            "console" -> consoleEnvelope(context, index)
                            else -> sdkEnvelope(context, index)
                        }
                        when (store.record(payload.bytes, partitionId = payload.partitionId)) {
                            SegmentedFactRecordEnqueueResult.ACCEPTED -> accepted.incrementAndGet()
                            SegmentedFactRecordEnqueueResult.QUEUE_FULL -> queueFull.incrementAndGet()
                            else -> error("unexpected enqueue result")
                        }
                    }
                    finished.countDown()
                }
            }
            start.countDown()
            assertTrue(finished.await(10, TimeUnit.SECONDS))
            workers.shutdown()
            val offered = CONCURRENT_PER_SOURCE * 3
            val status = awaitStatus(store, writtenAtLeast = accepted.get())
            val elapsedMs = elapsedMs(startedAt)

            assertEquals(offered, accepted.get() + queueFull.get())
            assertEquals(accepted.get().toLong(), status.writtenRecords)
            assertEquals(queueFull.get().toLong(), status.droppedRecords)
            report(
                "concurrent-persist",
                mapOf(
                    "offered" to offered,
                    "written" to status.writtenRecords,
                    "queueFull" to queueFull.get(),
                    "elapsedMs" to elapsedMs,
                ),
            )
        } finally {
            awaitOperation { store.close(it) }
            directory.deleteRecursively()
        }
    }

    private fun runPersistLoad(tier: LoadTier): JSONObject {
        val directory = File.createTempFile("aab-log-load-${tier.name}-", "")
        assertTrue(directory.delete())
        assertTrue(directory.mkdirs())
        val store = SegmentedFactStore(maxQueuedRecords = tier.count.coerceAtLeast(256))
        val context = envelopeContext()
        val probe = ResourceProbe()
        try {
            assertTrue(awaitOperation { store.open(storeOptions(directory, appLogQuotaBytes = 32L * 1024L * 1024L), it) }.isSuccess)
            val before = probe.snapshot()
            val startedAt = System.nanoTime()
            val accepted = AtomicInteger(0)
            val queueFull = AtomicInteger(0)
            val done = CountDownLatch(1)
            val collector = ProcessLogcatCollector(
                openSource = { IndexedLogcatSource(tier.count) { logcatLine(it) } },
                persist = { line ->
                    val payload = persistEnvelope(context, line)
                    when (store.record(payload.bytes, partitionId = payload.partitionId)) {
                        SegmentedFactRecordEnqueueResult.ACCEPTED -> accepted.incrementAndGet()
                        SegmentedFactRecordEnqueueResult.QUEUE_FULL -> queueFull.incrementAndGet()
                        else -> error("unexpected enqueue result")
                    }
                    if (accepted.get() + queueFull.get() == tier.count) {
                        done.countDown()
                    }
                },
            )
            collector.start()
            assertTrue("${tier.name} collector timed out", done.await(30, TimeUnit.SECONDS))
            collector.stop()
            val status = awaitStatus(store, writtenAtLeast = accepted.get(), timeoutSec = 30)
            val elapsedNs = System.nanoTime() - startedAt
            val after = probe.snapshot()
            val diskBytes = directoryBytes(directory)
            val hostCpu = hostCpuPercent()
            return JSONObject()
                .put("tier", tier.name)
                .put("offered", tier.count)
                .put("accepted", accepted.get())
                .put("written", status.writtenRecords)
                .put("dropped", status.droppedRecords)
                .put("queueFull", queueFull.get())
                .put("queuedPayloadBytes", status.queuedPayloadBytes)
                .put("elapsedMs", TimeUnit.NANOSECONDS.toMillis(elapsedNs))
                .put("factsPerSec", if (elapsedNs == 0L) 0.0 else accepted.get() * 1_000_000_000.0 / elapsedNs)
                .put("cpuDeltaMs", TimeUnit.NANOSECONDS.toMillis((after.cpuNs - before.cpuNs).coerceAtLeast(0L)))
                .put("cpuPercent", cpuPercent(before.cpuNs, after.cpuNs, elapsedNs).takeIf { it > 0.0 } ?: hostCpu)
                .put("hostCpuPercent", hostCpu)
                .put("heapUsedBeforeBytes", before.heapUsed)
                .put("heapUsedAfterBytes", after.heapUsed)
                .put("heapDeltaBytes", after.heapUsed - before.heapUsed)
                .put("diskDeltaBytes", diskBytes)
                .put("storePayloadBytes", status.payloadBytes)
        } finally {
            awaitOperation { store.close(it) }
            directory.deleteRecursively()
        }
    }

    private fun persistEnvelope(
        context: MobileFactEnvelopeContext,
        line: CapturedLogLine,
    ): SanitizedFactPayload {
        val event = JSONObject()
            .put("type", "log")
            .put("source", "logcat")
            .put("level", line.level)
            .put("tag", line.tag)
            .put("message", line.message)
            .put("timestampMs", context.occurredAtMs)
            .put(
                "data",
                JSONObject()
                    .put("pid", line.processId)
                    .put("time", line.time)
                    .put("raw", line.raw),
            )
        return if (LogcatLineParser.partition(line.processId, 23521) == MobileFactPartition.DEVICE_LOG) {
            SanitizedFactPayload.deviceLog(context, event)
        } else {
            SanitizedFactPayload.log(context, event)
        }
    }

    private fun consoleEnvelope(context: MobileFactEnvelopeContext, index: Int): SanitizedFactPayload {
        val event = JSONObject()
            .put("type", "log")
            .put("source", "console")
            .put("level", "info")
            .put("tag", "console")
            .put("message", "h5-stress-$index")
            .put("timestampMs", context.occurredAtMs)
        return SanitizedFactPayload.log(context, event)
    }

    private fun sdkEnvelope(context: MobileFactEnvelopeContext, index: Int): SanitizedFactPayload {
        val event = JSONObject()
            .put("type", "log")
            .put("source", "sdk")
            .put("level", "debug")
            .put("tag", "NativeBridgeTest")
            .put("message", "manual native log event $index")
            .put("timestampMs", context.occurredAtMs)
        return SanitizedFactPayload.log(context, event)
    }

    private fun logEnvelopeBytes(index: Int): ByteArray =
        persistEnvelope(envelopeContext(), LogcatLineParser.parse(logcatLine(index))).bytes

    private fun envelopeContext() = MobileFactEnvelopeContext(
        platform = "android",
        packageName = "io.github.mobileaidev.aiappbridge.sample",
        bundleId = null,
        model = "PKR110",
        deviceIdentity = "sha256:stress",
        runtimeEpoch = "runtime-stress",
        actionId = null,
        occurredAtMs = 1_000L,
        observedAtMs = 1_010L,
    )

    private fun storeOptions(
        directory: File,
        appLogQuotaBytes: Long = 8L * 1024L * 1024L,
    ) = SegmentedFactStoreOptions(
        directory = directory,
        segmentSizeBytes = 256L * 1024L,
        flags = 1,
        partitionQuotas = longArrayOf(
            256L * 1024L,
            256L * 1024L,
            appLogQuotaBytes,
            2L * 1024L * 1024L,
            256L * 1024L,
            256L * 1024L,
            256L * 1024L,
            256L * 1024L,
        ),
        enabled = true,
        receiveObservationFacts = false,
    )

    private fun awaitOperation(
        action: ((SegmentedFactStoreOperationResult) -> Unit) -> Unit,
    ): SegmentedFactStoreOperationResult {
        val latch = CountDownLatch(1)
        lateinit var value: SegmentedFactStoreOperationResult
        action {
            value = it
            latch.countDown()
        }
        assertTrue(latch.await(10, TimeUnit.SECONDS))
        return value
    }

    private fun awaitStatus(
        store: SegmentedFactStore,
        writtenAtLeast: Int = 0,
        timeoutSec: Long = 15,
    ): SegmentedFactStoreStatus {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec)
        var last: SegmentedFactStoreStatus? = null
        while (System.nanoTime() < deadline) {
            val latch = CountDownLatch(1)
            lateinit var value: SegmentedFactStoreStatus
            store.status {
                value = it
                latch.countDown()
            }
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            last = value
            if (value.writtenRecords >= writtenAtLeast.toLong() && value.queuedRecords == 0) {
                return value
            }
        }
        return requireNotNull(last)
    }

    private class IndexedLogcatSource(
        private val count: Int,
        private val line: (Int) -> String,
    ) : LogcatLineSource {
        private var index = 0

        override fun readLine(): String? {
            if (index >= count) {
                return null
            }
            val current = index
            index += 1
            return line(current)
        }

        override fun close() = Unit
    }

    private class SlowNative(
        private val delayMs: Long,
    ) : SegmentedFactStoreNative {
        private val appended = AtomicInteger(0)

        override fun open(
            directory: String,
            segmentSizeBytes: Long,
            flags: Int,
            partitionQuotas: LongArray,
        ) = NativeOpenResult(
            SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK),
            handle = 1L,
        )

        override fun append(
            handle: Long,
            partitionId: Int,
            payload: ByteArray,
            durability: Int,
        ): NativeAppendResult {
            Thread.sleep(delayMs)
            return NativeAppendResult(
                SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK),
                sequence = appended.incrementAndGet().toLong(),
            )
        }

        override fun scan(
            handle: Long,
            cursor: SegmentedFactStoreCursor,
            bufferCapacity: Int,
        ) = SegmentedFactStoreReadResult(
            operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.END),
            cursor = cursor,
        )

        override fun status(handle: Long) = SegmentedFactStoreStatus(
            operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK),
            state = SegmentedFactStoreState.OPEN,
            enabled = true,
            queuedRecords = 0,
            acceptedRecords = 0,
            writtenRecords = 0,
            droppedRecords = 0,
        )

        override fun flush(handle: Long) =
            SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)

        override fun close(handle: Long) =
            SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }

    private data class LoadTier(val name: String, val count: Int)

    private class ResourceProbe {
        fun snapshot(): ResourceSnapshot {
            val runtime = Runtime.getRuntime()
            return ResourceSnapshot(
                cpuNs = processCpuNs(),
                heapUsed = runtime.totalMemory() - runtime.freeMemory(),
            )
        }

        private fun processCpuNs(): Long {
            return try {
                val factory = Class.forName("java.lang.management.ManagementFactory")
                val os = factory.getMethod("getOperatingSystemMXBean").invoke(null)
                val method = os.javaClass.methods.firstOrNull { it.name == "getProcessCpuTime" }
                method?.invoke(os) as? Long ?: 0L
            } catch (_: Throwable) {
                0L
            }
        }
    }

    private data class ResourceSnapshot(
        val cpuNs: Long,
        val heapUsed: Long,
    )

    private companion object {
        const val PARSE_COUNT = 50_000
        const val COLLECTOR_COUNT = 20_000
        const val H5_BUFFER_CAP = 1_000
        const val PIPELINE_COUNT = 2_000
        const val QUEUE_STRESS_COUNT = 200
        const val CONCURRENT_PER_SOURCE = 400

        fun logcatLine(index: Int, processId: Int = 23521): String {
            return "01-02 03:04:05.678 D/StressTag($processId): aab-log-stress-$index ${"x".repeat(64)}"
        }

        fun elapsedMs(startedAt: Long): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)

        fun cpuPercent(beforeCpuNs: Long, afterCpuNs: Long, elapsedNs: Long): Double {
            if (elapsedNs <= 0L || afterCpuNs < beforeCpuNs) {
                return 0.0
            }
            val processors = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
            return (afterCpuNs - beforeCpuNs).toDouble() / elapsedNs / processors * 100.0
        }

        fun hostCpuPercent(): Double {
            val pid = currentPid() ?: return 0.0
            return try {
                val process = ProcessBuilder("ps", "-o", "%cpu=", "-p", pid.toString()).start()
                val text = process.inputStream.bufferedReader().readText().trim()
                process.waitFor()
                text.lineSequence().lastOrNull()?.trim()?.toDouble() ?: 0.0
            } catch (_: Throwable) {
                0.0
            }
        }

        fun currentPid(): Long? {
            return try {
                val factory = Class.forName("java.lang.management.ManagementFactory")
                val runtime = factory.getMethod("getRuntimeMXBean").invoke(null)
                val name = runtime.javaClass.getMethod("getName").invoke(runtime) as String
                name.substringBefore("@").toLong()
            } catch (_: Throwable) {
                null
            }
        }

        fun directoryBytes(root: File): Long {
            if (!root.exists()) {
                return 0L
            }
            return root.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        }

        fun writeMetrics(name: String, payload: JSONArray) {
            val candidates = listOf(
                File("build/ai_app_bridge_artifacts/log-persist-perf"),
                File("../../build/ai_app_bridge_artifacts/log-persist-perf"),
            )
            val directory = candidates.firstOrNull { parent ->
                parent.exists() || parent.mkdirs()
            } ?: return
            File(directory, name).writeText(payload.toString(2) + "\n")
        }

        fun report(name: String, values: Map<String, Any>) {
            System.err.println("AAB_LOG_STRESS $name $values")
        }
    }
}
