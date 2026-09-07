package io.github.mobileaidev.aiappbridge.android.capture

import org.json.JSONArray
import org.json.JSONObject

internal object LegacyLiveView {
    fun envelope(
        page: CapturePage,
        query: CaptureQuery,
        nowMs: Long,
    ): JSONObject {
        val limit = resolveLimit(query)
        val body = JSONObject()
            .put("ok", page.ok)
            .put("type", page.type)
            .put("items", JSONArray(page.items.map { JSONObject(it.toString()) }))
            .put("count", page.count)
            .put("sinceId", query.sinceId ?: JSONObject.NULL)
            .put("sinceMs", query.sinceMs ?: JSONObject.NULL)
            .put("limit", limit)
            .put("updatedAtMs", nowMs)
        if (page.type == "state") {
            val values = JSONObject()
            for ((key, value) in page.values) {
                values.put(key, value ?: JSONObject.NULL)
            }
            body.put("values", values)
        }
        return body
    }

    fun resolveLimit(query: CaptureQuery): Int {
        val max = if (query.platform == "ios") 1_000 else 500
        return (query.limit ?: 200).coerceIn(1, max)
    }

    fun fromHttp(
        store: MobileCaptureStore,
        stream: String,
        http: Map<String, String>,
        nowMs: Long,
        platform: String = "android",
    ): JSONObject {
        val query = CaptureQuery(
            view = http["view"] ?: "legacy-live",
            stream = stream,
            sinceId = http["sinceId"]?.toLongOrNull(),
            sinceMs = http["sinceMs"]?.toLongOrNull(),
            limit = http["limit"]?.toIntOrNull(),
            platform = platform,
            afterActionId = http["afterActionId"],
            cursor = http["factCursor"],
            mobileFactId = http["mobileFactId"],
            runtimeEpoch = http["runtimeEpoch"],
            targetKey = http["targetKey"],
        ).let { it.copy(limit = resolveLimit(it)) }
        val invalidBoundary = query.view != "legacy-live" && (
            query.view !in listOf("decision-window", "connected-history") ||
            listOf("sinceId", "sinceMs").any { key ->
                http[key]?.let { it.toLongOrNull() == null || it.toLong() < 0 } ?: false
            } || (http["limit"]?.let { it.toIntOrNull() == null || it.toInt() <= 0 } ?: false)
        )
        val page = if (invalidBoundary) CapturePage(
            false, stream, emptyList(), 0, CaptureCoverage("unavailable", true, false), true, false, emptyList(),
            reason = "invalid_argument",
        ) else store.query(query)
        val body = envelope(page, query, nowMs)
        if (query.view == "legacy-live") return body
        body.put("coverage", JSONObject().put("status", page.coverage.status)
            .put("gap", page.coverage.gap).put("committed", page.coverage.committed))
            .put("gap", page.gap).put("hasMore", page.hasMore)
            .put("refs", JSONArray(page.refs.map { ref ->
                JSONObject().put("mobileFactId", ref.mobileFactId).put("stream", ref.stream)
                    .put("captureId", ref.captureId).put("targetKey", ref.targetKey ?: JSONObject.NULL)
                    .put("runtimeEpoch", ref.runtimeEpoch ?: JSONObject.NULL)
                    .put("capturedAtMs", ref.capturedAtMs ?: JSONObject.NULL)
            }))
            .put("runtimeEpoch", page.runtimeEpoch ?: JSONObject.NULL)
            .put("targetKey", page.targetKey ?: JSONObject.NULL)
            .put("storeGeneration", page.storeGeneration ?: JSONObject.NULL)
            .put("nextCursor", page.nextCursor ?: JSONObject.NULL)
            .put("watermarkCursor", page.watermarkCursor ?: JSONObject.NULL)
            .put("throughWatermark", page.throughWatermark ?: JSONObject.NULL)
        page.window?.let { body.put("window", it) }
        page.reason?.let { body.put("reason", it) }
        return body
    }
}
