import XCTest
@testable import AiAppBridgeIOS

final class LegacyLiveViewTests: XCTestCase {
    func testStrongViewsExplicitlyRejectVolatileFactsAndEvictionMarksGap() {
        let store = MobileCaptureStore(caps: CountCaps(logs: 2))
        for id in 1...3 {
            let receipt = store.append(CaptureInput(stream: "logs", targetKey: "ios:app", runtimeEpoch: "e",
                captureId: Int64(id), timestampMs: Int64(id), record: ["id": id]))
            XCTAssertFalse(receipt.committed)
            XCTAssertNil(receipt.mobileFactId)
        }
        let page = store.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertTrue(page.gap)
        XCTAssertFalse(page.coverage.committed)
        XCTAssertTrue(page.refs.isEmpty)
        for view in ["decision-window", "connected-history"] {
            let body = LegacyLiveView.fromHttp(store: store, stream: "logs", http: ["view": view], nowMs: 9)
            XCTAssertEqual(body["ok"] as? Bool, false)
            XCTAssertEqual(body["reason"] as? String, "persistence_unavailable")
            XCTAssertEqual(body["count"] as? Int, 0)
            XCTAssertTrue((body["refs"] as! [Any]).isEmpty)
        }
        let legacy = LegacyLiveView.fromHttp(store: store, stream: "logs", http: [:], nowMs: 9)
        XCTAssertEqual(legacy["ok"] as? Bool, true)
        XCTAssertEqual(legacy["count"] as? Int, 2)
        XCTAssertNil(legacy["coverage"])
    }

    func testEnvelopeMatchesG0GetFieldsAndDoesNotLeakFactIds() {
        let store = MobileCaptureStore()
        _ = store.append(
            CaptureInput(
                stream: "logs",
                targetKey: "ios:device:com.example",
                runtimeEpoch: "epoch-1",
                captureId: 7,
                timestampMs: 1000,
                record: ["id": 7, "message": "hello"]
            )
        )
        let query = CaptureQuery(view: "legacy-live", stream: "logs", limit: 200, platform: "ios")
        let page = store.query(query)
        let body = LegacyLiveView.envelope(page: page, query: query, nowMs: 9)
        XCTAssertEqual(body["ok"] as? Bool, true)
        XCTAssertEqual(body["type"] as? String, "logs")
        XCTAssertEqual(body["count"] as? Int, 1)
        XCTAssertEqual(body["limit"] as? Int, 200)
        XCTAssertEqual(body["updatedAtMs"] as? Int64, 9)
        XCTAssertTrue(body["sinceId"] is NSNull)
        XCTAssertTrue(body["sinceMs"] is NSNull)
        XCTAssertEqual(
            Set(body.keys),
            Set(["ok", "type", "items", "count", "sinceId", "sinceMs", "limit", "updatedAtMs"])
        )
        let item = (body["items"] as? [[String: Any]])?.first
        XCTAssertEqual(item?["id"] as? Int, 7)
        XCTAssertNil(item?["mobileFactId"])
        var over = query
        over.limit = 9_999
        XCTAssertEqual(LegacyLiveView.resolveLimit(over), 1_000)
        over.platform = "android"
        XCTAssertEqual(LegacyLiveView.resolveLimit(over), 500)
    }

    func testFromHttpClampsLimitAndKeepsG0Fields() {
        let store = MobileCaptureStore()
        _ = store.append(
            CaptureInput(
                stream: "logs",
                targetKey: "ios:device:com.example",
                runtimeEpoch: "epoch-1",
                captureId: 3,
                timestampMs: 2000,
                record: ["id": 3, "message": "http"]
            )
        )
        let body = LegacyLiveView.fromHttp(
            store: store,
            stream: "logs",
            http: ["limit": "9999", "sinceId": "0"],
            nowMs: 11
        )
        XCTAssertEqual(body["ok"] as? Bool, true)
        XCTAssertEqual(body["type"] as? String, "logs")
        XCTAssertEqual(body["count"] as? Int, 1)
        XCTAssertEqual(body["limit"] as? Int, 1000)
        XCTAssertEqual(body["sinceId"] as? Int64, 0)
        XCTAssertEqual(body["updatedAtMs"] as? Int64, 11)
        let item = (body["items"] as? [[String: Any]])?.first
        XCTAssertEqual(item?["message"] as? String, "http")
        XCTAssertNil(item?["mobileFactId"])
    }
}
