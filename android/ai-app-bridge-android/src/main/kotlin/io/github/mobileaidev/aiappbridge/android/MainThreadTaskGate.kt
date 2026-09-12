package io.github.mobileaidev.aiappbridge.android

import java.util.concurrent.atomic.AtomicInteger

// A timed-out queued action must never run later when the UI thread wakes up.
// Once execution starts, timeout cannot prove that its effect did not happen.
internal class MainThreadTaskGate {
    private val state = AtomicInteger(0)
    fun begin(): Boolean = state.compareAndSet(0, 1)
    fun cancelQueued(): Boolean = state.compareAndSet(0, 2)
}
