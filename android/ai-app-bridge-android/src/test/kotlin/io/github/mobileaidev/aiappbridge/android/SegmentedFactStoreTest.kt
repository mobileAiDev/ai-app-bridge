package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SegmentedFactStoreTest {
    @Test
    fun recordOnlyEnqueuesAndNativeAppendRunsOnWriter() {
        val native = FakeNative()
        val store = store(native)
        awaitOperation { store.open(options(), it) }
        val callingThread = Thread.currentThread().name

        assertEquals(
            SegmentedFactRecordEnqueueResult.ACCEPTED,
            store.record("fact".toByteArray()),
        )
        val status = awaitStatus(store)

        assertEquals(1, native.appendedPayloads.size)
        assertEquals("fact", native.appendedPayloads.single().toString(Charsets.UTF_8))
        assertNotEquals(callingThread, native.appendThread)
        assertEquals(1, status.acceptedRecords)
        assertEquals(1, status.writtenRecords)
        awaitOperation { store.close(it) }
    }

    @Test
    fun statusReportsRecoveryAndStoreCanCloseThenReopen() {
        val native = FakeNative(recoveredTail = true)
        val store = store(native)

        assertTrue(awaitOperation { store.open(options(), it) }.isSuccess)
        val recovered = awaitStatus(store)
        assertTrue(recovered.recoveredTail)
        assertEquals(12, recovered.recoveryDiscardedBytes)
        assertTrue(awaitOperation { store.close(it) }.isSuccess)
        assertTrue(awaitOperation { store.open(options(), it) }.isSuccess)
        assertEquals(2, native.openCount)
        awaitOperation { store.close(it) }
    }

    @Test
    fun groupFlushBoundsDurabilityWindowByRecordCount() {
        val native = FakeNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "fact-store-group-flush-test").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
            flushIntervalMs = 60_000,
            maxUnflushedRecords = 2,
        )
        assertTrue(awaitOperation { store.open(options(), it) }.isSuccess)

        assertEquals(SegmentedFactRecordEnqueueResult.ACCEPTED, store.record("one".toByteArray()))
        assertEquals(SegmentedFactRecordEnqueueResult.ACCEPTED, store.record("two".toByteArray()))
        awaitStatus(store)

        assertEquals(1, native.flushCount)
        assertTrue(awaitOperation { store.close(it) }.isSuccess)
        assertEquals(1, native.flushCount)
    }

    @Test
    fun groupFlushBoundsDurabilityWindowByElapsedTime() {
        val native = FakeNative()
        val store = SegmentedFactStore(
            nativeFactory = { native },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "fact-store-timed-flush-test").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
            flushIntervalMs = 20,
            maxUnflushedRecords = 100,
        )
        assertTrue(awaitOperation { store.open(options(), it) }.isSuccess)

        assertEquals(SegmentedFactRecordEnqueueResult.ACCEPTED, store.record("one".toByteArray()))

        assertTrue(native.flushLatch.await(1, TimeUnit.SECONDS))
        assertEquals(1, native.flushCount)
        awaitOperation { store.close(it) }
    }

    @Test
    fun oversizedPayloadIsRejectedBeforeQueueAndDoesNotBlockFollowingFact() {
        val native = FakeNative()
        val store = store(native)
        assertTrue(awaitOperation { store.open(options(), it) }.isSuccess)

        assertEquals(
            SegmentedFactRecordEnqueueResult.PAYLOAD_TOO_LARGE,
            store.record(ByteArray(SegmentedFactStore.MAX_PERSISTED_PAYLOAD_BYTES + 1)),
        )
        assertEquals(SegmentedFactRecordEnqueueResult.ACCEPTED, store.record("following".toByteArray()))
        val status = awaitStatus(store)

        assertEquals(listOf("following"), native.appendedPayloads.map { it.toString(Charsets.UTF_8) })
        assertEquals(1, status.acceptedRecords)
        assertEquals(1, status.writtenRecords)
        assertEquals(1, status.droppedRecords)
        awaitOperation { store.close(it) }
    }

    @Test
    fun sixHundredKibUiTreeIsOneLogicalMappedFactAcrossReopenAndChunksNeverPage() {
        val directory = Files.createTempDirectory("android-large-fact-").toFile()
        val segmentSize = 512L * 1024L
        val options = SegmentedFactStoreOptions(
            directory = directory,
            segmentSizeBytes = segmentSize,
            partitionQuotas = longArrayOf(0, 4 * segmentSize),
            receiveObservationFacts = false,
        )
        val payload = largeUiTreeFact(600 * 1024)
        try {
            val first = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOperation { first.open(options, it) }.isSuccess)
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                first.record(payload, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            val written = awaitStatus(first)
            assertEquals(1L, written.acceptedRecords)
            assertEquals(1L, written.writtenRecords)
            assertEquals(0L, written.droppedRecords)

            val tooSmall = awaitRead(first, SegmentedFactStoreCursor(), 64 * 1024)
            assertEquals(SegmentedFactStoreResultCode.BUFFER_TOO_SMALL, tooSmall.operation.code)
            assertEquals(payload.size, tooSmall.requiredCapacity)
            assertEquals(null, tooSmall.record)

            val immediate = awaitRead(first, SegmentedFactStoreCursor(), payload.size)
            assertArrayEquals(payload, immediate.record?.payload)
            assertEquals(payload.size, immediate.record?.payloadLength)
            assertEquals(1, immediate.record?.partitionId)
            assertEquals(immediate.record?.sequence, immediate.cursor.afterSequence)
            assertTrue(awaitRead(first, immediate.cursor, payload.size).isEnd)
            assertTrue(awaitOperation { first.close(it) }.isSuccess)

            val reopened = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOperation { reopened.open(options, it) }.isSuccess)
            val afterReopen = awaitRead(reopened, SegmentedFactStoreCursor(), payload.size)
            assertArrayEquals(payload, afterReopen.record?.payload)
            assertTrue(awaitRead(reopened, afterReopen.cursor, payload.size).isEnd)
            assertTrue(awaitOperation { reopened.close(it) }.isSuccess)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun evictedLargeFactChunkReturnsCorruptAndNeverReturnsPartialPayload() {
        val directory = Files.createTempDirectory("android-large-fact-missing-chunk-").toFile()
        val segmentSize = 512L * 1024L
        val options = SegmentedFactStoreOptions(
            directory = directory,
            segmentSizeBytes = segmentSize,
            partitionQuotas = longArrayOf(0, 2 * segmentSize),
            receiveObservationFacts = false,
        )
        val payload = largeUiTreeFact(600 * 1024)
        val store = SegmentedFactStore(maxQueuedRecords = 4)
        try {
            assertTrue(awaitOperation { store.open(options, it) }.isSuccess)
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                store.record(payload, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            awaitStatus(store)
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                store.record(ByteArray(450 * 1024) { 7 }, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            awaitStatus(store)

            val read = awaitRead(store, SegmentedFactStoreCursor(), payload.size)
            assertEquals(SegmentedFactStoreResultCode.CORRUPT, read.operation.code)
            assertEquals(null, read.record)
            assertEquals(SegmentedFactStoreCursor(), read.cursor)
        } finally {
            awaitOperation { store.close(it) }
            directory.deleteRecursively()
        }
    }

    @Test
    fun impossibleLargeFactIsRejectedBeforeAcceptedInsteadOfAsyncDrop() {
        val directory = Files.createTempDirectory("android-large-fact-preflight-").toFile()
        val segmentSize = 512L * 1024L
        val store = SegmentedFactStore(maxQueuedRecords = 4)
        try {
            assertTrue(
                awaitOperation {
                    store.open(
                        SegmentedFactStoreOptions(
                            directory = directory,
                            segmentSizeBytes = segmentSize,
                            partitionQuotas = longArrayOf(0, segmentSize),
                            receiveObservationFacts = false,
                        ),
                        it,
                    )
                }.isSuccess,
            )

            assertEquals(
                SegmentedFactRecordEnqueueResult.PAYLOAD_TOO_LARGE,
                store.record(largeUiTreeFact(600 * 1024), partitionId = 1),
            )
            val status = awaitStatus(store)
            assertEquals(0L, status.acceptedRecords)
            assertEquals(0L, status.writtenRecords)
            assertEquals(1L, status.droppedRecords)
        } finally {
            awaitOperation { store.close(it) }
            directory.deleteRecursively()
        }
    }

    @Test
    fun reopenWildcardsUsePersistedGeometryForLargeFactPreflight() {
        val directory = Files.createTempDirectory("android-large-fact-reopen-geometry-").toFile()
        val segmentSize = 512L * 1024L
        val persistedOptions = SegmentedFactStoreOptions(
            directory = directory,
            segmentSizeBytes = segmentSize,
            partitionQuotas = longArrayOf(0, 4 * segmentSize),
            receiveObservationFacts = false,
        )
        val payload = largeUiTreeFact(600 * 1024)
        try {
            val creator = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(awaitOperation { creator.open(persistedOptions, it) }.isSuccess)
            assertTrue(awaitOperation { creator.close(it) }.isSuccess)

            val reopened = SegmentedFactStore(maxQueuedRecords = 4)
            assertTrue(
                awaitOperation {
                    reopened.open(
                        persistedOptions.copy(
                            segmentSizeBytes = 0,
                            partitionQuotas = longArrayOf(0, 0),
                        ),
                        it,
                    )
                }.isSuccess,
            )
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                reopened.record(payload, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            val written = awaitStatus(reopened)
            assertEquals(1L, written.writtenRecords)
            assertEquals(0L, written.droppedRecords)
            assertArrayEquals(payload, awaitRead(reopened, SegmentedFactStoreCursor(), payload.size).record?.payload)
            assertTrue(awaitOperation { reopened.close(it) }.isSuccess)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun nonAlignedSegmentAndNonMultipleQuotaUseNativeFrameGeometry() {
        val directory = Files.createTempDirectory("android-large-fact-frame-geometry-").toFile()
        val segmentSize = 512L * 1024L + 1
        val payload = largeUiTreeFact(600 * 1024)
        val store = SegmentedFactStore(maxQueuedRecords = 4)
        try {
            assertTrue(
                awaitOperation {
                    store.open(
                        SegmentedFactStoreOptions(
                            directory = directory,
                            segmentSizeBytes = segmentSize,
                            partitionQuotas = longArrayOf(0, 2 * segmentSize + segmentSize / 2),
                            receiveObservationFacts = false,
                        ),
                        it,
                    )
                }.isSuccess,
            )
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                store.record(payload, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            val written = awaitStatus(store)
            assertEquals(1L, written.writtenRecords)
            assertEquals(0L, written.droppedRecords)
            assertArrayEquals(payload, awaitRead(store, SegmentedFactStoreCursor(), payload.size).record?.payload)
        } finally {
            awaitOperation { store.close(it) }
            directory.deleteRecursively()
        }
    }

    @Test
    fun evictionGapBeforeHiddenChunkIsCarriedToTheLogicalManifestRecord() {
        val directory = Files.createTempDirectory("android-large-fact-gap-").toFile()
        val segmentSize = 512L * 1024L
        val store = SegmentedFactStore(maxQueuedRecords = 4)
        val payload = largeUiTreeFact(600 * 1024)
        try {
            assertTrue(
                awaitOperation {
                    store.open(
                        SegmentedFactStoreOptions(
                            directory = directory,
                            segmentSizeBytes = segmentSize,
                            partitionQuotas = longArrayOf(0, 3 * segmentSize),
                            receiveObservationFacts = false,
                        ),
                        it,
                    )
                }.isSuccess,
            )
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                store.record(ByteArray(450 * 1024) { 1 }, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            awaitStatus(store)
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                store.record(payload, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            awaitStatus(store)
            assertEquals(
                SegmentedFactRecordEnqueueResult.ACCEPTED,
                store.record(ByteArray(450 * 1024) { 2 }, partitionId = 1, durability = SegmentedFactStoreDurability.SYNC),
            )
            awaitStatus(store)

            val read = awaitRead(store, SegmentedFactStoreCursor(), payload.size)
            assertArrayEquals(payload, read.record?.payload)
            assertTrue(requireNotNull(read.record).flags and 1 != 0)
            assertEquals(1L, read.record?.gapFirstSequence)
            assertEquals(1L, read.record?.gapLastSequence)
        } finally {
            awaitOperation { store.close(it) }
            directory.deleteRecursively()
        }
    }

    @Test
    fun largeFactWireReadsSharedGoldenAndWritesExactBinaryHeaderWithoutBase64() {
        val fixture = JSONObject(largeFactGolden().readText()).getJSONObject("fixture")
        val payload = fixture.getString("payloadUtf8").toByteArray(Charsets.UTF_8)
        val expectedDigest = fixture.getString("sha256Hex")

        val digest = LargeFactWire.sha256(payload)
        val encoded = LargeFactWire.encodeChunk(
            digest = digest,
            ordinal = 0,
            chunkCount = 1,
            totalLength = payload.size,
            bytes = payload,
        )
        val decoded = LargeFactWire.decodeChunk(encoded)

        assertEquals(expectedDigest, LargeFactWire.hex(digest))
        assertEquals(fixture.getString("chunkHeaderHex"), LargeFactWire.hex(encoded.copyOfRange(0, 72)))
        assertEquals(0, decoded.ordinal)
        assertEquals(1, decoded.chunkCount)
        assertEquals(payload.size, decoded.totalLength)
        assertArrayEquals(payload, decoded.bytes)
        val corrupt = encoded.copyOf().also { it[68] = 1 }
        assertThrows(IllegalArgumentException::class.java) { LargeFactWire.decodeChunk(corrupt) }

        val manifest = LargeFactWire.encodeManifest(
            index = LargeFactWire.extractIndex(payload),
            digest = digest,
            byteLength = payload.size,
            chunks = listOf(
                LargeFactWire.ChunkLocation(
                    ordinal = 0,
                    sequence = 41,
                    segmentId = 7,
                    frameOffset = 64,
                    payloadLength = encoded.size,
                    byteLength = payload.size,
                ),
            ),
        )
        val encodedManifest = JSONObject(manifest.toString(Charsets.UTF_8))
        val expectedManifest = fixture.getJSONObject("manifest")
        assertEquals(
            expectedManifest.getString("__aiAppBridgeInternal"),
            encodedManifest.getString("__aiAppBridgeInternal"),
        )
        assertEquals(
            expectedManifest.getJSONObject("content").getInt("byteLength"),
            encodedManifest.getJSONObject("content").getInt("byteLength"),
        )
        assertEquals(
            expectedManifest.getJSONObject("content").getString("sha256"),
            encodedManifest.getJSONObject("content").getString("sha256"),
        )
        val parsedManifest = requireNotNull(
            LargeFactWire.decodeManifest(
                fixture.getJSONObject("manifest").toString().toByteArray(Charsets.UTF_8),
                manifestSequence = 42,
            ),
        )
        assertEquals(payload.size, parsedManifest.byteLength)
        assertEquals(41L, parsedManifest.chunks.single().sequence)
        assertEquals(expectedDigest, LargeFactWire.hex(parsedManifest.digest))
    }

    @Test
    fun disabledStoreDoesNotLoadNativeOrAcceptFacts() {
        val native = FakeNative()
        var factoryCalls = 0
        val store = SegmentedFactStore(
            nativeFactory = {
                factoryCalls += 1
                native
            },
            writer = Executors.newSingleThreadExecutor { task ->
                Thread(task, "fact-store-test").apply { isDaemon = true }
            },
            maxQueuedRecords = 4,
        )

        assertTrue(awaitOperation { store.open(options(enabled = false), it) }.isSuccess)
        assertEquals(SegmentedFactRecordEnqueueResult.DISABLED, store.record(byteArrayOf(1)))
        val status = awaitStatus(store)
        assertEquals(SegmentedFactStoreState.DISABLED, status.state)
        assertFalse(status.enabled)
        assertEquals(0, factoryCalls)
        assertEquals(0, native.openCount)
    }

    @Test
    fun managedProfileCleansOnlyInactiveAllowlistedDirectoriesOnWriter() {
        val base = Files.createTempDirectory("android-profile-cleanup-").toFile()
        val otherAppBase = Files.createTempDirectory("android-other-app-profile-").toFile()
        try {
            val activePayload = File(base, "64mb/partition-0/active.sfs").also {
                requireNotNull(it.parentFile).mkdirs()
                it.writeText("active")
            }
            val inactivePayloads = listOf("1gb", "512mb", "256mb", "off-low-disk").map { profile ->
                File(base, "$profile/partition-0/stale.sfs").also {
                    requireNotNull(it.parentFile).mkdirs()
                    it.writeText("stale-$profile")
                }
            }
            val unrelated = File(base, "unrelated/must-stay.bin").also {
                requireNotNull(it.parentFile).mkdirs()
                it.writeText("unrelated")
            }
            val otherApp = File(otherAppBase, "512mb/must-stay.bin").also {
                requireNotNull(it.parentFile).mkdirs()
                it.writeText("other-app")
            }
            val native = FakeNative()
            val store = store(native)
            val configuration = MobileFactStoreProfiles.configuration(
                baseDirectory = base,
                totalBytes = 3L * GIB,
                availableBytes = 1L * GIB,
            )
            val callingThread = Thread.currentThread().name

            assertTrue(awaitOperation { store.openMobileProfile(configuration, it) }.isSuccess)
            val status = awaitStatus(store)

            assertNotEquals(callingThread, native.openThread)
            assertTrue(activePayload.isFile)
            inactivePayloads.forEach { assertFalse(it.exists()) }
            listOf("1gb", "512mb", "256mb", "off-low-disk").forEach { profile ->
                assertTrue(File(base, "$profile/.sfs-lock").isFile)
            }
            assertTrue(unrelated.isFile)
            assertTrue(otherApp.isFile)
            assertFalse(status.cleanupPending)
            assertEquals(0L, status.inactiveBytes)
            assertNull(status.cleanupError)
            awaitOperation { store.close(it) }
        } finally {
            base.deleteRecursively()
            otherAppBase.deleteRecursively()
        }
    }

    @Test
    fun lowDiskProfileCleansDataProfilesAsynchronouslyWithoutLoadingNative() {
        val base = Files.createTempDirectory("android-low-disk-cleanup-").toFile()
        val stale = File(base, "1gb/partition-0/stale.sfs").also {
            requireNotNull(it.parentFile).mkdirs()
            it.writeText("stale")
        }
        val writer = Executors.newSingleThreadExecutor { task ->
            Thread(task, "fact-store-low-disk-cleanup-test").apply { isDaemon = true }
        }
        val workerStarted = CountDownLatch(1)
        val releaseWorker = CountDownLatch(1)
        writer.execute {
            workerStarted.countDown()
            releaseWorker.await(5, TimeUnit.SECONDS)
        }
        assertTrue(workerStarted.await(1, TimeUnit.SECONDS))
        var factoryCalls = 0
        val store = SegmentedFactStore(
            nativeFactory = {
                factoryCalls += 1
                FakeNative()
            },
            writer = writer,
            maxQueuedRecords = 4,
        )
        val configuration = MobileFactStoreProfiles.configuration(
            baseDirectory = base,
            totalBytes = 3L * GIB,
            availableBytes = 300L * MIB,
        )
        try {
            assertTrue(awaitOperation { store.openMobileProfile(configuration, it) }.isSuccess)
            // The fact writer is deliberately blocked: cleanup must not have run on this caller.
            assertTrue(stale.isFile)
            assertEquals(0, factoryCalls)

            releaseWorker.countDown()
            val status = awaitStatus(store)
            assertFalse(stale.exists())
            assertEquals(SegmentedFactStoreState.DISABLED, status.state)
            assertFalse(status.cleanupPending)
            assertEquals(0L, status.inactiveBytes)
            assertNull(status.cleanupError)
            assertEquals(0, factoryCalls)
        } finally {
            releaseWorker.countDown()
            base.deleteRecursively()
        }
    }

    @Test
    fun busyInactiveProfileIsReportedAndNeverBlocksSuccessfulOpen() {
        val base = Files.createTempDirectory("android-busy-profile-").toFile()
        val busyPayload = File(base, "512mb/partition-0/stale.sfs").also {
            requireNotNull(it.parentFile).mkdirs()
            it.writeBytes(ByteArray(4096) { 7 })
        }
        val lockFile = RandomAccessFile(File(base, "512mb/.sfs-lock"), "rw")
        val heldLock = lockFile.channel.lock()
        val native = FakeNative()
        val store = store(native)
        val configuration = MobileFactStoreProfiles.configuration(
            baseDirectory = base,
            totalBytes = 3L * GIB,
            availableBytes = 1L * GIB,
        )
        try {
            assertTrue(awaitOperation { store.openMobileProfile(configuration, it) }.isSuccess)
            val status = awaitStatus(store)

            assertEquals(SegmentedFactStoreState.OPEN, status.state)
            assertTrue(busyPayload.isFile)
            assertTrue(status.cleanupPending)
            assertTrue(status.inactiveBytes >= busyPayload.length())
            assertTrue(status.cleanupError.orEmpty().contains("512mb:busy"))
            assertEquals(1, native.openCount)

            heldLock.release()
            lockFile.close()
            val recovered = awaitStatus(store)
            assertFalse(busyPayload.exists())
            assertFalse(recovered.cleanupPending)
            assertEquals(0L, recovered.inactiveBytes)
            assertNull(recovered.cleanupError)
            awaitOperation { store.close(it) }
        } finally {
            if (heldLock.isValid) heldLock.release()
            if (lockFile.channel.isOpen) lockFile.close()
            base.deleteRecursively()
        }
    }

    private fun store(native: FakeNative) = SegmentedFactStore(
        nativeFactory = { native },
        writer = Executors.newSingleThreadExecutor { task ->
            Thread(task, "fact-store-test").apply { isDaemon = true }
        },
        maxQueuedRecords = 4,
    )

    private fun options(enabled: Boolean = true) = SegmentedFactStoreOptions(
        directory = File("build/test-fact-store"),
        segmentSizeBytes = 256,
        partitionQuotas = longArrayOf(1024),
        enabled = enabled,
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
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return value
    }

    private fun awaitStatus(store: SegmentedFactStore): SegmentedFactStoreStatus {
        val latch = CountDownLatch(1)
        lateinit var value: SegmentedFactStoreStatus
        store.status {
            value = it
            latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return value
    }

    private fun awaitRead(
        store: SegmentedFactStore,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int,
    ): SegmentedFactStoreReadResult {
        val latch = CountDownLatch(1)
        lateinit var value: SegmentedFactStoreReadResult
        store.read(cursor, bufferCapacity) {
            value = it
            latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return value
    }

    private fun largeUiTreeFact(treeBytes: Int): ByteArray = JSONObject()
        .put("partition", "ui")
        .put("targetKey", "android:golden:com.example")
        .put("app", JSONObject().put("platform", "android").put("packageName", "com.example"))
        .put("runtimeEpoch", "runtime-large-tree")
        .put("actionId", JSONObject.NULL)
        .put("dedupeKey", JSONObject.NULL)
        .put(
            "timestamps",
            JSONObject()
                .put("occurredAtMs", 1)
                .put("observedAtMs", 2)
                .put("ingestedAtMs", 3),
        )
        .put(
            "payload",
            JSONObject()
                .put("kind", "evidence")
                .put("stream", "uia-tree")
                .put("record", JSONObject().put("value", "x".repeat(treeBytes))),
        )
        .toString()
        .toByteArray(Charsets.UTF_8)

    private fun largeFactGolden(): File {
        val working = File(requireNotNull(System.getProperty("user.dir")))
        return listOf(
            File(working, "native/segmented-fact-store/tests/golden/large-fact-v1.json"),
            File(working, "../../native/segmented-fact-store/tests/golden/large-fact-v1.json"),
        ).firstOrNull(File::isFile) ?: error("shared large-fact golden is missing")
    }

    private class FakeNative(
        private val recoveredTail: Boolean = false,
    ) : SegmentedFactStoreNative {
        var openCount = 0
        var openThread = ""
        var appendThread = ""
        val appendedPayloads = mutableListOf<ByteArray>()
        var flushCount = 0
        val flushLatch = CountDownLatch(1)

        override fun open(
            directory: String,
            segmentSizeBytes: Long,
            flags: Int,
            partitionQuotas: LongArray,
        ): NativeOpenResult {
            openCount += 1
            openThread = Thread.currentThread().name
            return NativeOpenResult(ok(), handle = openCount.toLong())
        }

        override fun append(
            handle: Long,
            partitionId: Int,
            payload: ByteArray,
            durability: Int,
        ): NativeAppendResult {
            appendThread = Thread.currentThread().name
            appendedPayloads += payload.copyOf()
            return NativeAppendResult(ok(), sequence = appendedPayloads.size.toLong())
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
            formatVersion = 1,
            recoveredTail = recoveredTail,
            recoveryDiscardedBytes = if (recoveredTail) 12 else 0,
        )

        override fun flush(handle: Long): SegmentedFactStoreOperationResult {
            flushCount += 1
            flushLatch.countDown()
            return ok()
        }

        override fun close(handle: Long) = ok()

        private fun ok() = SegmentedFactStoreOperationResult(SegmentedFactStoreResultCode.OK)
    }

    private companion object {
        const val MIB = 1024L * 1024L
        const val GIB = 1024L * MIB
    }
}
