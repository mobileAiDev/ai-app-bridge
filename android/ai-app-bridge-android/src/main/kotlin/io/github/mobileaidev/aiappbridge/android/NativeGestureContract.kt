package io.github.mobileaidev.aiappbridge.android

import org.json.JSONObject

internal data class NativeGestureRequest(
    val body: JSONObject,
    val action: String,
    val actionId: String,
    val durationMs: Long,
    val timeoutMs: Long,
    val deltaX: Double = 0.0,
    val deltaY: Double = 0.0,
    val direction: String? = null,
)

internal object NativeGestureContract {
    fun parse(body: JSONObject): NativeGestureRequest {
        val action = body.opt("action") as? String
            ?: throw NativeTargetFailure(if (body.has("action")) "invalid_argument" else "missing_argument", "action")
        val extra = when (action) {
            "longPress" -> emptySet()
            "swipe" -> setOf("deltaX", "deltaY")
            "scroll" -> setOf("direction")
            else -> throw NativeTargetFailure("unsupported_gesture", "action")
        }
        NativeTargetContract.validateRequest(body, input = false, additionalFields = extra + setOf("action", "durationMs"))
        if (!body.has("actionId")) throw NativeTargetFailure("missing_argument", "actionId")
        val duration = integer(body, "durationMs", if (action == "longPress") 500 else 1, 10000)
        val timeout = body.getJSONObject("execution").getLong("timeoutMs")
        if (timeout < duration) throw NativeTargetFailure("insufficient_gesture_budget", "execution.timeoutMs")
        val direction = if (action == "scroll") {
            val value = body.opt("direction") as? String
            if (value !in listOf("up", "down")) throw NativeTargetFailure("invalid_argument", "direction")
            value
        } else null
        return NativeGestureRequest(body, action, body.getString("actionId"), duration, timeout,
            if (action == "swipe") number(body, "deltaX") else 0.0,
            if (action == "swipe") number(body, "deltaY") else 0.0, direction)
    }

    private fun number(body: JSONObject, key: String): Double {
        val number = (body.opt(key) as? Number)?.toDouble()
        if (number == null || !number.isFinite()) throw NativeTargetFailure(if (body.has(key)) "invalid_argument" else "missing_argument", key)
        return number
    }

    private fun integer(body: JSONObject, key: String, min: Long, max: Long): Long {
        val value = number(body, key)
        if (value < min || value > max || value != value.toLong().toDouble()) throw NativeTargetFailure("invalid_argument", key)
        return value.toLong()
    }
}
