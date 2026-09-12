import Foundation

// All views read the same persistent facts. The live view is a bounded projection;
// decision/history views include durable references and an explicit coverage result.
enum CaptureHttpView {
    static func envelope(page: CapturePage, query: CaptureQuery, nowMs: Int64) -> [String: Any] {
        var body: [String: Any] = [
            "ok": page.ok, "type": page.type, "view": query.view,
            "items": page.items, "count": page.count,
            "sinceId": query.sinceId as Any? ?? NSNull(), "sinceMs": query.sinceMs as Any? ?? NSNull(),
            "limit": query.limit ?? 200, "updatedAtMs": nowMs,
            "coverage": ["status": page.coverage.status, "gap": page.coverage.gap,
                         "committed": page.coverage.committed],
            "gap": page.gap, "hasMore": page.hasMore,
            "refs": page.refs.map { ref -> [String: Any] in [
                "mobileFactId": ref.mobileFactId, "stream": ref.stream, "captureId": ref.captureId,
                "targetKey": ref.targetKey as Any? ?? NSNull(),
                "runtimeEpoch": ref.runtimeEpoch as Any? ?? NSNull(),
                "capturedAtMs": ref.capturedAtMs as Any? ?? NSNull()
            ] },
            "nextCursor": page.nextCursor as Any? ?? NSNull(),
            "watermarkCursor": page.watermarkCursor as Any? ?? NSNull(),
            "runtimeEpoch": page.runtimeEpoch as Any? ?? NSNull(), "targetKey": page.targetKey as Any? ?? NSNull(),
            "storeGeneration": page.storeGeneration as Any? ?? NSNull(),
            "throughWatermark": page.throughWatermark as Any? ?? NSNull(),
            "reason": page.reason as Any? ?? NSNull()
        ]
        if !page.ok { body["error"] = page.reason ?? "capture_unavailable" }
        if let window = page.window { body["window"] = window }
        if page.type == "state" { body["values"] = page.values }
        return body
    }

    static func fromHttp(store: MobileCaptureStore, stream: String,
                         http: [String: String], nowMs: Int64) -> [String: Any] {
        var query = CaptureQuery(view: http["view"] ?? "legacy-live", stream: stream)
        let allowed: Set<String> = ["view", "sinceId", "sinceMs", "limit", "runtimeEpoch", "afterActionId",
                                    "factCursor", "mobileFactId", "targetKey"]
        let invalidKeys = Set(http.keys).subtracting(allowed).sorted()
        if !invalidKeys.isEmpty { return invalid(query, "unknown_parameter: \(invalidKeys.joined(separator: ","))", nowMs) }
        for name in ["sinceId", "sinceMs", "limit"] {
            if let raw = http[name] {
                guard !raw.isEmpty, raw.utf8.allSatisfy({ (48...57).contains($0) }),
                      let value = Int64(raw), value <= 9_007_199_254_740_991,
                      name != "limit" || (1...1000).contains(value) else {
                    return invalid(query, "invalid_parameter: \(name)", nowMs)
                }
                switch name {
                case "sinceId": query.sinceId = value
                case "sinceMs": query.sinceMs = value
                default: query.limit = Int(value)
                }
            }
        }
        for name in ["runtimeEpoch", "afterActionId", "factCursor", "mobileFactId", "targetKey"] {
            if let value = http[name], value.isEmpty || value.utf8.count > 1024 {
                return invalid(query, "invalid_parameter: \(name)", nowMs)
            }
        }
        query.runtimeEpoch = http["runtimeEpoch"]; query.afterActionId = http["afterActionId"]
        query.cursor = http["factCursor"]; query.mobileFactId = http["mobileFactId"]; query.targetKey = http["targetKey"]
        return envelope(page: store.query(query), query: query, nowMs: nowMs)
    }

    private static func invalid(_ query: CaptureQuery, _ detail: String, _ nowMs: Int64) -> [String: Any] {
        var body = envelope(page: .unavailable(query.stream, "invalid_argument"), query: query, nowMs: nowMs)
        body["detail"] = detail
        return body
    }
}
