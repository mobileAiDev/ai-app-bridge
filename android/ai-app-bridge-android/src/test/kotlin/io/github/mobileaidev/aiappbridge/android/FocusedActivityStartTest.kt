package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.*
import org.junit.Test

class FocusedActivityStartTest {
    private class Screen {
        var usable = true
        var focused = false
        val listeners = mutableListOf<() -> Unit>()
        fun gainFocus() {
            focused = true
            listeners.toList().forEach { it() }
        }
    }
    private val tracker = ForegroundActivityTracker<Screen>()
    private val attached = mutableListOf<Screen>()
    private val starter = FocusedActivityStart(tracker, { it.usable }, { it.focused }, { screen, listener ->
        screen.listeners.add(listener)
        val remove: () -> Unit = { screen.listeners.remove(listener); Unit }
        remove
    }, { attached.add(it) })

    @Test fun startAfterResumeDispatchWaitsForTheFirstActualWindowFocus() {
        val page = Screen()
        // onActivityResumed already happened before Bridge registered callbacks.
        starter.start(page)
        assertNull(tracker.current())
        assertEquals(1, page.listeners.size)
        page.gainFocus()
        assertSame(page, tracker.current())
        assertEquals(listOf(page), attached)
        assertTrue(page.listeners.isEmpty())
    }

    @Test fun alreadyFocusedLateStartAttachesWithoutAddingAListener() {
        val page = Screen().apply { focused = true }
        starter.start(page)
        assertSame(page, tracker.current())
        assertEquals(listOf(page), attached)
        assertTrue(page.listeners.isEmpty())
    }

    @Test fun repeatedStartsShareOneListenerAndCancelledCallbacksCannotReviveTheOwner() {
        val page = Screen()
        starter.start(page)
        val oldCallback = page.listeners.single()
        starter.start(page)
        assertEquals(1, page.listeners.size)
        starter.cancel(page)
        assertTrue(page.listeners.isEmpty())
        starter.start(page)
        page.focused = true
        oldCallback()
        assertNull(tracker.current())
        assertEquals(1, page.listeners.size)
        page.gainFocus()
        assertSame(page, tracker.current())
        assertEquals(listOf(page), attached)
    }

    @Test fun inactiveActivityCancelsFocusInitialization() {
        for (phase in listOf(ActivityPhase.PAUSED, ActivityPhase.STOPPED, ActivityPhase.DESTROYED)) {
            val page = Screen()
            starter.start(page)
            val delayedCallback = page.listeners.single()
            starter.cancel(page)
            tracker.onLifecycle(page, phase)
            page.focused = true
            delayedCallback()
            assertNull(tracker.current())
            assertTrue(page.listeners.isEmpty())
        }
        assertTrue(attached.isEmpty())
    }

    @Test fun resumedActivityTakesPrecedenceOverThePendingExplicitStart() {
        val background = Screen()
        val page = Screen()
        starter.start(background)
        tracker.onLifecycle(page, ActivityPhase.RESUMED)
        background.gainFocus()
        assertSame(page, tracker.current())
        assertTrue(background.listeners.isEmpty())
        assertTrue(attached.isEmpty())
    }

    @Test fun normalResumeAndUnavailableWindowsRemovePendingListeners() {
        val page = Screen()
        starter.start(page)
        starter.cancel(page)
        tracker.onLifecycle(page, ActivityPhase.RESUMED)
        page.gainFocus()
        assertSame(page, tracker.current())
        assertTrue(page.listeners.isEmpty())
        assertTrue(attached.isEmpty())
        tracker.onLifecycle(page, ActivityPhase.PAUSED)
        val destroyed = Screen()
        starter.start(destroyed)
        destroyed.usable = false
        destroyed.gainFocus()
        assertNull(tracker.current())
        assertTrue(destroyed.listeners.isEmpty())
        assertTrue(attached.isEmpty())
    }
}
