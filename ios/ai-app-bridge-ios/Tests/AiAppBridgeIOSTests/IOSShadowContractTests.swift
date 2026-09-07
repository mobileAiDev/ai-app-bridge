import XCTest
@testable import AiAppBridgeIOS

final class IOSShadowContractTests: XCTestCase {
    func testFourStreamsAndFiltersMatchContainerOracle() {
        let shadow = ShadowSession()
        shadow.record(stream: "logs", id: 1, timestampMs: 1_000, extra: ["message": "a"])
        shadow.record(stream: "network", id: 2, timestampMs: 1_010, extra: ["url": "https://example.test"])
        shadow.record(stream: "events", id: 3, timestampMs: 1_020, extra: ["name": "opened"])
        shadow.record(
            stream: "state",
            id: 4,
            timestampMs: 1_030,
            extra: ["namespace": "app", "key": "ready", "value": true]
        )
        shadow.record(
            stream: "state",
            id: 5,
            timestampMs: 1_040,
            extra: ["namespace": "app", "key": "ready", "value": false]
        )
        shadow.assertLive("logs")
        shadow.assertLive("network")
        shadow.assertLive("events")
        shadow.assertLive("state")
        shadow.assertLive("logs", sinceId: 1, limit: 200)
        shadow.assertLive("logs", sinceMs: 1_000, limit: 1)
        XCTAssertEqual(shadow.stateValues()["app:ready"] as? Bool, false)
    }

    func testLogOverflowAtContainerCapStillMatchesAtMaxGetLimit() {
        let shadow = ShadowSession()
        for id in 1...320 {
            shadow.record(stream: "logs", id: Int64(id), timestampMs: 1_000 + Int64(id), extra: ["message": "m\(id)"])
        }
        XCTAssertEqual(shadow.logs.count, 300)
        shadow.assertLive("logs", limit: 1_000)
        shadow.assertLive("logs", limit: 200)
        _ = shadow.store.clear()
        shadow.logs.removeAll()
        shadow.assertLive("logs")
    }

    func testUnboundedStateDivergesFromStoreLruAfterTwoHundredOneKeys() {
        let shadow = ShadowSession()
        for id in 1...201 {
            shadow.record(
                stream: "state",
                id: Int64(id),
                timestampMs: 2_000 + Int64(id),
                extra: ["namespace": "app", "key": "k\(id)", "value": id]
            )
        }
        let live = shadow.live("state", limit: 1_000)
        let liveItems = live["items"] as! [[String: Any]]
        XCTAssertEqual(shadow.stateOrder.count, 201)
        XCTAssertNotNil(shadow.state["app:k1"])
        XCTAssertNotNil(shadow.state["app:k201"])
        XCTAssertFalse(CaptureAppend.itemsMatch(shadow.oracleItems("state", limit: 1_000), liveItems))
        let liveValues = live["values"] as! [String: Any]
        XCTAssertNil(liveValues["app:k1"])
        XCTAssertNotNil(liveValues["app:k201"])
    }
}

private final class ShadowSession {
    let store = MobileCaptureStore(caps: CountCaps(logs: 300, network: 200, events: 300, state: 200))
    var logs: [[String: Any]] = []
    var network: [[String: Any]] = []
    var events: [[String: Any]] = []
    var state: [String: [String: Any]] = [:]
    var stateOrder: [String] = []

    func record(stream: String, id: Int64, timestampMs: Int64, extra: [String: Any]) {
        var event = extra
        event["id"] = id
        event["source"] = "http"
        event["timestampMs"] = timestampMs
        switch stream {
        case "logs":
            appendBounded(&logs, event, cap: 300)
        case "network":
            appendBounded(&network, event, cap: 200)
        case "events":
            appendBounded(&events, event, cap: 300)
        case "state":
            let key = "\(event["namespace"] as! String):\(event["key"] as! String)"
            event["stateKey"] = key
            if state[key] == nil {
                stateOrder.append(key)
            }
            state[key] = event
        default:
            preconditionFailure(stream)
        }
        _ = CaptureAppend.appendSanitized(
            store: store,
            event: event,
            stream: stream,
            targetKey: "bundle",
            runtimeEpoch: "epoch-1"
        )
    }

    func assertLive(_ stream: String, sinceId: Int64? = nil, sinceMs: Int64? = nil, limit: Int = 200) {
        let body = live(stream, sinceId: sinceId, sinceMs: sinceMs, limit: limit)
        let items = body["items"] as! [[String: Any]]
        XCTAssertTrue(CaptureAppend.itemsMatch(oracleItems(stream, sinceId: sinceId, sinceMs: sinceMs, limit: limit), items))
        if stream == "state" {
            XCTAssertTrue(
                CaptureAppend.valuesMatch(
                    oracleValues(sinceId: sinceId, sinceMs: sinceMs, limit: limit),
                    body["values"] as! [String: Any]
                )
            )
        }
        XCTAssertFalse(items.contains { $0["mobileFactId"] != nil })
    }

    func live(_ stream: String, sinceId: Int64? = nil, sinceMs: Int64? = nil, limit: Int = 200) -> [String: Any] {
        let query = CaptureQuery(
            view: "legacy-live",
            stream: stream,
            sinceId: sinceId,
            sinceMs: sinceMs,
            limit: limit,
            platform: "ios"
        )
        return LegacyLiveView.envelope(page: store.query(query), query: query, nowMs: 9)
    }

    func stateValues() -> [String: Any] {
        oracleValues()
    }

    func oracleItems(
        _ stream: String,
        sinceId: Int64? = nil,
        sinceMs: Int64? = nil,
        limit: Int
    ) -> [[String: Any]] {
        let filtered = source(stream).filter { matches($0, sinceId: sinceId, sinceMs: sinceMs) }
        return filtered.count > limit ? Array(filtered.suffix(limit)) : filtered
    }

    func oracleValues(sinceId: Int64? = nil, sinceMs: Int64? = nil, limit: Int = 200) -> [String: Any] {
        let filtered = stateOrder.compactMap { key -> (String, [String: Any])? in
            guard let event = state[key], matches(event, sinceId: sinceId, sinceMs: sinceMs) else { return nil }
            return (key, event)
        }
        let limited = filtered.count > limit ? Array(filtered.suffix(limit)) : filtered
        var values: [String: Any] = [:]
        for (key, event) in limited {
            values[key] = event["value"] ?? NSNull()
        }
        return values
    }

    private func source(_ stream: String) -> [[String: Any]] {
        switch stream {
        case "logs": return logs
        case "network": return network
        case "events": return events
        case "state": return stateOrder.compactMap { state[$0] }
        default: return []
        }
    }

    private func matches(_ event: [String: Any], sinceId: Int64?, sinceMs: Int64?) -> Bool {
        let id = (event["id"] as? NSNumber)?.int64Value ?? (event["id"] as? Int64) ?? 0
        let timestampMs = (event["timestampMs"] as? NSNumber)?.int64Value ?? (event["timestampMs"] as? Int64) ?? 0
        if let sinceId, id <= sinceId { return false }
        if let sinceMs, timestampMs < sinceMs { return false }
        return true
    }

    private func appendBounded(_ target: inout [[String: Any]], _ event: [String: Any], cap: Int) {
        target.append(event)
        if target.count > cap {
            target.removeFirst(target.count - cap)
        }
    }
}
