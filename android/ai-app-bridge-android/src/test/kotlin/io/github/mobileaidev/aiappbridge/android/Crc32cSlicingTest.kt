package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Random
import java.util.zip.CRC32C

class Crc32cSlicingTest {
    @Test fun byteArraysMatchCastagnoliVectorAndOriginalByteAlgorithm() {
        assertEquals(0, Crc32c.compute(byteArrayOf()))
        assertEquals(0xE3069283.toInt(), Crc32c.compute("123456789".toByteArray()))
        val random = Random(327891L)
        val sizes = (0..257).toList() + listOf(8191, 8192, 8193, 16383, 16384, 16385, 65537)
        for (size in sizes) {
            val bytes = ByteArray(size).also(random::nextBytes)
            val oracle = CRC32C().apply { update(bytes, 0, size) }.value.toInt()
            assertEquals("original size=$size", oracle, originalByteAlgorithm(bytes, 0, size))
            assertEquals("slicing size=$size", oracle, Crc32c.compute(bytes))
        }
    }

    @Test fun arbitrarySlicesAndBufferKindsPreserveCallerState() {
        val random = Random(518045L)
        val bytes = ByteArray(65591).also(random::nextBytes)
        val slices = mutableListOf<Pair<Int, Int>>()
        for (offset in 0..15) for (length in 0..17) slices += offset to length
        for (offset in listOf(0, 1, 7, 8, 15, 23)) {
            for (length in listOf(8191, 8192, 8193, 16383, 16384, 16385, 65537)) {
                slices += offset to length
            }
        }
        repeat(80) {
            val offset = random.nextInt(bytes.size + 1)
            slices += offset to random.nextInt(bytes.size - offset + 1)
        }
        for ((offset, length) in slices) {
            val oracle = CRC32C().apply { update(bytes, offset, length) }.value.toInt()
            assertEquals(oracle, originalByteAlgorithm(bytes, offset, length))
            for (direct in listOf(false, true)) for (readOnly in listOf(false, true)) {
                for (order in listOf(ByteOrder.LITTLE_ENDIAN, ByteOrder.BIG_ENDIAN)) {
                    val writable = if (direct) ByteBuffer.allocateDirect(bytes.size) else ByteBuffer.allocate(bytes.size)
                    writable.put(bytes)
                    val buffer = (if (readOnly) writable.asReadOnlyBuffer() else writable).order(order)
                    buffer.position(3)
                    buffer.mark()
                    buffer.position(5)
                    assertEquals("offset=$offset length=$length direct=$direct readOnly=$readOnly order=$order",
                        oracle, Crc32c.compute(buffer, offset, length))
                    assertEquals(5, buffer.position())
                    assertEquals(bytes.size, buffer.limit())
                    assertEquals(order, buffer.order())
                    buffer.reset()
                    assertEquals(3, buffer.position())
                }
            }
        }
    }

    @Test fun slicedBuffersUseTheirOwnOffsetAndLimit() {
        val bytes = ByteArray(16403).also(Random(7503L)::nextBytes)
        for (direct in listOf(false, true)) for (readOnly in listOf(false, true)) {
            val outer = if (direct) ByteBuffer.allocateDirect(bytes.size + 14) else ByteBuffer.allocate(bytes.size + 14)
            outer.position(7)
            outer.put(bytes)
            outer.position(7)
            outer.limit(7 + bytes.size)
            val slice = outer.slice()
            val buffer = if (readOnly) slice.asReadOnlyBuffer() else slice
            buffer.position(2)
            buffer.mark()
            for (offset in listOf(0, 1, 7)) for (length in listOf(0, 7, 8, 8192, 8193, 16384)) {
                val oracle = CRC32C().apply { update(bytes, offset, length) }.value.toInt()
                assertEquals(oracle, Crc32c.compute(buffer, offset, length))
                assertEquals(2, buffer.position())
                assertEquals(bytes.size, buffer.limit())
                buffer.reset()
            }
        }
    }

    private fun originalByteAlgorithm(bytes: ByteArray, offset: Int, length: Int): Int {
        var crc = -1
        for (index in offset until offset + length) {
            crc = originalTable[(crc xor bytes[index].toInt()) and 0xFF] xor (crc ushr 8)
        }
        return crc.inv()
    }

    private val originalTable = IntArray(256) { seed ->
        var value = seed
        repeat(8) { value = (value ushr 1) xor if (value and 1 != 0) 0x82F63B78.toInt() else 0 }
        value
    }
}
