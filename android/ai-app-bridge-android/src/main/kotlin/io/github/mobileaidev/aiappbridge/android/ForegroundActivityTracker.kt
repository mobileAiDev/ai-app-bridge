package io.github.mobileaidev.aiappbridge.android

import java.lang.ref.WeakReference

internal enum class ActivityPhase { CREATED, STARTED, RESUMED, PAUSED, STOPPED, DESTROYED }

/** Background Activity recreation must not replace the resumed screen. */
internal class ForegroundActivityTracker<T : Any> {
    @Volatile private var owner: WeakReference<T>? = null

    fun current(): T? = owner?.get()

    @Synchronized
    fun onLifecycle(activity: T, phase: ActivityPhase) {
        when (phase) {
            ActivityPhase.CREATED, ActivityPhase.STARTED -> Unit
            ActivityPhase.RESUMED -> owner = WeakReference(activity)
            ActivityPhase.PAUSED, ActivityPhase.STOPPED, ActivityPhase.DESTROYED -> {
                if (owner?.get() === activity) owner = null
            }
        }
    }

    // start(Activity) may be called after onResume, before Bridge registered its
    // callbacks. A currently focused window is required for this initial seed;
    // an existing lifecycle-selected owner always remains authoritative.
    @Synchronized
    fun initializeFocused(activity: T, focused: Boolean): Boolean {
        if (!focused || owner?.get() != null) return false
        owner = WeakReference(activity)
        return true
    }
}
