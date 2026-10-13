package io.github.mobileaidev.aiappbridge.android

import android.os.Debug
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.FileInputStream

/** Run each algorithm in a fresh ART process over the same archived frame payloads. */
object FactStoreCrcSnapshotProbe {
    @JvmStatic fun main(args: Array<String>) {
        require(args.size == 2) { "Expected payload file and bytewise|slicing" }
        val algorithm = args[1]
        require(algorithm == "bytewise" || algorithm == "slicing")
        val samples = JSONArray()
        repeat(3) { iteration ->
            val cpu = Debug.threadCpuTimeNanos()
            val began = SystemClock.elapsedRealtimeNanos()
            var records = 0
            var payloadBytes = 0L
            DataInputStream(BufferedInputStream(FileInputStream(args[0]), 65536)).use { input ->
                val magic = ByteArray(8).also(input::readFully)
                require(magic.contentEquals("AABCRC01".toByteArray(Charsets.US_ASCII)))
                val count = input.readInt()
                require(count >= 0)
                repeat(count) {
                    val length = input.readInt()
                    val expected = input.readInt()
                    require(length in 0..SegmentedFactStore.MAX_PERSISTED_PAYLOAD_BYTES)
                    val payload = ByteArray(length).also(input::readFully)
                    val actual = if (algorithm == "bytewise") OriginalCrc32c.compute(payload) else Crc32c.compute(payload)
                    check(actual == expected) { "Payload CRC mismatch at record $records" }
                    records += 1
                    payloadBytes += length
                }
                check(input.read() == -1) { "Unexpected bytes after the last payload" }
            }
            samples.put(JSONObject().put("iteration", iteration).put("cold", iteration == 0)
                .put("elapsedMs", (SystemClock.elapsedRealtimeNanos() - began) / 1_000_000.0)
                .put("cpuMs", (Debug.threadCpuTimeNanos() - cpu) / 1_000_000.0)
                .put("records", records).put("payloadBytes", payloadBytes).put("allFrameChecksumsMatch", true))
        }
        println(JSONObject().put("ok", true).put("algorithm", algorithm).put("samples", samples).toString())
    }

    private object OriginalCrc32c {
        private val table = IntArray(256) { seed ->
            var value = seed
            repeat(8) {
                value = (value ushr 1) xor if (value and 1 != 0) 0x82F63B78.toInt() else 0
            }
            value
        }

        fun compute(bytes: ByteArray): Int {
            var crc = -1
            bytes.forEach { byte ->
                crc = table[(crc xor (byte.toInt() and 0xFF)) and 0xFF] xor (crc ushr 8)
            }
            return crc.inv()
        }
    }
}
