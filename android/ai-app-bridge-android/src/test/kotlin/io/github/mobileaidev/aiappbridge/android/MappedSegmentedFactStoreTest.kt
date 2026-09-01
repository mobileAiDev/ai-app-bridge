package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

class MappedSegmentedFactStoreTest {
    @Test
    fun crc32cMatchesPortableGoldenVector() {
        assertEquals(0xE3069283.toInt(), Crc32c.compute("123456789".toByteArray()))
    }

    @Test
    fun appendCloseReopenAndReadPreservePortableFrames() {
        withStoreDirectory { directory ->
            val first = MappedSegmentedFactStore()
            assertTrue(first.open(directory.path, 256, 1, longArrayOf(1024)).operation.isSuccess)
            assertTrue(first.append(1, 0, byteArrayOf(0x61, 0, 0x62), 0).operation.isSuccess)
            assertTrue(first.append(1, 0, byteArrayOf(0x10, 0x20, 0x30, 0x40), 1).operation.isSuccess)
            assertTrue(first.close(1).isSuccess)

            val reopened = MappedSegmentedFactStore()
            assertTrue(reopened.open(directory.path, 256, 1, longArrayOf(1024)).operation.isSuccess)
            val firstRead = reopened.scan(1, SegmentedFactStoreCursor(), 16)
            assertArrayEquals(byteArrayOf(0x61, 0, 0x62), firstRead.record?.payload)
            val secondRead = reopened.scan(1, firstRead.cursor, 16)
            assertArrayEquals(byteArrayOf(0x10, 0x20, 0x30, 0x40), secondRead.record?.payload)
            assertTrue(reopened.scan(1, secondRead.cursor, 16).isEnd)
            assertTrue(reopened.close(1).isSuccess)
        }
    }

    @Test
    fun secondWriterIsRejectedAndTornActiveTailIsRecovered() {
        withStoreDirectory { directory ->
            val first = MappedSegmentedFactStore()
            assertTrue(first.open(directory.path, 256, 1, longArrayOf(1024)).operation.isSuccess)
            val second = MappedSegmentedFactStore()
            assertEquals(
                SegmentedFactStoreResultCode.BUSY,
                second.open(directory.path, 256, 1, longArrayOf(1024)).operation.code,
            )
            assertTrue(first.append(1, 0, "kept".toByteArray(), 1).operation.isSuccess)
            val activeOffset = first.status(1).activeWriteOffset
            assertTrue(first.close(1).isSuccess)

            val segment = File(directory, "partition-0/segment-00000000000000000001.sfs")
            RandomAccessFile(segment, "rw").use { file ->
                file.seek(activeOffset)
                file.writeInt(0x28000000)
            }

            val recovered = MappedSegmentedFactStore()
            assertTrue(recovered.open(directory.path, 256, 1, longArrayOf(1024)).operation.isSuccess)
            val status = recovered.status(1)
            assertTrue(status.recoveredTail)
            assertEquals(activeOffset, status.recoveryOffset)
            assertTrue(status.recoveryDiscardedBytes > 0)
            assertArrayEquals(
                "kept".toByteArray(),
                recovered.scan(1, SegmentedFactStoreCursor(), 16).record?.payload,
            )
            recovered.close(1)
        }
    }

    @Test
    fun interruptedCreatingSegmentIsRemovedOnReopen() {
        withStoreDirectory { directory ->
            val first = MappedSegmentedFactStore()
            assertTrue(first.open(directory.path, 256, 1, longArrayOf(1024)).operation.isSuccess)
            assertTrue(first.close(1).isSuccess)

            val temporary = File(directory, "partition-0/.segment-00000000000000000002.creating")
            temporary.writeBytes(byteArrayOf(0x53, 0x46, 0x53))
            assertTrue(temporary.isFile)

            val reopened = MappedSegmentedFactStore()
            assertTrue(reopened.open(directory.path, 256, 1, longArrayOf(1024)).operation.isSuccess)
            assertTrue(!temporary.exists())
            assertTrue(reopened.close(1).isSuccess)
        }
    }

