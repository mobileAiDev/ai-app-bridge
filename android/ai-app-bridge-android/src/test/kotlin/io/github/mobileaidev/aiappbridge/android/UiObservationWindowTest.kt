package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.*
import org.junit.Test

class UiObservationWindowTest {
    @Test fun ownershipExpiryAndFreshWindows() {
        var now = 0L
        val window = UiObservationWindow { now }
        assertFalse(window.active)
        val first = window.start(1000)
        assertTrue(window.active)
        assertFalse(window.stop("other-owner"))
        assertTrue(window.active)
        assertThrows(IllegalStateException::class.java) { window.start(200) }
        now = 1000
        assertFalse(window.active)
        val next = window.start(200)
        assertNotEquals(first, next)
        assertFalse(window.stop(first))
        assertTrue(window.stop(next))
        assertFalse(window.active)
    }

    @Test fun cannotRequestUnboundedObservation() {
        val window = UiObservationWindow { 0 }
        for (duration in listOf(0L, -1L, 99L, 5001L, Long.MAX_VALUE)) {
            assertThrows(IllegalArgumentException::class.java) { window.start(duration) }
        }
        assertFalse(window.active)
    }
}
