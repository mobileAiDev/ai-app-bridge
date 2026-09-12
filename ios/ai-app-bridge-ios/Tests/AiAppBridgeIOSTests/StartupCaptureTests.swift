import Foundation
import XCTest
@testable import AiAppBridgeIOS

final class StartupCaptureTests: XCTestCase {
    func testImmediateFourStreamCapturesWaitForOpenAndSurviveColdReopen() throws {
        let fixture = StartupFixture()
        defer { fixture.dispose() }
        let release = fixture.holdWriter()
        fixture.lifecycle.start(fixture.configuration)
        fixture.lifecycle.start(fixture.configuration)
        let done = expectation(description: "original startup receipts")
        done.expectedFulfillmentCount = 4
        var references: [String: String] = [:]
        let mutable = NSMutableDictionary(dictionary: ["value": "original"])
        for (id, stream) in SegmentedCaptureBackend.streams.enumerated() {
            var input = record(stream, Int64(id + 1))
            input.record["data"] = mutable
            fixture.capture.append(input) { receipt in
                XCTAssertTrue(receipt.accepted, receipt.reason ?? "")
                XCTAssertFalse(receipt.committed)
                references[stream] = receipt.mobileFactId
                // The callback must not hold the capture facade lock.
                XCTAssertEqual(fixture.capture.status().pendingRecords, 0)
                done.fulfill()
            }
        }
        mutable["value"] = "changed after enqueue"
        XCTAssertTrue(references.isEmpty, "opening cannot manufacture successful receipts")
        XCTAssertEqual(fixture.capture.status().pendingRecords, 4)
        XCTAssertGreaterThan(fixture.capture.status().pendingBytes, 0)
        for stream in SegmentedCaptureBackend.streams {
            let page = fixture.capture.query(CaptureQuery(view: "legacy-live", stream: stream))
            XCTAssertFalse(page.ok)
            XCTAssertFalse(page.coverage.committed)
            XCTAssertTrue(page.items.isEmpty, "pending memory is not a query backend")
        }
        release.signal()
        wait(for: [done], timeout: 5)
        for stream in SegmentedCaptureBackend.streams {
            let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: stream))
            XCTAssertTrue(page.ok, page.reason ?? "")
            XCTAssertTrue(page.coverage.committed)
            XCTAssertFalse(page.gap)
            XCTAssertEqual(page.items.count, 1)
            XCTAssertEqual((page.items.first?["data"] as? [String: Any])?["value"] as? String, "original")
            XCTAssertEqual(page.refs.first?.mobileFactId, references[stream])
        }
        fixture.stop()
        let cold = StartupFixture(directory: fixture.directory, epoch: "epoch-2")
        defer { cold.stop() }
        cold.lifecycle.start(cold.configuration)
        cold.awaitReady()
        for stream in SegmentedCaptureBackend.streams {
            let page = cold.capture.query(CaptureQuery(view: "connected-history", stream: stream,
                mobileFactId: try XCTUnwrap(references[stream])))
            XCTAssertTrue(page.ok, page.reason ?? "")
            XCTAssertTrue(page.coverage.committed)
            XCTAssertEqual(page.refs.first?.runtimeEpoch, "epoch-1")
            XCTAssertEqual(page.refs.first?.mobileFactId, references[stream])
        }
    }

    func testReadyWriteFromFirstReceiptCannotOvertakeRemainingStartupWrites() {
        let fixture = StartupFixture()
        defer { fixture.dispose() }
        let release = fixture.holdWriter()
        fixture.lifecycle.start(fixture.configuration)
        let done = expectation(description: "ordered submissions")
        done.expectedFulfillmentCount = 3
        let third = record("logs", 3)
        fixture.capture.append(record("logs", 1)) { receipt in
            XCTAssertTrue(receipt.accepted); done.fulfill()
            fixture.capture.append(third) { receipt in XCTAssertTrue(receipt.accepted); done.fulfill() }
        }
        fixture.capture.append(record("logs", 2)) { receipt in XCTAssertTrue(receipt.accepted); done.fulfill() }
        release.signal()
        wait(for: [done], timeout: 5)
        let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertTrue(page.ok); XCTAssertTrue(page.coverage.committed); XCTAssertFalse(page.gap)
        XCTAssertEqual(page.items.compactMap { ($0["id"] as? NSNumber)?.int64Value }, [1, 2, 3])
    }

    func testStartupCountAndByteLimitsRejectOverflowAndPreserveLoss() {
        let fixture = StartupFixture()
        defer { fixture.dispose() }
        let release = fixture.holdWriter()
        fixture.lifecycle.start(fixture.configuration)
        let done = expectation(description: "bounded startup records")
        done.expectedFulfillmentCount = 256
        for id in 1...256 {
            fixture.capture.append(record("logs", Int64(id))) { receipt in
                XCTAssertTrue(receipt.accepted, receipt.reason ?? ""); done.fulfill()
            }
        }
        fixture.capture.append(record("logs", 257)) { receipt in
            XCTAssertEqual(receipt.reason, "capture_startup_queue_full")
            XCTAssertFalse(receipt.accepted); XCTAssertNil(receipt.mobileFactId)
        }
        XCTAssertEqual(fixture.capture.status().pendingRecords, 256)
        release.signal()
        wait(for: [done], timeout: 5)
        let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", limit: 300))
        XCTAssertTrue(page.ok); XCTAssertTrue(page.gap)
        XCTAssertEqual(page.items.count, 256)

        let bytes = MobileCaptureStore()
        bytes.beginOpening()
        var large = record("events", 1)
        large.record["data"] = String(repeating: "x", count: 600_000)
        var cancelled = 0
        bytes.append(large) { receipt in
            XCTAssertEqual(receipt.reason, "capture_store_unavailable"); cancelled += 1
        }
        bytes.append(large) { receipt in XCTAssertEqual(receipt.reason, "capture_startup_queue_full") }
        XCTAssertEqual(bytes.status().pendingRecords, 1)
        XCTAssertLessThanOrEqual(bytes.status().pendingBytes, 1_048_576)
        bytes.detachPersistentStore()
        XCTAssertEqual(cancelled, 1)
        XCTAssertEqual(bytes.status().pendingBytes, 0)
    }

    func testStopCancelsPendingOnceAndLateOpenCannotReplayIt() {
        let fixture = StartupFixture()
        defer { fixture.dispose() }
        let release = fixture.holdWriter()
        fixture.lifecycle.start(fixture.configuration)
        var replies = 0
        fixture.capture.append(record("logs", 1)) { receipt in
            replies += 1; XCTAssertFalse(receipt.accepted)
            XCTAssertEqual(receipt.reason, "capture_store_unavailable")
        }
        fixture.lifecycle.stop()
        XCTAssertEqual(replies, 1)
        XCTAssertEqual(fixture.capture.status().pendingRecords, 0)
        release.signal()
        fixture.writer.sync {}
        fixture.lifecycle.start(fixture.configuration)
        fixture.awaitReady()
        let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertEqual(replies, 1)
        XCTAssertTrue(page.ok); XCTAssertTrue(page.gap); XCTAssertTrue(page.items.isEmpty)
    }

    func testFailedAndDisabledOpenFinishPendingWithoutSuccess() throws {
        for disabled in [false, true] {
            let fixture = StartupFixture()
            defer { fixture.dispose() }
            var configuration = fixture.configuration
            if disabled {
                var options = configuration.options
                options.enabled = false
                configuration = .init(profile: "disabled", budgetBytes: 0, disabledReason: "test", options: options)
            } else {
                try Data("a file cannot be opened as the store directory".utf8).write(to: fixture.directory)
            }
            let release = fixture.holdWriter()
            fixture.lifecycle.start(configuration)
            let done = expectation(description: "open failure")
            fixture.capture.append(record("logs", 1)) { receipt in
                XCTAssertFalse(receipt.accepted); XCTAssertNil(receipt.mobileFactId)
                XCTAssertEqual(receipt.reason, disabled ? "capture_store_disabled" : "capture_store_open_failed")
                done.fulfill()
            }
            release.signal()
            wait(for: [done], timeout: 5)
            XCTAssertEqual(fixture.capture.status().pendingRecords, 0)
            XCTAssertFalse(fixture.capture.status().persistent)
        }
    }

    private func record(_ stream: String, _ id: Int64) -> CaptureInput {
        let value: [String: Any] = ["id": id, "timestampMs": id * 100, "source": "sdk", "value": id]
        return CaptureInput(stream: stream, targetKey: "bundle", runtimeEpoch: "epoch-1", captureId: id,
            timestampMs: id * 100, record: value, stateKey: stream == "state" ? "app:ready" : nil)
    }
}