    @Test
    fun segmentPublicationAndEvictionRequestBestEffortDirectorySync() {
        withStoreDirectory { directory ->
            val synchronizedDirectories = mutableListOf<File>()
            val store = MappedSegmentedFactStore { synchronizedDirectories += it.canonicalFile }
            assertTrue(store.open(directory.path, 256, 1, longArrayOf(512)).operation.isSuccess)

            repeat(3) { index ->
                assertTrue(
                    store.append(
                        1,
                        0,
                        ByteArray(80) { index.toByte() },
                        SegmentedFactStoreDurability.SYNC.nativeValue,
                    ).operation.isSuccess,
                )
            }

            val partition = File(directory, "partition-0").canonicalFile
            assertEquals(listOf(partition, partition, partition, partition), synchronizedDirectories)
            assertTrue(store.close(1).isSuccess)

            val bestEffort = MappedSegmentedFactStore { throw IllegalStateException("unsupported") }
            val bestEffortDirectory = File(directory, "best-effort")
            assertTrue(bestEffort.open(bestEffortDirectory.path, 256, 1, longArrayOf(512)).operation.isSuccess)
            assertTrue(bestEffort.close(1).isSuccess)
        }
    }

    @Test
    fun committedMarkerMakesCorruptFrameLengthFatalInsteadOfTornRecovery() {
        withStoreDirectory { directory ->
            val first = MappedSegmentedFactStore()
            assertTrue(first.open(directory.path, 256, 1, longArrayOf(1024)).operation.isSuccess)
            assertTrue(first.append(1, 0, "committed".toByteArray(), 1).operation.isSuccess)
            assertTrue(first.close(1).isSuccess)

            val segment = File(directory, "partition-0/segment-00000000000000000001.sfs")
            RandomAccessFile(segment, "rw").use { file ->
                file.seek(64)
                file.write(byteArrayOf(56, 0, 0, 0))
            }

            val reopened = MappedSegmentedFactStore()
            assertEquals(
                SegmentedFactStoreResultCode.CORRUPT,
                reopened.open(directory.path, 256, 1, longArrayOf(1024)).operation.code,
            )
        }
    }

    @Test
    fun writerOutputMatchesSharedC11GoldenCorpusByteForByte() {
        val golden = goldenDirectory()
        withStoreDirectory { directory ->
            val store = MappedSegmentedFactStore()
            assertTrue(store.open(directory.path, 512, 1, longArrayOf(1024, 1024)).operation.isSuccess)
            assertTrue(store.append(1, 0, byteArrayOf(0x00, 0x01, 0x7f, 0x80.toByte(), 0xff.toByte()), 1).operation.isSuccess)
            assertTrue(store.append(1, 1, "hello".toByteArray(), 0).operation.isSuccess)
            assertTrue(store.append(1, 0, byteArrayOf(), 1).operation.isSuccess)
            assertTrue(store.close(1).isSuccess)

            assertArrayEquals(
                File(golden, ".sfs-manifest").readBytes(),
                File(directory, ".sfs-manifest").readBytes(),
            )
            assertArrayEquals(
                File(golden, "partition-0/segment-00000000000000000001.sfs").readBytes(),
                File(directory, "partition-0/segment-00000000000000000001.sfs").readBytes(),
            )
            assertArrayEquals(
                File(golden, "partition-1/segment-00000000000000000001.sfs").readBytes(),
                File(directory, "partition-1/segment-00000000000000000001.sfs").readBytes(),
            )
        }
    }

    @Test
    fun readerOpensSharedC11GoldenCorpusAndMergesGlobalSequence() {
        val golden = goldenDirectory()
        withStoreDirectory { directory ->
            assertTrue(golden.copyRecursively(directory, overwrite = true))
            val store = MappedSegmentedFactStore()
            assertTrue(store.open(directory.path, 512, 1, longArrayOf(1024, 1024)).operation.isSuccess)
            val first = store.scan(1, SegmentedFactStoreCursor(), 16)
            val second = store.scan(1, first.cursor, 16)
            val third = store.scan(1, second.cursor, 16)

            assertEquals(listOf(1L, 2L, 3L), listOf(first.record!!.sequence, second.record!!.sequence, third.record!!.sequence))
            assertArrayEquals(byteArrayOf(0x00, 0x01, 0x7f, 0x80.toByte(), 0xff.toByte()), first.record?.payload)
            assertArrayEquals("hello".toByteArray(), second.record?.payload)
            assertArrayEquals(byteArrayOf(), third.record?.payload)
            assertTrue(store.close(1).isSuccess)
        }
    }

