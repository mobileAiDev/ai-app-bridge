import XCTest
@testable import AiAppBridgeIOS

final class G8HotQueryBenchTests: XCTestCase {
    func testTwoHundredLogHotQueryP95IsAtMostTenMs() {
        let store = MobileCaptureStore()
        for index in 0..<200 {
            _ = store.append(
                CaptureInput(
                    stream: "logs",
                    targetKey: "t",
                    runtimeEpoch: "e",
                    captureId: Int64(index),
                    timestampMs: Int64(index),
                    record: ["id": index, "message": "m\(index)"]
                )
            )
        }
        let query = CaptureQuery(view: "legacy-live", stream: "logs", limit: 200)
        _ = store.query(query)
        var samples = Array(repeating: UInt64(0), count: 40)
        for index in 0..<40 {
            let started = DispatchTime.now().uptimeNanoseconds
            let page = store.query(query)
            samples[index] = DispatchTime.now().uptimeNanoseconds - started
            XCTAssertEqual(page.items.count, 200)
            XCTAssertEqual(page.coverage.status, "unavailable")
        }
        samples.sort()
        let p50 = samples[((samples.count * 50 + 99) / 100) - 1]
        let p95 = samples[((samples.count * 95 + 99) / 100) - 1]
        let p99 = samples[((samples.count * 99 + 99) / 100) - 1]
        print("G8_hotQuery p50=\(Double(p50) / 1_000_000.0) p95=\(Double(p95) / 1_000_000.0) p99=\(Double(p99) / 1_000_000.0)")
        XCTAssertLessThanOrEqual(p95, 10_000_000, "hot query p95 \(Double(p95) / 1_000_000.0)ms")
    }

    func testTwoHundredLogColdQueryP95IsAtMostOneHundredMs() {
        var samples = Array(repeating: UInt64(0), count: 20)
        for run in 0..<20 {
            let store = MobileCaptureStore()
            for index in 0..<200 {
                _ = store.append(
                    CaptureInput(
                        stream: "logs",
                        targetKey: "t",
                        runtimeEpoch: "e",
                        captureId: Int64(index),
                        timestampMs: Int64(index),
                        record: ["id": index, "message": "m\(index)"]
                    )
                )
            }
            let query = CaptureQuery(view: "legacy-live", stream: "logs", limit: 200)
            let started = DispatchTime.now().uptimeNanoseconds
            let page = store.query(query)
            samples[run] = DispatchTime.now().uptimeNanoseconds - started
            XCTAssertEqual(page.items.count, 200)
        }
        samples.sort()
        let p50 = samples[((samples.count * 50 + 99) / 100) - 1]
        let p95 = samples[((samples.count * 95 + 99) / 100) - 1]
        let p99 = samples[((samples.count * 99 + 99) / 100) - 1]
        print("G8_coldQuery p50=\(Double(p50) / 1_000_000.0) p95=\(Double(p95) / 1_000_000.0) p99=\(Double(p99) / 1_000_000.0)")
        XCTAssertLessThanOrEqual(p95, 100_000_000, "cold query p95 \(Double(p95) / 1_000_000.0)ms")
    }

    func testAppendThreadOverheadP95IsAtMostOneMs() {
        let store = MobileCaptureStore()
        for index in 0..<20 {
            _ = store.append(
                CaptureInput(
                    stream: "logs",
                    targetKey: "t",
                    runtimeEpoch: "e",
                    captureId: Int64(index),
                    timestampMs: Int64(index),
                    record: ["id": index, "message": "warm\(index)"]
                )
            )
        }
        var samples = Array(repeating: UInt64(0), count: 40)
        for index in 0..<40 {
            let started = DispatchTime.now().uptimeNanoseconds
            _ = store.append(
                CaptureInput(
                    stream: "logs",
                    targetKey: "t",
                    runtimeEpoch: "e",
                    captureId: Int64(100 + index),
                    timestampMs: Int64(100 + index),
                    record: ["id": 100 + index, "message": "m\(index)"]
                )
            )
            samples[index] = DispatchTime.now().uptimeNanoseconds - started
        }
        samples.sort()
        let p50 = samples[((samples.count * 50 + 99) / 100) - 1]
        let p95 = samples[((samples.count * 95 + 99) / 100) - 1]
        let p99 = samples[((samples.count * 99 + 99) / 100) - 1]
        print("G8_append p50=\(Double(p50) / 1_000_000.0) p95=\(Double(p95) / 1_000_000.0) p99=\(Double(p99) / 1_000_000.0)")
        XCTAssertLessThanOrEqual(p95, 1_000_000, "append p95 \(Double(p95) / 1_000_000.0)ms")
        XCTAssertLessThanOrEqual(p99, 3_000_000, "append p99 \(Double(p99) / 1_000_000.0)ms")
    }

#if canImport(UIKit)
    func testPublicRecordStarThreadOverheadP95IsAtMostOneMs() {
        let bridge = AiAppBridge.shared
        _ = bridge.captureStore.clear()
        bench("recordLog") { index in
            bridge.recordLog(tag: "g8", message: "m\(index)")
        }
        bench("recordNetwork") { index in
            bridge.recordNetwork(method: "GET", url: "https://example.test/\(index)", statusCode: 200, durationMs: 1)
        }
        bench("recordState") { index in
            bridge.recordState(key: "k\(index)", value: ["n": index])
        }
        bench("recordEvent") { index in
            bridge.recordEvent(name: "e\(index)")
        }
        _ = bridge.captureStore.clear()
    }
#endif

    private func bench(_ name: String, record: (Int) -> Void) {
        for index in 0..<20 { record(index) }
        var samples = Array(repeating: UInt64(0), count: 40)
        for index in 0..<40 {
            let started = DispatchTime.now().uptimeNanoseconds
            record(100 + index)
            samples[index] = DispatchTime.now().uptimeNanoseconds - started
        }
        samples.sort()
        let p50 = samples[((samples.count * 50 + 99) / 100) - 1]
        let p95 = samples[((samples.count * 95 + 99) / 100) - 1]
        let p99 = samples[((samples.count * 99 + 99) / 100) - 1]
        print("G8_\(name) p50=\(Double(p50) / 1_000_000.0) p95=\(Double(p95) / 1_000_000.0) p99=\(Double(p99) / 1_000_000.0)")
        XCTAssertLessThanOrEqual(p95, 1_000_000, "\(name) p95 \(Double(p95) / 1_000_000.0)ms")
        XCTAssertLessThanOrEqual(p99, 3_000_000, "\(name) p99 \(Double(p99) / 1_000_000.0)ms")
    }
}
