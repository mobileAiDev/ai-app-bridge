package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject
import java.util.UUID

/** One bounded observation owner. Activity/transport lifetimes cannot extend it. */
internal class UiObservationWindow(private val nowMs: () -> Long) {
    private var id: String? = null
    private var deadlineMs = 0L
    val active: Boolean get() = id != null && nowMs() < deadlineMs

    fun start(durationMs: Long): String {
        require(durationMs in 100..5000) { "invalid_ui_observation_duration" }
        check(!active) { "ui_observation_busy" }
        return UUID.randomUUID().toString().also { id = it; deadlineMs = nowMs() + durationMs }
    }

    fun stop(leaseId: String): Boolean {
        if (id != leaseId) return false
        clear()
        return true
    }

    fun clear() { id = null; deadlineMs = 0L }

    fun status(): JSONObject = JSONObject()
        .put("ok", true).put("schemaVersion", "aab.ui-observation/v1")
        .put("mode", "on-demand").put("active", active)
        .put("leaseId", if (active) id else JSONObject.NULL)
        .put("remainingMs", if (active) (deadlineMs - nowMs()).coerceAtLeast(0) else 0)
        .put("maxDurationMs", 5000)
}
