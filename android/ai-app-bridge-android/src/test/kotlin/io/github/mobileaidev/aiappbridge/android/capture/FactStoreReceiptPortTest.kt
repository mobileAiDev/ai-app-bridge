package io.github.mobileaidev.aiappbridge.android.capture

import io.github.mobileaidev.aiappbridge.android.NativeAppendResult
import io.github.mobileaidev.aiappbridge.android.NativeOpenResult
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStore
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreCursor
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreNative
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreOperationResult
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreOptions
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreReadResult
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreRecord
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreResultCode
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreState
import io.github.mobileaidev.aiappbridge.android.SegmentedFactStoreStatus
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class FactStoreReceiptPortTest {
    @Test
    fun acceptedCommittedQueueClosedAndDisabledAreDistinct() {
        val directory = Files.createTempDirectory("g2-receipt-").toFile()
        try {
            val store = SegmentedFactStore(maxQueuedRecords = 4)
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256,
                partitionQuotas = longArrayOf(1024),
                receiveObservationFacts = false,
            )
            assertTrue(awaitOpen(store, options))
            val port = FactStoreReceiptPort(store, directory)
            val payload = "g2-fact".toByteArray()
            val accepted = port.appendWithReceipt(payload)
            assertEquals("accepted", accepted.status)
            assertTrue(accepted.accepted)
            assertFalse(accepted.committed)
            assertNotNull(accepted.mobileFactId)
            assertEquals(0, port.throughWatermark().throughSequence)

            val immediate = port.readPage(FactCursor(accepted.storeGeneration), 8)
            assertEquals(1, immediate.items.size)
            assertEquals(accepted.mobileFactId, immediate.items.single().mobileFactId)
            assertFalse(immediate.items.single().committed)

            val committed = port.commitWait(accepted.mobileFactId!!, 2_000)
            assertEquals("committed", committed.status)
            assertTrue(committed.committed)
            assertEquals(committed.globalSequence, port.throughWatermark().throughSequence)
            val afterCommit = port.readPage(FactCursor(accepted.storeGeneration), 8)
            assertEquals(1, afterCommit.items.size)
            assertTrue(afterCommit.items.single().committed)

            val tooLarge = port.appendWithReceipt(ByteArray(SegmentedFactStore.MAX_PERSISTED_PAYLOAD_BYTES + 1))
            assertEquals("payload-too-large", tooLarge.status)
            assertFalse(tooLarge.accepted)

            val oldGeneration = accepted.storeGeneration
            port.clear()
            val stale = port.readPage(FactCursor(oldGeneration), 8)
            assertTrue(stale.generationMismatch)
            assertTrue(stale.items.isEmpty())

            awaitClose(store)
            val closed = port.appendWithReceipt("after-close".toByteArray())
            assertEquals("closed", closed.status)

            val disabledStore = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(
                awaitOpen(
                    disabledStore,
                    options.copy(directory = directory.resolve("disabled"), enabled = false),
                ),
            )
            val disabled = FactStoreReceiptPort(disabledStore, directory.resolve("disabled"))
                .appendWithReceipt("nope".toByteArray())
            assertEquals("disabled", disabled.status)
            awaitClose(disabledStore)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun queueFullIsDistinctWhenWriterIsBlocked() {
        val directory = Files.createTempDirectory("g2-queue-full-").toFile()
        val native = BlockingFakeNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "g2-queue-full").apply { isDaemon = true }
            },
            maxQueuedRecords = 1,
        )
        try {
            assertTrue(
                awaitOpen(
                    store,
                    SegmentedFactStoreOptions(
                        directory = directory,
                        segmentSizeBytes = 256,
                        partitionQuotas = longArrayOf(1024),
                        receiveObservationFacts = false,
                    ),
                ),
            )
            val port = FactStoreReceiptPort(store, directory)
            val first = port.appendWithReceipt("held".toByteArray())
            assertEquals("accepted", first.status)
            val full = port.appendWithReceipt("overflow".toByteArray())
            assertEquals("queue-full", full.status)
            assertFalse(full.accepted)
            assertEquals(null, full.mobileFactId)
        } finally {
            native.release.countDown()
            awaitClose(store)
            directory.deleteRecursively()
        }
    }

    @Test
    fun largeFactCommitAndReopenHydratesPayload() {
        val directory = Files.createTempDirectory("g2-large-").toFile()
        try {
            val payload = ByteArray(70 * 1024) { 7 }
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256 * 1024,
                partitionQuotas = longArrayOf(1024 * 1024),
                receiveObservationFacts = false,
            )
            val firstStore = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(firstStore, options))
            val firstPort = FactStoreReceiptPort(firstStore, directory)
            val accepted = firstPort.appendWithReceipt(payload)
            assertEquals("accepted", accepted.status)
            val committed = firstPort.commitWait(accepted.mobileFactId!!, 2_000)
            assertEquals("committed", committed.status)
            val drain = firstPort.flushDrain(2_000)
            assertTrue(drain.ok)
            awaitClose(firstStore)

            val reopened = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(reopened, options))
            val port = FactStoreReceiptPort(reopened, directory)
            val page = port.readPage(FactCursor(accepted.storeGeneration), 8)
            assertEquals(1, page.items.size)
            assertArrayEquals(payload, page.items.single().payload)
            awaitClose(reopened)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun flushDrainInvokesNativeFlush() {
        val directory = Files.createTempDirectory("g2-flush-").toFile()
        val native = CountingFlushNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "g2-flush").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
        )
        try {
            assertTrue(
                awaitOpen(
                    store,
                    SegmentedFactStoreOptions(
                        directory = directory,
                        segmentSizeBytes = 256,
                        partitionQuotas = longArrayOf(1024),
                        receiveObservationFacts = false,
                    ),
                ),
            )
            val port = FactStoreReceiptPort(store, directory)
            assertEquals("accepted", port.appendWithReceipt("flush-me".toByteArray()).status)
            val drain = port.flushDrain(2_000)
            assertTrue(drain.ok)
            assertTrue(native.flushCount >= 1)
        } finally {
            awaitClose(store)
            directory.deleteRecursively()
        }
    }

    @Test
    fun postAcceptWriteFailureBecomesDropped() {
        val directory = Files.createTempDirectory("g2-dropped-").toFile()
        val native = FailingAppendNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "g2-dropped").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
        )
        try {
            assertTrue(
                awaitOpen(
                    store,
                    SegmentedFactStoreOptions(
                        directory = directory,
                        segmentSizeBytes = 256,
                        partitionQuotas = longArrayOf(1024),
                        receiveObservationFacts = false,
                    ),
                ),
            )
            val port = FactStoreReceiptPort(store, directory)
            val accepted = port.appendWithReceipt("will-drop".toByteArray())
            assertEquals("accepted", accepted.status)
            val waited = port.commitWait(accepted.mobileFactId!!, 2_000)
            assertEquals("dropped", waited.status)
            assertFalse(waited.accepted)
            assertFalse(waited.committed)
        } finally {
            awaitClose(store)
            directory.deleteRecursively()
        }
    }

    @Test
    fun flushFailureIsNotASuccessfulDrain() {
        val directory = Files.createTempDirectory("g2-flush-fail-").toFile()
        val native = FailingFlushNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "g2-flush-fail").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
        )
        try {
            assertTrue(
                awaitOpen(
                    store,
                    SegmentedFactStoreOptions(
                        directory = directory,
                        segmentSizeBytes = 256,
                        partitionQuotas = longArrayOf(1024),
                        receiveObservationFacts = false,
                    ),
                ),
            )
            val port = FactStoreReceiptPort(store, directory)
            assertEquals("accepted", port.appendWithReceipt("flush-fail".toByteArray()).status)
            val drain = port.flushDrain(2_000)
            assertFalse(drain.ok)
            assertEquals(0, drain.committed)
        } finally {
            awaitClose(store)
            directory.deleteRecursively()
        }
    }

    @Test
    fun clearDoesNotReuseOldStoreSequenceForSamePayload() {
        val directory = Files.createTempDirectory("g2-clear-seq-").toFile()
        try {
            val store = SegmentedFactStore(maxQueuedRecords = 4)
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256,
                partitionQuotas = longArrayOf(1024),
                receiveObservationFacts = false,
            )
            assertTrue(awaitOpen(store, options))
            val port = FactStoreReceiptPort(store, directory)
            val first = port.appendWithReceipt("same".toByteArray())
            val committed = port.commitWait(first.mobileFactId!!, 2_000)
            assertEquals("committed", committed.status)
            val oldSequence = committed.globalSequence!!
            port.clear()
            val second = port.appendWithReceipt("same".toByteArray())
            val afterClear = port.commitWait(second.mobileFactId!!, 2_000)
            assertEquals("committed", afterClear.status)
            assertTrue(afterClear.globalSequence!! > oldSequence)
            val unknown = port.commitWait("mf1:1:99:deadbeef", 2_000)
            assertEquals("dropped", unknown.status)
            awaitClose(store)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun tornSidecarThenClearPersistsACompleteClearRow() {
        val directory = Files.createTempDirectory("g2-torn-clear-").toFile()
        try {
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256,
                partitionQuotas = longArrayOf(1024),
                receiveObservationFacts = false,
            )
            val firstStore = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(firstStore, options))
            val firstPort = FactStoreReceiptPort(firstStore, directory)
            val accepted = firstPort.appendWithReceipt("keep".toByteArray())
            assertEquals("committed", firstPort.commitWait(accepted.mobileFactId!!, 2_000).status)
            val oldGeneration = accepted.storeGeneration
            awaitClose(firstStore)
            File(directory, FactStoreReceiptPort.SIDECAR_NAME).appendText("{\"mobileFactId\":\"mf1")
            val reopened = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(reopened, options))
            val port = FactStoreReceiptPort(reopened, directory)
            val nextGeneration = port.clear()
            assertTrue(nextGeneration > oldGeneration)
            awaitClose(reopened)
            val secondReopen = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(secondReopen, options))
            val again = FactStoreReceiptPort(secondReopen, directory)
            val stale = again.readPage(FactCursor(oldGeneration), 8)
            assertTrue(stale.generationMismatch)
            awaitClose(secondReopen)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun pendingIsVisibleAfterCommittedCursor() {
        val directory = Files.createTempDirectory("g2-pending-cursor-").toFile()
        try {
            val store = SegmentedFactStore(maxQueuedRecords = 4)
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256,
                partitionQuotas = longArrayOf(1024),
                receiveObservationFacts = false,
            )
            assertTrue(awaitOpen(store, options))
            val port = FactStoreReceiptPort(store, directory)
            val first = port.appendWithReceipt("one".toByteArray())
            val committed = port.commitWait(first.mobileFactId!!, 2_000)
            val second = port.appendWithReceipt("two".toByteArray())
            assertEquals(null, second.globalSequence)
            val page = port.readPage(FactCursor(first.storeGeneration, committed.globalSequence!!), 8)
            assertEquals(1, page.items.size)
            assertEquals(second.mobileFactId, page.items.single().mobileFactId)
            assertFalse(page.items.single().committed)
            awaitClose(store)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun truncatedSidecarLineDoesNotFailReopen() {
        val directory = Files.createTempDirectory("g2-sidecar-tail-").toFile()
        try {
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256,
                partitionQuotas = longArrayOf(1024),
                receiveObservationFacts = false,
            )
            val firstStore = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(firstStore, options))
            val firstPort = FactStoreReceiptPort(firstStore, directory)
            val accepted = firstPort.appendWithReceipt("keep".toByteArray())
            assertEquals("committed", firstPort.commitWait(accepted.mobileFactId!!, 2_000).status)
            awaitClose(firstStore)
            File(directory, FactStoreReceiptPort.SIDECAR_NAME).appendText("{\"mobileFactId\":\"mf1")
            val reopened = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(reopened, options))
            val port = FactStoreReceiptPort(reopened, directory)
            val page = port.readPage(FactCursor(accepted.storeGeneration), 8)
            assertEquals(1, page.items.size)
            assertEquals(accepted.mobileFactId, page.items.single().mobileFactId)
            awaitClose(reopened)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun failedThenSuccessfulWriteBindsByPayloadHash() {
        val directory = Files.createTempDirectory("g2-mix-bind-").toFile()
        val native = FailFirstThenSucceedNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "g2-mix-bind").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
        )
        try {
            assertTrue(
                awaitOpen(
                    store,
                    SegmentedFactStoreOptions(
                        directory = directory,
                        segmentSizeBytes = 256,
                        partitionQuotas = longArrayOf(1024),
                        receiveObservationFacts = false,
                    ),
                ),
            )
            val port = FactStoreReceiptPort(store, directory)
            val lost = "lost-a".toByteArray()
            val kept = "kept-b".toByteArray()
            val first = port.appendWithReceipt(lost)
            val second = port.appendWithReceipt(kept)
            assertEquals("dropped", port.commitWait(first.mobileFactId!!, 2_000).status)
            val committed = port.commitWait(second.mobileFactId!!, 2_000)
            assertEquals("committed", committed.status)
            assertEquals("mf1:${committed.storeGeneration}:${committed.globalSequence}:${hashPrefix(kept)}", committed.mobileFactId)
            val page = port.readPage(FactCursor(second.storeGeneration), 8)
            assertEquals(1, page.items.size)
            assertArrayEquals(kept, page.items.single().payload)
            assertEquals(committed.mobileFactId, page.items.single().mobileFactId)
        } finally {
            awaitClose(store)
            directory.deleteRecursively()
        }
    }

    @Test
    fun failedThenSuccessfulIdenticalPayloadBindsTheSuccessfulAccept() {
        val directory = Files.createTempDirectory("g2-same-hash-").toFile()
        val native = FailFirstThenSucceedNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "g2-same-hash").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
        )
        try {
            assertTrue(
                awaitOpen(
                    store,
                    SegmentedFactStoreOptions(
                        directory = directory,
                        segmentSizeBytes = 256,
                        partitionQuotas = longArrayOf(1024),
                        receiveObservationFacts = false,
                    ),
                ),
            )
            val port = FactStoreReceiptPort(store, directory)
            val payload = "same-bytes".toByteArray()
            val first = port.appendWithReceipt(payload)
            val second = port.appendWithReceipt(payload)
            assertEquals("dropped", port.commitWait(first.mobileFactId!!, 2_000).status)
            val committed = port.commitWait(second.mobileFactId!!, 2_000)
            assertEquals("committed", committed.status)
            assertEquals("mf1:${committed.storeGeneration}:${committed.globalSequence}:${hashPrefix(payload)}", committed.mobileFactId)
            val page = port.readPage(FactCursor(second.storeGeneration), 8)
            assertEquals(1, page.items.size)
            assertArrayEquals(payload, page.items.single().payload)
            assertEquals(committed.mobileFactId, page.items.single().mobileFactId)
        } finally {
            awaitClose(store)
            directory.deleteRecursively()
        }
    }

    @Test
    fun tornLastSidecarLineDoesNotBindOldRecordToNewId() {
        val directory = Files.createTempDirectory("g2-torn-last-").toFile()
        try {
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256,
                partitionQuotas = longArrayOf(1024),
                receiveObservationFacts = false,
            )
            val firstStore = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(firstStore, options))
            val firstPort = FactStoreReceiptPort(firstStore, directory)
            val kept = "keep-a".toByteArray()
            val accepted = firstPort.appendWithReceipt(kept)
            val committed = firstPort.commitWait(accepted.mobileFactId!!, 2_000)
            assertEquals("committed", committed.status)
            awaitClose(firstStore)
            File(directory, FactStoreReceiptPort.SIDECAR_NAME).writeText("{\"mobileFactId\":\"mf1")
            val reopened = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(reopened, options))
            val port = FactStoreReceiptPort(reopened, directory)
            val next = "new-b".toByteArray()
            val second = port.appendWithReceipt(next)
            val secondCommitted = port.commitWait(second.mobileFactId!!, 2_000)
            assertEquals("committed", secondCommitted.status)
            val page = port.readPage(FactCursor(second.storeGeneration), 8)
            assertEquals(2, page.items.size)
            assertArrayEquals(kept, page.items[0].payload)
            assertArrayEquals(next, page.items[1].payload)
            assertEquals(hashPrefix(kept), page.items[0].mobileFactId.split(':')[3])
            assertEquals(hashPrefix(next), page.items[1].mobileFactId.split(':')[3])
            awaitClose(reopened)
            val secondReopen = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(secondReopen, options))
            val reopenedAgain = FactStoreReceiptPort(secondReopen, directory)
            val again = reopenedAgain.readPage(FactCursor(second.storeGeneration), 8)
            assertEquals(2, again.items.size)
            assertArrayEquals(kept, again.items[0].payload)
            assertArrayEquals(next, again.items[1].payload)
            assertEquals(hashPrefix(kept), again.items[0].mobileFactId.split(':')[3])
            assertEquals(hashPrefix(next), again.items[1].mobileFactId.split(':')[3])
            awaitClose(secondReopen)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun reopenHydratesSidecarPayloadsFromStore() {
        val directory = Files.createTempDirectory("g2-reopen-").toFile()
        try {
            val firstStore = SegmentedFactStore(maxQueuedRecords = 4)
            val options = SegmentedFactStoreOptions(
                directory = directory,
                segmentSizeBytes = 256,
                partitionQuotas = longArrayOf(1024),
                receiveObservationFacts = false,
            )
            assertTrue(awaitOpen(firstStore, options))
            val firstPort = FactStoreReceiptPort(firstStore, directory)
            val payload = "g2-reopen".toByteArray()
            val accepted = firstPort.appendWithReceipt(payload)
            val committed = firstPort.commitWait(accepted.mobileFactId!!, 2_000)
            assertEquals("committed", committed.status)
            val watermark = firstPort.throughWatermark()
            awaitClose(firstStore)

            val reopened = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOpen(reopened, options))
            val port = FactStoreReceiptPort(reopened, directory)
            val page = port.readPage(FactCursor(accepted.storeGeneration), 8)
            assertEquals(1, page.items.size)
            assertEquals(accepted.mobileFactId, page.items.single().mobileFactId)
            assertTrue(page.items.single().committed)
            assertArrayEquals(payload, page.items.single().payload)
            assertEquals(watermark.throughSequence, port.throughWatermark().throughSequence)
            awaitClose(reopened)
        } finally {
            directory.deleteRecursively()
        }
    }

    private fun awaitOpen(store: SegmentedFactStore, options: SegmentedFactStoreOptions): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        store.open(options) {
            ok = it.isSuccess
            latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return ok
    }

    private fun awaitClose(store: SegmentedFactStore) {
        val latch = CountDownLatch(1)
        store.close { latch.countDown() }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
    }

    private class BlockingFakeNative : SegmentedFactStoreNative {
        val release = CountDownLatch(1)

        override fun open(
            directory: String,
            segmentSizeBytes: Long,
            flags: Int,
            partitionQuotas: LongArray,
        ) = NativeOpenResult(ok(), handle = 1)

        override fun append(
            handle: Long,
            partitionId: Int,
            payload: ByteArray,
            durability: Int,
        ): NativeAppendResult {
            release.await(5, TimeUnit.SECONDS)
            return NativeAppendResult(ok(), sequence = 1)
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
            operation = ok(),
            state = SegmentedFactStoreState.OPEN,
            enabled = true,
            queuedRecords = 0,
            acceptedRecords = 0,
            writtenRecords = 0,
            droppedRecords = 0,
        )

        override fun flush(handle: Long) = ok()

        override fun close(handle: Long) = ok()

        private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }

    private class CountingFlushNative : SegmentedFactStoreNative {
        var flushCount = 0
        private var nextSequence = 1L

        override fun open(
            directory: String,
            segmentSizeBytes: Long,
            flags: Int,
            partitionQuotas: LongArray,
        ) = NativeOpenResult(ok(), handle = 1)

        override fun append(
            handle: Long,
            partitionId: Int,
            payload: ByteArray,
            durability: Int,
        ) = NativeAppendResult(ok(), sequence = nextSequence++)

        override fun scan(
            handle: Long,
            cursor: SegmentedFactStoreCursor,
            bufferCapacity: Int,
        ) = SegmentedFactStoreReadResult(
            operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.END),
            cursor = cursor,
        )

        override fun status(handle: Long) = SegmentedFactStoreStatus(
            operation = ok(),
            state = SegmentedFactStoreState.OPEN,
            enabled = true,
            queuedRecords = 0,
            acceptedRecords = 0,
            writtenRecords = 0,
            droppedRecords = 0,
        )

        override fun flush(handle: Long): SegmentedFactStoreOperationResult {
            flushCount += 1
            return ok()
        }

        override fun close(handle: Long) = ok()

        private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }

    private class FailFirstThenSucceedNative : SegmentedFactStoreNative {
        private val written = ArrayList<Pair<Long, ByteArray>>()
        private var attempts = 0
        private var nextSequence = 1L

        override fun open(
            directory: String,
            segmentSizeBytes: Long,
            flags: Int,
            partitionQuotas: LongArray,
        ) = NativeOpenResult(ok(), handle = 1)

        override fun append(
            handle: Long,
            partitionId: Int,
            payload: ByteArray,
            durability: Int,
        ): NativeAppendResult {
            attempts += 1
            if (attempts == 1) {
                return NativeAppendResult(
                    SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.IO, message = "write-failed"),
                    sequence = 0,
                )
            }
            val sequence = nextSequence++
            written.add(sequence to payload.copyOf())
            return NativeAppendResult(ok(), sequence = sequence)
        }

        override fun scan(
            handle: Long,
            cursor: SegmentedFactStoreCursor,
            bufferCapacity: Int,
        ): SegmentedFactStoreReadResult {
            val next = written.firstOrNull { it.first > cursor.afterSequence }
                ?: return SegmentedFactStoreReadResult(
                    operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.END),
                    cursor = cursor,
                )
            return SegmentedFactStoreReadResult(
                operation = ok(),
                cursor = cursor.copy(afterSequence = next.first),
                record = SegmentedFactStoreRecord(
                    payload = next.second,
                    payloadLength = next.second.size,
                    partitionId = 0,
                    flags = 0,
                    sequence = next.first,
                    segmentId = 1,
                    frameOffset = 0,
                    gapFirstSequence = 0,
                    gapLastSequence = 0,
                ),
            )
        }

        override fun status(handle: Long) = SegmentedFactStoreStatus(
            operation = ok(),
            state = SegmentedFactStoreState.OPEN,
            enabled = true,
            queuedRecords = 0,
            acceptedRecords = attempts.toLong(),
            writtenRecords = written.size.toLong(),
            droppedRecords = if (attempts > 0) 1 else 0,
        )

        override fun flush(handle: Long) = ok()

        override fun close(handle: Long) = ok()

        private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }

    private class FailingAppendNative : SegmentedFactStoreNative {
        override fun open(
            directory: String,
            segmentSizeBytes: Long,
            flags: Int,
            partitionQuotas: LongArray,
        ) = NativeOpenResult(ok(), handle = 1)

        override fun append(
            handle: Long,
            partitionId: Int,
            payload: ByteArray,
            durability: Int,
        ) = NativeAppendResult(
            SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.IO, message = "write-failed"),
            sequence = 0,
        )

        override fun scan(
            handle: Long,
            cursor: SegmentedFactStoreCursor,
            bufferCapacity: Int,
        ) = SegmentedFactStoreReadResult(
            operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.END),
            cursor = cursor,
        )

        override fun status(handle: Long) = SegmentedFactStoreStatus(
            operation = ok(),
            state = SegmentedFactStoreState.OPEN,
            enabled = true,
            queuedRecords = 0,
            acceptedRecords = 0,
            writtenRecords = 0,
            droppedRecords = 1,
        )

        override fun flush(handle: Long) = ok()

        override fun close(handle: Long) = ok()

        private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }

    private class FailingFlushNative : SegmentedFactStoreNative {
        private var nextSequence = 1L

        override fun open(
            directory: String,
            segmentSizeBytes: Long,
            flags: Int,
            partitionQuotas: LongArray,
        ) = NativeOpenResult(ok(), handle = 1)

        override fun append(
            handle: Long,
            partitionId: Int,
            payload: ByteArray,
            durability: Int,
        ) = NativeAppendResult(ok(), sequence = nextSequence++)

        override fun scan(
            handle: Long,
            cursor: SegmentedFactStoreCursor,
            bufferCapacity: Int,
        ) = SegmentedFactStoreReadResult(
            operation = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.END),
            cursor = cursor,
        )

        override fun status(handle: Long) = SegmentedFactStoreStatus(
            operation = ok(),
            state = SegmentedFactStoreState.OPEN,
            enabled = true,
            queuedRecords = 0,
            acceptedRecords = 0,
            writtenRecords = 0,
            droppedRecords = 0,
        )

        override fun flush(handle: Long) = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.IO)

        override fun close(handle: Long) = ok()

        private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }
}
