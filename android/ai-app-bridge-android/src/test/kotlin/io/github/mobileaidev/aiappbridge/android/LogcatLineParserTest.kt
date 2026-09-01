package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LogcatLineParserTest {
    @Test
    fun parsesEveryPriorityAndKeepsOtherProcessLines() {
        val levels = listOf(
            "V" to "verbose",
            "D" to "debug",
            "I" to "info",
            "W" to "warn",
            "E" to "error",
            "F" to "fatal",
        )
        for ((token, level) in levels) {
            val line = LogcatLineParser.parse("01-02 03:04:05.678 $token/ActivityManager(  512): Start proc")
            assertTrue(line.parsed)
            assertEquals(level, line.level)
            assertEquals("ActivityManager", line.tag)
            assertEquals(512, line.processId)
            assertEquals("Start proc", line.message)
        }
        assertEquals(MobileFactPartition.DEVICE_LOG, LogcatLineParser.partition(512, 1234))
        assertEquals(MobileFactPartition.APP_LOG, LogcatLineParser.partition(512, 512))
        assertEquals(MobileFactPartition.APP_LOG, LogcatLineParser.partition(-1, 1234))
        assertEquals(MobileFactPartition.APP_LOG, LogcatLineParser.partition(0, 1234))
    }

    @Test
    fun parsesCompactPidAndEmptyMessage() {
        val compact = LogcatLineParser.parse("12-31 23:59:59.001 D/OkHttp(12): ")
        val empty = LogcatLineParser.parse("12-31 23:59:59.001 I/App(1): ")

        assertTrue(compact.parsed)
        assertEquals(12, compact.processId)
        assertEquals("", compact.message)
        assertTrue(empty.parsed)
        assertEquals("", empty.message)
    }

    @Test
    fun keepsUnparsedLinesForPersist() {
        val line = LogcatLineParser.parse("--------- beginning of main")

        assertFalse(line.parsed)
        assertEquals(-1, line.processId)
        assertEquals("--------- beginning of main", line.message)
        assertEquals("info", line.level)
        assertEquals(MobileFactPartition.APP_LOG, LogcatLineParser.partition(line.processId, 1234))
    }
}
