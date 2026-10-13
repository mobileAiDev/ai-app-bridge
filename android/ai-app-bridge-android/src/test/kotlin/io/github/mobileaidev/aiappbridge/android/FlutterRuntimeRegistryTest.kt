package io.github.mobileaidev.aiappbridge.android

import org.junit.Assert.*
import org.junit.Test

class FlutterRuntimeRegistryTest {
    private class Screen(val name: String)
    private class Channel(val name: String)
    private val tracker = ForegroundActivityTracker<Screen>()
    private val registry = FlutterRuntimeRegistry<Screen, Channel>(tracker::current)
    private val a = Screen("A")
    private val b = Screen("B")
    private val channelA = Channel("A")
    private val channelB = Channel("B")
    private fun snapshot(epoch: String) = FlutterRuntimeRegistry.Snapshot.parse(
        """{"engine":"$epoch","layout":{"operable":{"runtimeEpoch":"$epoch"}},"uiObservation":{"active":false}}""")
    private fun resume(screen: Screen) {
        tracker.onLifecycle(screen, ActivityPhase.RESUMED); registry.refreshSelection()
    }

    @Test fun backgroundAttachAndSnapshotCannotStealTheResumedRuntimeAndReturningSelectsItsOwnEpoch() {
        resume(a); registry.register(a, channelA); registry.updateSnapshot(channelA, snapshot("epoch-A"))
        registry.register(b, channelB); registry.updateSnapshot(channelB, snapshot("epoch-B"))
        assertSame(channelA, registry.current()!!.handler)
        assertEquals("epoch-A", registry.current()!!.snapshot.epoch)
        resume(b)
        assertSame(channelB, registry.current()!!.handler)
        assertEquals("epoch-B", registry.current()!!.snapshot.epoch)
        resume(a)
        assertSame(channelA, registry.current()!!.handler)
        assertEquals("epoch-A", registry.current()!!.snapshot.epoch)
    }

    @Test fun lateObservationCannotPublishIntoTheOtherRuntimeOrAcrossAReturnTransition() {
        registry.register(a, channelA); registry.register(b, channelB)
        resume(a); val observedA = registry.current()!!
        resume(b); assertFalse(registry.acceptObservation(observedA, snapshot("late-A")))
        assertNull(registry.current()!!.snapshot.epoch)
        resume(a); assertFalse(registry.acceptObservation(observedA, snapshot("late-A")))
        assertTrue(registry.acceptObservation(registry.current()!!, snapshot("current-A")))
        assertEquals("current-A", registry.current()!!.snapshot.epoch)
    }

    @Test fun lateDetachAndPushFromReplacedEngineCannotRemoveOrContaminateItsReplacement() {
        registry.register(a, channelA); resume(a)
        val old = registry.current()!!
        registry.register(a, channelB)
        assertNull("Replacement never inherits a different engine's epoch", registry.current()!!.snapshot.epoch)
        assertFalse(registry.remove(channelA))
        assertFalse(registry.updateSnapshot(channelA, snapshot("old-A")))
        assertFalse(registry.acceptObservation(old, snapshot("old-A")))
        registry.updateSnapshot(channelB, snapshot("new-A"))
        assertSame(channelB, registry.current()!!.handler)
        assertEquals("new-A", registry.current()!!.snapshot.epoch)
    }

    @Test fun oldActivityDestroyDoesNotRemoveAnotherResumedActivityAndBackgroundPauseDoesNotChangeSelection() {
        registry.register(a, channelA); registry.register(b, channelB); resume(b)
        val current = registry.current()!!
        tracker.onLifecycle(a, ActivityPhase.PAUSED); registry.refreshSelection()
        assertTrue(registry.isCurrent(current))
        registry.removeActivity(a); assertTrue(registry.isCurrent(current))
        tracker.onLifecycle(b, ActivityPhase.PAUSED); registry.refreshSelection()
        assertNull(registry.current()); assertFalse(registry.isCurrent(current))
    }

    @Test fun registrationAfterResumeUsesTheAlreadyKnownForegroundWithoutAnotherResumeEvent() {
        resume(a); assertNull(registry.current())
        registry.register(a, channelA)
        assertSame(channelA, registry.current()!!.handler)
    }

    @Test fun existingLegacyApiStaysIsolatedFromActivityBindings() {
        registry.updateLegacySnapshot(snapshot("legacy"))
        assertEquals("legacy", registry.snapshot().epoch)
        registry.setLegacyHandler(channelA)
        assertEquals("legacy", registry.current()!!.snapshot.epoch)
        registry.register(b, channelB); resume(b)
        registry.updateSnapshot(channelB, snapshot("bound"))
        registry.updateLegacySnapshot(snapshot("late-legacy")); registry.setLegacyHandler(channelA)
        assertSame(channelB, registry.current()!!.handler)
        assertEquals("bound", registry.snapshot().epoch)
        registry.remove(channelB)
        assertNull(registry.current())
        assertEquals("{}", registry.snapshot().full)
    }
}