    @Test
    fun evictedPartitionCursorReportsARealGapBeforeTheFirstRetainedRecord() {
        withStoreDirectory { directory ->
            val store = MappedSegmentedFactStore()
            assertTrue(store.open(directory.path, 256, 1, longArrayOf(512)).operation.isSuccess)
            repeat(3) { index ->
                val payload = ByteArray(80) { index.toByte() }
                assertTrue(store.append(1, 0, payload, 1).operation.isSuccess)
            }

            val read = store.scan(
                1,
                SegmentedFactStoreCursor(
                    partitionId = 0,
                    afterSequence = 0,
                    segmentId = 1,
                    offset = 64,
                ),
                128,
            )

            assertEquals(2L, read.record?.sequence)
            assertTrue(requireNotNull(read.record).flags and 1 != 0)
            assertEquals(1L, read.record?.gapFirstSequence)
            assertEquals(1L, read.record?.gapLastSequence)

            val initialRead = store.scan(
                1,
                SegmentedFactStoreCursor(partitionId = 0),
                128,
            )
            assertEquals(2L, initialRead.record?.sequence)
            assertTrue(requireNotNull(initialRead.record).flags and 1 != 0)
            assertEquals(1L, initialRead.record?.gapFirstSequence)
            assertEquals(1L, initialRead.record?.gapLastSequence)
            assertTrue(store.close(1).isSuccess)
        }
    }

    @Test
    fun failedEvictionManifestPersistenceKeepsTheRetainedSegmentAcrossReopen() {
        withStoreDirectory { directory ->
            var failManifestPersistence = false
            val store = MappedSegmentedFactStore(
                manifestFileForce = { file ->
                    if (failManifestPersistence) throw IOException("injected manifest persistence failure")
                    file.channel.force(true)
                },
            )
            assertTrue(store.open(directory.path, 256, 1, longArrayOf(512)).operation.isSuccess)
            assertTrue(store.append(1, 0, ByteArray(80) { 1 }, 1).operation.isSuccess)
            assertTrue(store.append(1, 0, ByteArray(80) { 2 }, 1).operation.isSuccess)

            failManifestPersistence = true
            assertEquals(
                SegmentedFactStoreResultCode.IO,
                store.append(1, 0, ByteArray(80) { 3 }, 1).operation.code,
            )
            failManifestPersistence = false
            assertTrue(store.close(1).isSuccess)

            val reopened = MappedSegmentedFactStore()
            assertTrue(reopened.open(directory.path, 256, 1, longArrayOf(512)).operation.isSuccess)
            val first = reopened.scan(1, SegmentedFactStoreCursor(partitionId = 0), 128)
            assertEquals(1L, first.record?.sequence)
            assertArrayEquals(ByteArray(80) { 1 }, first.record?.payload)
            assertEquals(0, requireNotNull(first.record).flags and 1)
            assertTrue(reopened.close(1).isSuccess)
        }
    }

    private fun withStoreDirectory(body: (File) -> Unit) {
        val directory = File.createTempFile("ai-app-bridge-sfs-", "")
        assertTrue(directory.delete())
        assertTrue(directory.mkdir())
        try {
            body(directory)
        } finally {
            directory.deleteRecursively()
        }
    }

    private fun goldenDirectory(): File {
        val working = File(requireNotNull(System.getProperty("user.dir")))
        val candidates = listOf(
            File(working, "native/segmented-fact-store/tests/golden/v1"),
            File(working, "../../native/segmented-fact-store/tests/golden/v1"),
        )
        return candidates.firstOrNull { File(it, "expected.json").isFile }
            ?: error("shared segmented fact store golden corpus is missing")
    }
}
