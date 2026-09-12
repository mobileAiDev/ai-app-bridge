package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.*
import org.junit.Test

class ForegroundActivityTrackerTest {
    private class Screen(val name: String)
    private val main = Screen("Main")
    private val page = Screen("Page")
    private val search = Screen("Search")
    private val tracker = ForegroundActivityTracker<Screen>()

    @Test fun createdAndStartedActivitiesAreNotReadyScreens() {
        tracker.onLifecycle(main, ActivityPhase.CREATED)
        tracker.onLifecycle(main, ActivityPhase.STARTED)
        assertNull(tracker.current())
        tracker.onLifecycle(main, ActivityPhase.RESUMED)
        assertSame(main, tracker.current())
    }

    @Test fun backgroundThemeRecreationCannotStealTheResumedArticle() {
        tracker.onLifecycle(page, ActivityPhase.RESUMED)
        for (background in listOf(main, search)) {
            for (phase in listOf(ActivityPhase.CREATED, ActivityPhase.STARTED, ActivityPhase.STOPPED, ActivityPhase.DESTROYED)) {
                tracker.onLifecycle(background, phase)
                assertSame("Background ${background.name} $phase", page, tracker.current())
            }
        }
    }

    @Test fun navigationWaitsForTheNewActivityToResume() {
        tracker.onLifecycle(main, ActivityPhase.RESUMED)
        tracker.onLifecycle(main, ActivityPhase.PAUSED)
        tracker.onLifecycle(search, ActivityPhase.CREATED)
        tracker.onLifecycle(search, ActivityPhase.STARTED)
        assertNull(tracker.current())
        tracker.onLifecycle(search, ActivityPhase.RESUMED)
        tracker.onLifecycle(main, ActivityPhase.STOPPED)
        assertSame(search, tracker.current())
    }

    @Test fun destroyingAnOldInstanceDoesNotClearItsResumedReplacement() {
        val replacement = Screen("Page")
        tracker.onLifecycle(page, ActivityPhase.RESUMED)
        tracker.onLifecycle(page, ActivityPhase.PAUSED)
        tracker.onLifecycle(replacement, ActivityPhase.CREATED)
        tracker.onLifecycle(replacement, ActivityPhase.STARTED)
        tracker.onLifecycle(replacement, ActivityPhase.RESUMED)
        tracker.onLifecycle(page, ActivityPhase.STOPPED)
        tracker.onLifecycle(page, ActivityPhase.DESTROYED)
        assertSame(replacement, tracker.current())
    }

    @Test fun onlyTheSameInactiveInstanceClearsTheOwner() {
        for (phase in listOf(ActivityPhase.PAUSED, ActivityPhase.STOPPED, ActivityPhase.DESTROYED)) {
            tracker.onLifecycle(page, ActivityPhase.RESUMED)
            tracker.onLifecycle(main, phase)
            assertSame(page, tracker.current())
            tracker.onLifecycle(page, phase)
            assertNull(tracker.current())
        }
    }

    @Test fun lateExplicitStartRequiresFocusAndCannotReplaceAResumedOwner() {
        assertFalse(tracker.initializeFocused(main, focused = false))
        assertNull(tracker.current())
        assertTrue(tracker.initializeFocused(page, focused = true))
        assertSame(page, tracker.current())
        tracker.onLifecycle(page, ActivityPhase.RESUMED)
        assertFalse(tracker.initializeFocused(main, focused = true))
        assertFalse(tracker.initializeFocused(page, focused = true))
        assertSame(page, tracker.current())
        tracker.onLifecycle(page, ActivityPhase.PAUSED)
        assertTrue(tracker.initializeFocused(search, focused = true))
        assertSame(search, tracker.current())
    }
}
