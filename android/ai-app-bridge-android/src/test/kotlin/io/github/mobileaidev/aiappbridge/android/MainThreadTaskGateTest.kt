package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

class MainThreadTaskGateTest {
    @Test fun timedOutQueuedWorkCannotProduceALateEffect() {
        val gate = MainThreadTaskGate()
        var effects = 0
        val queued = { if (gate.begin()) effects++ }
        assertTrue(gate.cancelQueued())
        queued(); queued()
        assertEquals(0, effects)
    }

    @Test fun startedWorkIsNeverReportedAsSuccessfullyCancelled() {
        val gate = MainThreadTaskGate()
        assertTrue(gate.begin())
        assertFalse(gate.cancelQueued())
        assertFalse(gate.begin())
    }

    @Test fun cancellationAndDispatchHaveExactlyOneWinner() {
        val executor = Executors.newFixedThreadPool(2)
        try {
            repeat(1000) {
                val gate = MainThreadTaskGate()
                val start = CountDownLatch(1)
                val effects = AtomicInteger()
                val action = executor.submit<Boolean> { start.await(); gate.begin().also { if (it) effects.incrementAndGet() } }
                val cancel = executor.submit<Boolean> { start.await(); gate.cancelQueued() }
                start.countDown()
                val dispatched = action.get(); val cancelled = cancel.get()
                assertTrue(dispatched xor cancelled)
                assertEquals(if (cancelled) 0 else 1, effects.get())
            }
        } finally { executor.shutdownNow() }
    }
}
