package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.*
import org.junit.Test
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.util.Random
import java.util.zip.CRC32C

class MappedFactStoreBulkIoTest {
    @Test fun crcMatchesIndependentImplementationForSlicesAndPreservesBufferState() {
        val bytes = ByteArray(32791).also { Random(725L).nextBytes(it) }
        for (length in listOf(0, 1, 7, 8, 23, 24, 8191, 8192, 8193, 16385, 32768)) {
            for (offset in listOf(0, 1, 7, 23)) {
                val oracle = CRC32C().apply { update(bytes, offset, length) }.value.toInt()
                assertEquals(oracle, Crc32c.compute(bytes.copyOfRange(offset, offset + length)))
                for (direct in listOf(false, true)) for (order in listOf(ByteOrder.LITTLE_ENDIAN, ByteOrder.BIG_ENDIAN)) {
                    val buffer = if (direct) ByteBuffer.allocateDirect(bytes.size) else ByteBuffer.allocate(bytes.size)
                    buffer.put(bytes)
                    buffer.order(order)
                    buffer.position(3)
                    buffer.mark()
                    assertEquals(oracle, Crc32c.compute(buffer, offset, length))
                    assertEquals(3, buffer.position())
                    assertEquals(bytes.size, buffer.limit())
                    assertEquals(order, buffer.order())
                    buffer.reset()
                    assertEquals(3, buffer.position())
                }
            }
        }
    }

    @Test fun clearedCommittedHeadersRemainCorruptAcrossLargePayloadBoundaries() {
        for (payloadSize in listOf(8184, 8192, 16376, 16384, 24575)) {
            val directory = Files.createTempDirectory("mapped-commit-boundary-").toFile()
            val store = MappedSegmentedFactStore()
            try {
                val opened = store.open(directory.path, 32768, 1, longArrayOf(65536))
                assertTrue(opened.operation.isSuccess)
                assertTrue(store.append(opened.handle, 0, ByteArray(payloadSize) { 11 }, 1).operation.isSuccess)
                assertTrue(store.close(opened.handle).isSuccess)
                val segment = directory.resolve("partition-0/segment-00000000000000000001.sfs")
                RandomAccessFile(segment, "rw").use { it.seek(64); it.write(ByteArray(24)) }
                val corrupt = segment.readBytes()
                val reopened = store.open(directory.path, 32768, 1, longArrayOf(65536))
                assertEquals(SegmentedFactStoreResultCode.CORRUPT, reopened.operation.code)
                assertEquals("committed frame header at offset 64 was cleared", reopened.operation.message)
                assertArrayEquals("Opening must not discard committed data", corrupt, segment.readBytes())
            } finally { store.close(1); directory.deleteRecursively() }
        }
    }
}
