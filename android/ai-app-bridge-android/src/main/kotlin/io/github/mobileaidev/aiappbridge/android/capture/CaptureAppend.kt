package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONArray
import org.json.JSONObject

internal object CaptureAppend {
    fun appendSanitized(
        store: MobileCaptureStore,
        event: JSONObject,
        targetKey: String,
        runtimeEpoch: String,
    ): AppendReceipt {
        val type = event.getString("type")
        val stream = when (type) {
            "log" -> "logs"
            "network" -> "network"
            "state" -> "state"
            "event" -> "events"
            else -> throw IllegalArgumentException(type)
        }
        return store.append(
            CaptureInput(
                stream = stream,
                targetKey = targetKey,
                runtimeEpoch = runtimeEpoch,
                captureId = event.getLong("id"),
                timestampMs = event.getLong("timestampMs"),
                record = event,
                actionId = event.optString("actionId").takeIf { it.isNotBlank() },
                source = event.getString("source"),
                stateKey = if (stream == "state") {
                    "${event.getString("namespace")}.${event.getString("key")}"
                } else {
                    null
                },
            ),
        )
    }

    fun itemsMatch(oracle: JSONArray, live: JSONArray): Boolean {
        if (oracle.length() != live.length()) return false
        for (index in 0 until oracle.length()) {
            if (!jsonEqual(oracle.get(index), live.get(index))) return false
        }
        return true
    }

    fun valuesMatch(oracle: JSONObject, live: JSONObject): Boolean = jsonEqual(oracle, live)

    private fun jsonEqual(left: Any?, right: Any?): Boolean {
        if (left is JSONObject && right is JSONObject) {
            if (left.length() != right.length()) return false
            val keys = left.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (!right.has(key) || !jsonEqual(left.opt(key), right.opt(key))) return false
            }
            return true
        }
        if (left is JSONArray && right is JSONArray) {
            if (left.length() != right.length()) return false
            for (index in 0 until left.length()) {
                if (!jsonEqual(left.get(index), right.get(index))) return false
            }
            return true
        }
        if (left == JSONObject.NULL && right == JSONObject.NULL) return true
        return left == right
    }
}
