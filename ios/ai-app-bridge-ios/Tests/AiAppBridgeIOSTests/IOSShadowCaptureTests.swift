import XCTest
@testable import AiAppBridgeIOS

final class CaptureAppendTests: XCTestCase {
    func testSanitizedEventsMatchLegacyLiveItemsAndValues() {
        let store = MobileCaptureStore()
        let log: [String: Any] = [
            "id": Int64(1),
            "type": "log",
            "source": "http",
            "timestampMs": Int64(1000),
            "message": "hello"
        ]
        let state: [String: Any] = [
            "id": Int64(2),
            "type": "state",
            "source": "sdk",
            "timestampMs": Int64(1001),
            "namespace": "app",
            "key": "ready",
            "value": true
        ]
        _ = CaptureAppend.appendSanitized(
            store: store,
            event: log,
            stream: "logs",
            targetKey: "bundle",
            runtimeEpoch: "epoch-1"
        )
        _ = CaptureAppend.appendSanitized(
            store: store,
            event: state,
            stream: "state",
            targetKey: "bundle",
            runtimeEpoch: "epoch-1"
        )
        let logsQuery = CaptureQuery(view: "legacy-live", stream: "logs", platform: "ios")
        let stateQuery = CaptureQuery(view: "legacy-live", stream: "state", platform: "ios")
        let logs = LegacyLiveView.envelope(page: store.query(logsQuery), query: logsQuery, nowMs: 9)
        let states = LegacyLiveView.envelope(page: store.query(stateQuery), query: stateQuery, nowMs: 9)
        let liveLogs = logs["items"] as! [[String: Any]]
        let liveStates = states["items"] as! [[String: Any]]
        let liveValues = states["values"] as! [String: Any]
        XCTAssertTrue(CaptureAppend.itemsMatch([log], liveLogs))
        XCTAssertTrue(CaptureAppend.itemsMatch([state], liveStates))
        XCTAssertTrue(CaptureAppend.valuesMatch(["app:ready": true], liveValues))
        XCTAssertNil(liveLogs[0]["mobileFactId"])
        XCTAssertEqual(Array(liveValues.keys), ["app:ready"])
    }
}
