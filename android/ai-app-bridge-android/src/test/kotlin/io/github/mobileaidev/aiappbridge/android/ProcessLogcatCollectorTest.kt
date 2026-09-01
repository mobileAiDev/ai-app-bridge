package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ProcessLogcatCollectorTest {
    @Test
    fun persistsEveryReadableLineIncludingOtherPids() {
        val lines = LinkedBlockingQueue<CapturedLogLine>()
        val done = CountDownLatch(3)
        val collector = ProcessLogcatCollector(
            openSource = {
                QueueLogcatSource(
                    listOf(
                        "01-02 03:04:05.678 I/AppTag(  99): app line",
                        "01-02 03:04:05.679 W/System(  1): other process",
                        "--------- beginning of main",
                    ),
                )
            },
            persist = { line ->
                lines.add(line)
                done.countDown()
            },
        )

        collector.start()
        assertTrue(done.await(2, TimeUnit.SECONDS))
        collector.stop()

        assertEquals(3, lines.size)
        assertEquals(99, lines.take().processId)
        assertEquals(1, lines.take().processId)
        assertEquals(-1, lines.take().processId)
    }

    @Test
    fun startAfterSourceEndsPersistsASecondBatch() {
        val opens = AtomicInteger(0)
        val lines = LinkedBlockingQueue<CapturedLogLine>()
        val firstClosed = CountDownLatch(1)
        val second = CountDownLatch(1)
        val collector = ProcessLogcatCollector(
            openSource = {
                if (opens.incrementAndGet() == 1) {
                    QueueLogcatSource(
                        listOf("01-02 03:04:05.678 I/First(1): one"),
                        onClose = { firstClosed.countDown() },
                    )
                } else {
                    QueueLogcatSource(listOf("01-02 03:04:05.679 I/Second(2): two"))
                }
            },
            persist = { line ->
                lines.add(line)
                if (line.message == "two") second.countDown()
            },
        )

        collector.start()
        assertTrue(firstClosed.await(2, TimeUnit.SECONDS))
        collector.start()
        assertTrue(second.await(2, TimeUnit.SECONDS))
        collector.stop()

        assertEquals(listOf("one", "two"), lines.map { it.message })
        assertEquals(2, opens.get())
    }

    @Test
    fun failedOpenLeavesCollectorRestartable() {
        val opens = AtomicInteger(0)
        val lines = LinkedBlockingQueue<CapturedLogLine>()
        val done = CountDownLatch(1)
        val collector = ProcessLogcatCollector(
            openSource = {
                if (opens.incrementAndGet() == 1) {
                    throw IllegalStateException("logcat missing")
                }
                QueueLogcatSource(listOf("01-02 03:04:05.678 I/Recovered(1): ok"))
            },
            persist = { line ->
                lines.add(line)
                done.countDown()
            },
        )

        collector.start()
        collector.start()
        assertTrue(done.await(2, TimeUnit.SECONDS))
        collector.stop()

        assertEquals("ok", lines.take().message)
        assertEquals(2, opens.get())
    }

    private class QueueLogcatSource(
        lines: List<String>,
        private val onClose: () -> Unit = {},
    ) : LogcatLineSource {
        private val remaining = ArrayList(lines)

        override fun readLine(): String? {
            return if (remaining.isEmpty()) {
                null
            } else {
                remaining.removeAt(0)
            }
        }

        override fun close() = onClose()
    }
}
