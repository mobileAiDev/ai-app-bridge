package io.github.mobileaidev.aiappbridge.android

import java.util.IdentityHashMap

/** One-shot focus initialization for an explicit start(Activity), on the main thread. */
internal class FocusedActivityStart<T : Any>(
    private val tracker: ForegroundActivityTracker<T>,
    private val usable: (T) -> Boolean,
    private val focused: (T) -> Boolean,
    private val watchFocus: (T, () -> Unit) -> (() -> Unit),
    private val initialized: (T) -> Unit,
) {
    private class Pending { var removeListener: (() -> Unit)? = null }
    private val pending = IdentityHashMap<T, Pending>()

    fun start(activity: T) {
        if (!usable(activity) || tracker.current() != null) {
            cancel(activity)
            return
        }
        if (focused(activity)) {
            cancel(activity)
            if (tracker.initializeFocused(activity, focused = true)) initialized(activity)
            return
        }
        if (pending.containsKey(activity)) return
        val waiting = Pending()
        pending[activity] = waiting
        val remove = watchFocus(activity) {
            if (pending[activity] !== waiting) return@watchFocus
            cancel(activity)
            if (usable(activity) && focused(activity) && tracker.initializeFocused(activity, focused = true)) {
                initialized(activity)
            }
        }
        waiting.removeListener = remove
        if (pending[activity] !== waiting) remove()
    }

    fun cancel(activity: T) {
        pending.remove(activity)?.removeListener?.invoke()
    }
}
