package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ObservationFactStoreLifecycleTest {
    @Test
    fun autoProfilesUseEightBoundedHardQuotas() {
        val default = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/profile-default"),
            totalBytes = 32L * GIB,
            availableBytes = 8L * GIB,
        )
        val large = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/profile-large"),
            totalBytes = 16L * GIB,
            availableBytes = 4L * GIB,
        )
        val medium = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/profile-medium"),
            totalBytes = 4L * GIB,
            availableBytes = 2L * GIB,
        )
        val small = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/profile-small"),
            totalBytes = 3L * GIB,
            availableBytes = 1L * GIB,
        )
        val lowDisk = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/profile-low-disk"),
            totalBytes = 3L * GIB,
            availableBytes = 300L * MIB,
        )

        assertEquals("1gb", default.profile)
        assertEquals(GIB, default.budgetBytes)
        assertEquals(4L * MIB, default.options.segmentSizeBytes)
        assertEquals("512mb", large.profile)
        assertEquals(512L * MIB, large.budgetBytes)
        assertEquals(4L * MIB, large.options.segmentSizeBytes)
        assertEquals("256mb", medium.profile)
        assertEquals(2L * MIB, medium.options.segmentSizeBytes)
        assertEquals("64mb", small.profile)
        assertEquals(512L * 1024L, small.options.segmentSizeBytes)
        assertEquals("off-low-disk", lowDisk.profile)
        assertEquals(0L, lowDisk.budgetBytes)
        assertEquals("insufficient-space", lowDisk.disabledReason)
        assertFalse(lowDisk.options.enabled)
        assertTrue(lowDisk.options.partitionQuotas.all { it == 0L })
        for (configuration in listOf(default, large, medium, small)) {
            assertEquals(8, configuration.options.partitionQuotas.size)
            assertTrue(configuration.options.partitionQuotas.all {
                it >= configuration.options.segmentSizeBytes &&
                    it % configuration.options.segmentSizeBytes == 0L
            })
            assertTrue(configuration.options.partitionQuotas.sum() <= configuration.budgetBytes)
            assertEquals(configuration.profile, configuration.options.directory.name)
        }
    }

    @Test
    fun eachDeviceAppSandboxOwnsItsFullQuotaWithoutCrossEviction() {
        val first = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/device-a-app-a"),
            totalBytes = 32L * GIB,
            availableBytes = 8L * GIB,
        )
        val second = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/device-b-app-b"),
            totalBytes = 32L * GIB,
            availableBytes = 8L * GIB,
        )

        assertEquals(GIB, first.budgetBytes)
        assertEquals(GIB, second.budgetBytes)
        assertNotEquals(first.options.directory.absolutePath, second.options.directory.absolutePath)
        assertEquals(first.options.partitionQuotas.toList(), second.options.partitionQuotas.toList())
    }

    @Test
    fun lowDiskProfileDisablesPersistenceWithoutAllocatingTheMinimumBudget() {
        val configuration = MobileFactStoreProfiles.configuration(
            baseDirectory = File("build/profile-low-disk-lifecycle"),
            totalBytes = 3L * GIB,
            availableBytes = 300L * MIB,
        )
        val store = SegmentedFactStore(maxQueuedRecords = 4)
        val lifecycle = ObservationFactStoreLifecycle(store)

        lifecycle.start(configuration)
        val status = awaitStatus(lifecycle) {
            it.lifecycleState == SegmentedFactStoreState.DISABLED
        }

        assertTrue(status.desiredRunning)
        assertEquals("off-low-disk", status.profile)
        assertEquals("insufficient-space", status.disabledReason)
        assertEquals(SegmentedFactStoreState.DISABLED, status.store.state)
        assertEquals(SegmentedFactRecordEnqueueResult.DISABLED, store.record(byteArrayOf(1)))
        lifecycle.stop()
    }

    @Test
    fun failedProductionOpenRemainsDiagnosableWithoutRewritingTheExistingStore() {
        val base = Files.createTempDirectory("capture-open-failure-").toFile()
        val configuration = MobileFactStoreProfiles.configuration(base, 3L * GIB, 1L * GIB)
        configuration.options.directory.mkdirs()
        val manifest = File(configuration.options.directory, ".sfs-manifest")
        val original = ByteArray(4096)
        manifest.writeBytes(original)
        val store = SegmentedFactStore(maxQueuedRecords = 4)
        val lifecycle = ObservationFactStoreLifecycle(store)
        try {
            lifecycle.start(configuration)
            val failed = awaitStatus(lifecycle) { it.lifecycleState == SegmentedFactStoreState.FAILED }
            assertEquals(SegmentedFactStoreResultCode.CORRUPT, failed.store.operation.code)
            // The same synchronous snapshot is what a production status endpoint can expose.
            assertEquals(SegmentedFactStoreResultCode.CORRUPT, lifecycle.snapshot().store.operation.code)
            assertTrue(lifecycle.snapshot().store.operation.message.contains("manifest"))
            assertTrue(manifest.readBytes().contentEquals(original))
        } finally {
            lifecycle.stop()
            base.deleteRecursively()
        }
    }

    @Test
    fun lifecycleCoalescesOpenAndReopensOnlyAfterAnInFlightClose() {
        val store = FakeLifecycleStore()
        val lifecycle = ObservationFactStoreLifecycle(store)
        val first = configuration("first")
        val second = configuration("second")

        lifecycle.start(first)
        lifecycle.start(first)
        assertEquals(1, store.openCount)

        lifecycle.stop()
        assertEquals(1, store.closeCount)
        lifecycle.start(second)
        assertEquals(1, store.openCount)

        store.completeOpen()
        assertEquals(1, store.openCount)
        store.completeClose()
        assertEquals(2, store.openCount)
        assertEquals(second.options.directory, store.lastOptions?.directory)
    }

    @Test
    fun lifecycleCreatesARealStoreAndExposesProfileStatus() {
        val base = Files.createTempDirectory("ai-app-bridge-mobile-lifecycle-").toFile()
        try {
            val configuration = MobileFactStoreProfiles.configuration(
                baseDirectory = base,
                totalBytes = 3L * GIB,
                availableBytes = 1L * GIB,
            )
            val store = SegmentedFactStore(maxQueuedRecords = 8)
            val lifecycle = ObservationFactStoreLifecycle(store)

            lifecycle.start(configuration)
            var status = awaitStatus(lifecycle) { it.store.state == SegmentedFactStoreState.OPEN }
            assertTrue(status.desiredRunning)
            assertEquals("64mb", status.profile)
            assertEquals(configuration.options.directory.absolutePath, status.directory)
            assertEquals(8, status.partitionQuotas.size)

            val context = factContext()
            listOf(
                SanitizedFactPayload.event(
                    context,
                    "ui",
                    "ui.changed",
                    JSONObject().put("nodeCount", 1),
                ),
                SanitizedFactPayload.network(context, JSONObject().put("url", "https://example.test")),
                SanitizedFactPayload.log(context, JSONObject().put("message", "ready")),
                SanitizedFactPayload.state(context, JSONObject().put("key", "cart")),
            ).forEach(AndroidObservationFactStoreRegistry::enqueue)
            status = awaitStatus(lifecycle) { it.store.writtenRecords == 4L }
            assertEquals(4L, status.store.writtenRecords)
            assertEquals(4L, status.store.recordCount)
            assertTrue(File(configuration.options.directory, ".sfs-manifest").isFile)
            for (partitionId in listOf(0, 1, 2, 4)) {
                assertTrue(
                    File(configuration.options.directory, "partition-$partitionId")
                    .listFiles()
                    .orEmpty()
                    .any { it.name.endsWith(".sfs") },
                )
            }
            lifecycle.stop()
            status = awaitStatus(lifecycle) { it.store.state == SegmentedFactStoreState.CLOSED }
            assertFalse(status.desiredRunning)
            assertEquals(SegmentedFactRecordEnqueueResult.CLOSED, store.record(byteArrayOf(1)))
        } finally {
            base.deleteRecursively()
        }
    }

    private fun configuration(name: String) = MobileFactStoreProfiles.configuration(
        baseDirectory = File("build/$name"),
        totalBytes = 3L * GIB,
        availableBytes = 1L * GIB,
    )

    private fun factContext() = MobileFactEnvelopeContext(
        platform = "android",
        packageName = "com.example.app",
        bundleId = null,
        model = "test",
        deviceIdentity = "sha256:test",
        runtimeEpoch = "runtime-test",
        actionId = null,
        occurredAtMs = 100,
        observedAtMs = 100,
    )

    private fun awaitStatus(
        lifecycle: ObservationFactStoreLifecycle,
        predicate: (ObservationFactStoreRuntimeStatus) -> Boolean,
    ): ObservationFactStoreRuntimeStatus {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        var last: ObservationFactStoreRuntimeStatus? = null
        while (System.nanoTime() < deadline) {
            val latch = CountDownLatch(1)
            lifecycle.status {
                last = it
                latch.countDown()
            }
            assertTrue(latch.await(1, TimeUnit.SECONDS))
            if (last?.let(predicate) == true) return requireNotNull(last)
            Thread.sleep(10)
        }
        throw AssertionError("fact store status did not reach expected state: $last")
    }

    private class FakeLifecycleStore : ObservationFactStore {
        var openCount = 0
        var closeCount = 0
        var lastOptions: SegmentedFactStoreOptions? = null
        private val openCompletions = ArrayDeque<(SegmentedFactStoreOperationResult) -> Unit>()
        private val closeCompletions = ArrayDeque<(SegmentedFactStoreOperationResult) -> Unit>()

        override fun open(
            configuration: MobileFactStoreConfiguration,
            completion: (SegmentedFactStoreOperationResult) -> Unit,
        ) {
            openCount += 1
            lastOptions = configuration.options
            openCompletions.addLast(completion)
        }

        override fun close(completion: (SegmentedFactStoreOperationResult) -> Unit) {
            closeCount += 1
            closeCompletions.addLast(completion)
        }

        override fun status(completion: (SegmentedFactStoreStatus) -> Unit) {
            completion(closedStatus())
        }

        fun completeOpen() {
            openCompletions.removeFirst()(ok())
        }

        fun completeClose() {
            closeCompletions.removeFirst()(ok())
        }

        private fun closedStatus() = SegmentedFactStoreStatus(
            operation = ok(),
            state = SegmentedFactStoreState.CLOSED,
            enabled = false,
            queuedRecords = 0,
            acceptedRecords = 0,
            writtenRecords = 0,
            droppedRecords = 0,
        )

        private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }

    private companion object {
        const val MIB = 1024L * 1024L
        const val GIB = 1024L * MIB
    }
}
