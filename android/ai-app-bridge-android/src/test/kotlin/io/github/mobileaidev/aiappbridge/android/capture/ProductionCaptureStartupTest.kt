package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Runs AiAppBridge's real lifecycle and registered onOpened listener, not a hand-wired backend. */
class ProductionCaptureStartupTest {
    @Test
    fun actualBridgeOpenListenerAttachesCaptureAndReattachesAfterMaintenance() {
        val directory = Files.createTempDirectory("capture-production-start-").toFile()
        val lifecycle = AiAppBridge.observationFactStoreLifecycle
        val configuration = configuration(directory)
        try {
            stop()
            AiAppBridge.captureStore.detachPersistentStore()
            lifecycle.start(configuration)
            awaitAttachment("attached")
            AiAppBridge.recordState("startup", "ready", "true")
            val page = LegacyLiveView.fromHttp(AiAppBridge.captureStore, "state", mapOf("view" to "decision-window"), 1)
            assertTrue(page.toString(), page.getBoolean("ok"))
            assertTrue(page.getJSONObject("coverage").getBoolean("committed"))
            val ref = page.getJSONArray("refs").getJSONObject(0).getString("mobileFactId")
            assertTrue(File(configuration.options.directory, "capture-store-v2.json").isFile)
            stop()
            AiAppBridge.captureStore.detachPersistentStore()
            lifecycle.start(configuration)
            awaitAttachment("attached")
            val reopened = LegacyLiveView.fromHttp(AiAppBridge.captureStore, "state",
                mapOf("view" to "connected-history", "mobileFactId" to ref), 2)
            assertEquals(ref, reopened.getJSONArray("refs").getJSONObject(0).getString("mobileFactId"))
            assertEquals("OPEN", AiAppBridge.capturePersistenceStatus().getString("lifecycleState"))
        } finally {
            stop()
            AiAppBridge.captureStore.detachPersistentStore()
            directory.deleteRecursively()
        }
    }

    @Test
    fun actualBridgeFailedOpenExposesErrorAndPreservesOldManifest() {
        val directory = Files.createTempDirectory("capture-production-failed-").toFile()
        val configuration = configuration(directory)
        configuration.options.directory.mkdirs()
        val manifest = File(configuration.options.directory, ".sfs-manifest")
        val invalid = ByteArray(4096)
        manifest.writeBytes(invalid)
        try {
            stop()
            AiAppBridge.captureStore.detachPersistentStore()
            AiAppBridge.observationFactStoreLifecycle.start(configuration)
            awaitAttachment("failed")
            val diagnostic = AiAppBridge.capturePersistenceStatus()
            assertFalse(diagnostic.getBoolean("persistent"))
            assertEquals("FAILED", diagnostic.getString("lifecycleState"))
            assertEquals(SegmentedFactStoreResultCode.CORRUPT, diagnostic.getJSONObject("operation").getInt("code"))
            assertTrue(diagnostic.getString("attachmentError").contains("manifest"))
            assertTrue(manifest.readBytes().contentEquals(invalid))
            assertFalse(File(configuration.options.directory, "capture-store-v2.json").exists())
            val page = LegacyLiveView.fromHttp(AiAppBridge.captureStore, "state", mapOf("view" to "decision-window"), 1)
            assertFalse(page.getJSONObject("coverage").getBoolean("committed"))
            assertEquals(0, page.getJSONArray("refs").length())
        } finally {
            stop()
            AiAppBridge.captureStore.detachPersistentStore()
            directory.deleteRecursively()
        }
    }

    @Test
    fun actualBridgeRejectsASealedTornTailWithoutTruncatingOrResettingIt() {
        val directory = Files.createTempDirectory("capture-production-sealed-tail-").toFile()
        val configuration = MobileFactStoreConfiguration("test", 8192,
            options = SegmentedFactStoreOptions(directory, segmentSizeBytes = 256,
                partitionQuotas = LongArray(8) { 1024L }, receiveObservationFacts = true))
        val native = MappedSegmentedFactStore()
        val opened = native.open(directory.absolutePath, 256, 1, configuration.options.partitionQuotas)
        assertTrue(opened.operation.isSuccess)
        repeat(2) { assertTrue(native.append(opened.handle, 0, ByteArray(80) { 7 }, 1).operation.isSuccess) }
        assertTrue(native.close(opened.handle).isSuccess)
        val sealed = directory.resolve("partition-0/segment-00000000000000000001.sfs")
        // An actually incomplete committed frame must still fail closed. The retained device
        // evidence separately revealed valid short zero padding, covered by the mapped-reader test.
        java.io.RandomAccessFile(sealed, "rw").use { it.seek(168); it.write(ByteArray(8)) }
        val oldSegment = sealed.readBytes()
        val oldManifest = directory.resolve(".sfs-manifest").readBytes()
        try {
            stop()
            AiAppBridge.captureStore.detachPersistentStore()
            AiAppBridge.observationFactStoreLifecycle.start(configuration)
            awaitAttachment("failed")
            val diagnostic = AiAppBridge.capturePersistenceStatus()
            assertFalse(diagnostic.getBoolean("persistent"))
            assertEquals(SegmentedFactStoreResultCode.CORRUPT, diagnostic.getJSONObject("operation").getInt("code"))
            assertEquals("sealed segment 1 has a torn tail", diagnostic.getString("attachmentError"))
            assertTrue(sealed.readBytes().contentEquals(oldSegment))
            assertTrue(directory.resolve(".sfs-manifest").readBytes().contentEquals(oldManifest))
            assertFalse(directory.resolve("capture-store-v2.json").exists())
        } finally {
            stop()
            AiAppBridge.captureStore.detachPersistentStore()
            directory.deleteRecursively()
        }
    }

    private fun configuration(directory: File) = MobileFactStoreConfiguration("test", 8 * 1024 * 1024,
        options = SegmentedFactStoreOptions(directory.resolve("test"), segmentSizeBytes = 64 * 1024,
            partitionQuotas = LongArray(8) { 1024L * 1024 }, receiveObservationFacts = true))

    private fun awaitAttachment(expected: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            val status = AiAppBridge.capturePersistenceStatus()
            val persistent = status.getBoolean("persistent")
            val terminalMatches = if (expected == "failed") {
                status.getString("lifecycleState") == "FAILED" &&
                    status.optString("attachmentError") == status.getJSONObject("operation").getString("message")
            } else status.getString("lifecycleState") == "OPEN" && persistent
            if (status.getString("attachmentState") == expected && terminalMatches) return
            Thread.sleep(5)
        }
        fail("Expected $expected but saw ${AiAppBridge.capturePersistenceStatus()}")
    }

    private fun stop() {
        val lifecycle = AiAppBridge.observationFactStoreLifecycle
        lifecycle.stop()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (lifecycle.snapshot().lifecycleState != SegmentedFactStoreState.CLOSED && System.nanoTime() < deadline) Thread.sleep(5)
        assertEquals(SegmentedFactStoreState.CLOSED, lifecycle.snapshot().lifecycleState)
    }
}
