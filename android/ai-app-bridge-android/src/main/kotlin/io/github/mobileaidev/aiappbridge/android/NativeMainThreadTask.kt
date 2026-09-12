package io.github.mobileaidev.aiappbridge.android

import android.os.Handler
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class NativeMutationGate {
    private val stopped = AtomicReference<String?>()
    private val dispatched = AtomicBoolean()
    fun stop(reason: String) { stopped.compareAndSet(null, reason) }
    fun check() { stopped.get()?.let { throw NativeTargetFailure(it, dispatched = dispatched.get()) } }
    fun dispatch() { check(); dispatched.set(true) }
    fun didDispatch(): Boolean = dispatched.get()
}

internal class NativeMainThreadTask(private val handler: Handler, private val block: (NativeMutationGate) -> JSONObject) : ManagedExecutionTask {
    private val queue = MainThreadTaskGate()
    private val mutation = NativeMutationGate()
    private val result = AtomicReference<JSONObject?>()
    private val callback = AtomicReference<((JSONObject) -> Unit)?>()
    private val delivered = AtomicBoolean()
    private val task = Runnable {
        if (!queue.begin()) return@Runnable
        val response = try { mutation.check(); block(mutation) }
        catch (error: NativeTargetFailure) { error.response() }
        catch (error: Throwable) { NativeTargetFailure("native_action_failed", dispatched = mutation.didDispatch()).response()
            .put("ambiguous", mutation.didDispatch()).put("cause", error.javaClass.name) }
        finish(response)
    }

    override fun start(complete: (JSONObject) -> Unit) {
        callback.set(complete)
        if (result.get() != null) { deliver(); return }
        if (!handler.post(task)) finish(NativeTargetFailure("main_thread_unavailable").response())
    }

    override fun stop(reason: String) {
        mutation.stop(reason)
        if (queue.cancelQueued()) {
            handler.removeCallbacks(task)
            finish(NativeTargetFailure(reason).response())
        }
    }

    private fun finish(response: JSONObject) { if (result.compareAndSet(null, response)) deliver() }
    private fun deliver() {
        val response = result.get() ?: return
        val complete = callback.get() ?: return
        if (delivered.compareAndSet(false, true)) complete(response)
    }
}
