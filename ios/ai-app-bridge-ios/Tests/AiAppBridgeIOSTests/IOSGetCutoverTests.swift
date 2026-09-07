import XCTest
@testable import AiAppBridgeIOS

final class IOSGetCutoverTests: XCTestCase {
    func testFromHttpKeepsG0FieldsAndHidesFactIds() {
        let store = MobileCaptureStore()
        _ = CaptureAppend.appendSanitized(
            store: store,
            event: [
                "id": Int64(1),
                "type": "log",
                "source": "sdk",
                "timestampMs": Int64(1000),
                "message": "hello"
            ],
            stream: "logs",
            targetKey: "bundle",
            runtimeEpoch: "epoch-1"
        )
        let body = LegacyLiveView.fromHttp(store: store, stream: "logs", http: [:], nowMs: 9)
        XCTAssertEqual(Set(body.keys), Set(["ok", "type", "items", "count", "sinceId", "sinceMs", "limit", "updatedAtMs"]))
        XCTAssertEqual(body["type"] as? String, "logs")
        XCTAssertEqual(body["limit"] as? Int, 200)
        let item = (body["items"] as? [[String: Any]])?.first
        XCTAssertEqual(item?["message"] as? String, "hello")
        XCTAssertNil(item?["mobileFactId"])
    }

    func testStateFromHttpUsesStoreLruOnUpdateWithinTheWindow() {
        let store = MobileCaptureStore()
        for (id, key, value) in [(Int64(1), "a", "1"), (Int64(2), "b", "2"), (Int64(3), "a", "3")] {
            _ = CaptureAppend.appendSanitized(
                store: store,
                event: [
                    "id": id,
                    "type": "state",
                    "source": "sdk",
                    "timestampMs": id,
                    "namespace": "app",
                    "key": key,
                    "value": value
                ],
                stream: "state",
                targetKey: "bundle",
                runtimeEpoch: "epoch-1"
            )
        }
        let body = LegacyLiveView.fromHttp(store: store, stream: "state", http: ["limit": "1"], nowMs: 9)
        let values = body["values"] as? [String: Any]
        XCTAssertEqual(values?["app:a"] as? String, "3")
        XCTAssertEqual(body["count"] as? Int, 1)
    }

    func testFromHttpAcceptsIosSinceAliases() {
        let store = MobileCaptureStore()
        _ = CaptureAppend.appendSanitized(
            store: store,
            event: [
                "id": Int64(4),
                "type": "log",
                "source": "sdk",
                "timestampMs": Int64(4000),
                "message": "later"
            ],
            stream: "logs",
            targetKey: "bundle",
            runtimeEpoch: "epoch-1"
        )
        let body = LegacyLiveView.fromHttp(
            store: store,
            stream: "logs",
            http: ["since-id": "3", "since-ms": "1000"],
            nowMs: 9
        )
        XCTAssertEqual(body["sinceId"] as? Int64, 3)
        XCTAssertEqual(body["sinceMs"] as? Int64, 1000)
        XCTAssertEqual(body["count"] as? Int, 1)
    }

    func testProductionGetRoutesCallFromHttp() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/AiAppBridgeIOS/AiAppBridge.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(source.contains("liveCapture(\"logs\""))
        XCTAssertTrue(source.contains("liveCapture(\"network\""))
        XCTAssertTrue(source.contains("liveCapture(\"state\""))
        XCTAssertTrue(source.contains("liveCapture(\"events\""))
        XCTAssertTrue(source.contains("LegacyLiveView.fromHttp(store: captureStore, stream: stream"))
        XCTAssertFalse(source.contains("buildCaptureResponse"))
        XCTAssertFalse(source.contains("buildStateResponse"))
        XCTAssertFalse(source.contains("source: logEntries"))
    }
}
