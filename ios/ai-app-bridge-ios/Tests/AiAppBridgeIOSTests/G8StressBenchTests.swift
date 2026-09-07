import Darwin
import XCTest
@testable import AiAppBridgeIOS

final class G8StressBenchTests: XCTestCase {
    func testOneHundredThousandLogsKeepOwnedBytesBounded() {
        let store = MobileCaptureStore()
        var afterTenThousand: Int64 = -1
        var heapAtTenThousand: Int64 = -1
        for index in 0..<100_000 {
            let receipt = autoreleasepool {
                store.append(
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
            XCTAssertTrue(receipt.accepted || receipt.dropped)
            if index == 9_999 {
                afterTenThousand = store.status().ownedBytes
                heapAtTenThousand = residentBytes()
            }
        }
        let status = store.status()
        let logs = status.streams["logs"]!
        let heapAtOneHundredThousand = residentBytes()
        XCTAssertLessThanOrEqual(status.ownedBytes, status.budgetBytes)
        XCTAssertLessThanOrEqual(logs.count, 4096)
        XCTAssertLessThanOrEqual(status.ownedBytes, afterTenThousand + 64 * 1024)
        XCTAssertLessThan(
            heapAtOneHundredThousand,
            heapAtTenThousand * 4 + 32 * 1024 * 1024,
            "heap grew linearly: \(heapAtTenThousand) -> \(heapAtOneHundredThousand)"
        )
        print("G8_HEAP logs ownedBytes=\(status.ownedBytes) budgetBytes=\(status.budgetBytes) rss10k=\(heapAtTenThousand) rss100k=\(heapAtOneHundredThousand)")
        let page = store.query(CaptureQuery(view: "legacy-live", stream: "logs", limit: 200))
        XCTAssertEqual(page.items.count, 200)
        XCTAssertEqual(page.coverage.status, "partial")
    }

    func testOneHundredClearCyclesLeaveEmptyLiveView() {
        let store = MobileCaptureStore()
        for cycle in 0..<100 {
            for index in 0..<50 {
                _ = store.append(
                    CaptureInput(
                        stream: "logs",
                        targetKey: "t",
                        runtimeEpoch: "e",
                        captureId: Int64(cycle * 50 + index),
                        timestampMs: Int64(index),
                        record: ["id": index, "message": "c\(cycle)"]
                    )
                )
            }
            XCTAssertTrue(store.clear().ok)
            XCTAssertEqual(store.status().ownedBytes, 0)
            let page = store.query(CaptureQuery(view: "legacy-live", stream: "logs", limit: 200))
            XCTAssertEqual(page.count, 0)
        }
    }

    func testTenThousandStateKeysKeepOwnedBytesBounded() {
        let store = MobileCaptureStore()
        for index in 0..<10_000 {
            autoreleasepool {
                _ = store.append(
                    CaptureInput(
                        stream: "state",
                        targetKey: "t",
                        runtimeEpoch: "e",
                        captureId: Int64(index),
                        timestampMs: Int64(index),
                        record: [
                            "namespace": "app",
                            "key": "k\(index)",
                            "value": index,
                            "stateKey": "app.k\(index)"
                        ],
                        stateKey: "app.k\(index)"
                    )
                )
            }
        }
        let status = store.status()
        let state = status.streams["state"]!
        XCTAssertLessThanOrEqual(status.ownedBytes, status.budgetBytes)
        XCTAssertLessThanOrEqual(state.count, 512)
        let page = store.query(CaptureQuery(view: "legacy-live", stream: "state", limit: 200))
        XCTAssertLessThanOrEqual(page.count, 200)
    }

    func testTwentyThousandMaxBodyNetworkRecordsStayUnderBudget() {
        let store = MobileCaptureStore()
        let body = String(repeating: "x", count: 20_000)
        var afterTwoThousand: Int64 = -1
        for index in 0..<20_000 {
            autoreleasepool {
                _ = store.append(
                    CaptureInput(
                        stream: "network",
                        targetKey: "t",
                        runtimeEpoch: "e",
                        captureId: Int64(index),
                        timestampMs: Int64(index),
                        record: [
                            "id": index,
                            "method": "POST",
                            "url": "https://example.test/\(index)",
                            "statusCode": 200,
                            "requestBody": body,
                            "responseBody": body
                        ]
                    )
                )
            }
            if index == 1_999 {
                afterTwoThousand = store.status().ownedBytes
            }
        }
        let status = store.status()
        let network = status.streams["network"]!
        XCTAssertLessThanOrEqual(status.ownedBytes, status.budgetBytes)
        XCTAssertLessThanOrEqual(network.count, 2048)
        XCTAssertLessThanOrEqual(status.ownedBytes, afterTwoThousand + 64 * 1024)
        print("G8_HEAP network ownedBytes=\(status.ownedBytes) count=\(network.count)")
    }

    func testOneHundredThousandEventsKeepOwnedBytesAndHeapBounded() {
        let store = MobileCaptureStore()
        var afterTenThousand: Int64 = -1
        var heapAtTenThousand: Int64 = -1
        for index in 0..<100_000 {
            autoreleasepool {
                _ = store.append(
                    CaptureInput(
                        stream: "events",
                        targetKey: "t",
                        runtimeEpoch: "e",
                        captureId: Int64(index),
                        timestampMs: Int64(index),
                        record: ["id": index, "name": "e\(index)"]
                    )
                )
            }
            if index == 9_999 {
                afterTenThousand = store.status().ownedBytes
                heapAtTenThousand = residentBytes()
            }
        }
        let status = store.status()
        let events = status.streams["events"]!
        let heapAtOneHundredThousand = residentBytes()
        XCTAssertLessThanOrEqual(status.ownedBytes, status.budgetBytes)
        XCTAssertLessThanOrEqual(events.count, 4096)
        XCTAssertLessThanOrEqual(status.ownedBytes, afterTenThousand + 64 * 1024)
        XCTAssertLessThan(
            heapAtOneHundredThousand,
            heapAtTenThousand * 4 + 32 * 1024 * 1024,
            "heap grew linearly: \(heapAtTenThousand) -> \(heapAtOneHundredThousand)"
        )
        print("G8_HEAP events ownedBytes=\(status.ownedBytes) budgetBytes=\(status.budgetBytes) rss10k=\(heapAtTenThousand) rss100k=\(heapAtOneHundredThousand)")
    }

    private func residentBytes() -> Int64 {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.stride / MemoryLayout<natural_t>.stride)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return -1 }
        return Int64(info.resident_size)
    }
}
