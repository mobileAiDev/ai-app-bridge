import XCTest
@testable import AiAppBridgeIOS

final class AiAppBridgeShadowWriteTests: XCTestCase {
    func testBridgeSourceHasNoContainersOrShadowDualWrite() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/AiAppBridgeIOS/AiAppBridge.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(source.contains("let captureStore = MobileCaptureStore("))
        XCTAssertTrue(source.contains("CountCaps(logs: 300, network: 200, events: 300, state: 200)"))
        XCTAssertTrue(source.contains("CaptureAppend.appendSanitized("))
        XCTAssertTrue(source.contains("stream: \"logs\""))
        XCTAssertTrue(source.contains("stream: \"network\""))
        XCTAssertTrue(source.contains("stream: \"state\""))
        XCTAssertTrue(source.contains("stream: \"events\""))
        XCTAssertTrue(source.contains("captureStore.clear()"))
        XCTAssertTrue(source.contains("LegacyLiveView.fromHttp(store: captureStore, stream: stream"))
        XCTAssertTrue(source.contains("liveCapture(\"logs\""))
        XCTAssertTrue(source.contains("liveCapture(\"network\""))
        XCTAssertTrue(source.contains("liveCapture(\"state\""))
        XCTAssertTrue(source.contains("liveCapture(\"events\""))
        XCTAssertFalse(source.contains("logEntries"))
        XCTAssertFalse(source.contains("networkEntries"))
        XCTAssertFalse(source.contains("eventEntries"))
        XCTAssertFalse(source.contains("stateEntries"))
        XCTAssertFalse(source.contains("shadowCapture"))
        XCTAssertFalse(source.contains("IOSShadowCapture"))
        XCTAssertFalse(source.contains("buildCaptureResponse"))
        XCTAssertFalse(source.contains("buildStateResponse"))
        XCTAssertFalse(source.contains("FactStoreReceiptPort"))
        XCTAssertTrue(source.contains("\"ok\": true, \"record\": event"))
        let persistStart = source.range(of: "private func persistCapturedLog(")!
        let persistEnd = source.range(of: "private func persistMobileFact(", range: persistStart.lowerBound..<source.endIndex)!
        XCTAssertFalse(source[persistStart.lowerBound..<persistEnd.lowerBound].contains("CaptureAppend"))
    }
}