private final class StartupFixture {
    let directory: URL
    let epoch: String
    let writer = DispatchQueue(label: "startup-real-fact-writer")
    let capture = MobileCaptureStore()
    lazy var store = SegmentedFactStore(nativeFactory: { CSegmentedFactStoreNative() }, writer: writer, maxQueuedRecords: 256)
    lazy var lifecycle = ObservationFactStoreLifecycle(store: store,
        onOpening: { [self] in capture.beginOpening() },
        onOpened: { [self] configuration in
            capture.attachPersistentStore(store, directory: configuration.options.directory,
                targetKey: "bundle", runtimeEpoch: epoch)
        },
        onOpenFailed: { [self] reason in capture.detachPersistentStore(reason: reason) },
        onStopped: { [self] in capture.detachPersistentStore() })
    var configuration: MobileFactStoreConfiguration {
        .init(profile: "test", budgetBytes: 8 * 1024 * 1024, disabledReason: nil,
            options: .init(directory: directory, segmentSizeBytes: 256 * 1024,
                partitionQuotas: Array(repeating: 1024 * 1024, count: 8), receiveObservationFacts: false))
    }
    init(directory: URL? = nil, epoch: String = "epoch-1") {
        self.directory = directory ?? FileManager.default.temporaryDirectory.appendingPathComponent("startup-capture-\(UUID().uuidString)")
        self.epoch = epoch
    }
    func holdWriter() -> DispatchSemaphore {
        let held = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        writer.async { held.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        XCTAssertEqual(held.wait(timeout: .now() + 1), .success)
        return release
    }
    func awaitReady() {
        // Open schedules attachment on the same writer; the second barrier
        // observes that attachment rather than guessing a wall-clock delay.
        writer.sync {}; writer.sync {}
        XCTAssertTrue(capture.status().persistent, capture.status().reason ?? "")
    }
    func stop() { lifecycle.stop(); writer.sync {} }
    func dispose() { stop(); try? FileManager.default.removeItem(at: directory) }
}
