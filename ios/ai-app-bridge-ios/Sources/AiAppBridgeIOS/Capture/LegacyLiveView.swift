import Foundation

enum LegacyLiveView {
    static func envelope(page: CapturePage, query: CaptureQuery, nowMs: Int64) -> [String: Any] {
        var body: [String: Any] = [
            "ok": page.ok,
            "type": page.type,
            "items": page.items,
            "count": page.count,
            "sinceId": query.sinceId ?? NSNull(),
            "sinceMs": query.sinceMs ?? NSNull(),
            "limit": resolveLimit(query),
            "updatedAtMs": nowMs
        ]
        if page.type == "state" {
            body["values"] = page.values
        }
        return body
    }

    static func resolveLimit(_ query: CaptureQuery) -> Int {
        let max = query.platform == "ios" ? 1_000 : 500
        let raw = query.limit ?? 200
        return Swift.min(Swift.max(raw, 1), max)
    }

    static func fromHttp(
        store: MobileCaptureStore,
        stream: String,
        http: [String: String],
        nowMs: Int64,
        platform: String = "ios"
    ) -> [String: Any] {
        if let view = http["view"], view != "legacy-live" {
            // Strong evidence has no production persistent backend on iOS yet. Do not reinterpret
            // the Legacy memory snapshot as a durable decision/history page.
            return [
                "ok": false, "type": stream, "items": [], "count": 0,
                "coverage": ["status": "unavailable", "gap": true, "committed": false],
                "gap": true, "hasMore": false, "refs": [],
                "reason": "persistence_unavailable"
            ]
        }
        let sinceId = http["sinceId"] ?? (platform == "ios" ? http["since-id"] : nil)
        let sinceMs = http["sinceMs"] ?? (platform == "ios" ? http["since-ms"] : nil)
        var query = CaptureQuery(
            view: "legacy-live",
            stream: stream,
            sinceId: sinceId.flatMap { Int64($0) },
            sinceMs: sinceMs.flatMap { Int64($0) },
            limit: http["limit"].flatMap { Int($0) },
            platform: platform
        )
        query.limit = resolveLimit(query)
        return envelope(page: store.query(query), query: query, nowMs: nowMs)
    }
}
