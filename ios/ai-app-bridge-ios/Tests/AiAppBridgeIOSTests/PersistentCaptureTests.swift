import Foundation
import XCTest
@testable import AiAppBridgeIOS

// These exercise the production C store and the same attachment/HTTP adapter as
// AiAppBridge. Each cold reopen creates a new Swift store and capture backend.
final class PersistentCaptureTests: XCTestCase {
    func testUnavailableNeverBecomesVolatileSuccess() {
        let store = MobileCaptureStore()
        let receipt = awaitCapture { store.append(input("logs", 1), completion: $0) }
        XCTAssertFalse(receipt.accepted)
        XCTAssertFalse(receipt.committed)
        XCTAssertNil(receipt.mobileFactId)
        XCTAssertEqual(receipt.reason, "capture_store_unavailable")
        for view in ["legacy-live", "decision-window", "connected-history"] {
            let result = CaptureHttpView.fromHttp(store: store, stream: "logs", http: ["view": view], nowMs: 1)
            XCTAssertEqual(result["ok"] as? Bool, false)
            XCTAssertTrue((result["items"] as! [Any]).isEmpty)
            XCTAssertEqual((result["coverage"] as? [String: Any])?["committed"] as? Bool, false)
        }
        XCTAssertFalse(store.clear().ok)
        XCTAssertEqual(store.status().ownedBytes, 0)
    }

    func testFourStreamsWriteOnceAndExactReferencesSurviveColdReopen() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        var expected: [String: (CaptureInput, String)] = [:]
        for (index, stream) in SegmentedCaptureBackend.streams.enumerated() {
            let event = input(stream, Int64(index + 1), action: "action-1")
            let receipt = awaitCapture { CaptureAppend.appendSanitized(store: fixture.capture, event: event.record,
                stream: stream, targetKey: "bundle", runtimeEpoch: "epoch-1", completion: $0) }
            XCTAssertTrue(receipt.accepted)
            XCTAssertFalse(receipt.committed)
            expected[stream] = (event, try XCTUnwrap(receipt.mobileFactId))
            let response = CaptureAppend.response(receipt: receipt, event: event.record)
            XCTAssertEqual(response["ok"] as? Bool, true)
        }
        XCTAssertEqual(fixture.status().recordCount, 4, "exactly one disk record per public capture")
        try fixture.reopen(epoch: "epoch-2")
        for stream in SegmentedCaptureBackend.streams {
            let (event, id) = expected[stream]!
            let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: stream, mobileFactId: id))
            XCTAssertTrue(page.ok, page.reason ?? "")
            XCTAssertTrue(page.coverage.committed)
            XCTAssertFalse(page.gap)
            XCTAssertEqual(page.refs.map(\.mobileFactId), [id])
            XCTAssertEqual(page.refs.first?.runtimeEpoch, "epoch-1")
            XCTAssertEqual(try json(page.items), try json([event.record]))
            XCTAssertTrue(fixture.capture.query(CaptureQuery(view: "legacy-live", stream: stream)).items.isEmpty)
        }
    }

    func testPageCursorFreezesUpperBoundAndWatermarkOpensNextDecisionWindow() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        for id in 1...5 { XCTAssertTrue(fixture.append(input("events", Int64(id), action: "a")).accepted) }
        let first = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "events", limit: 2))
        XCTAssertEqual(ids(first), [1, 2]); XCTAssertTrue(first.hasMore)
        let cursor = try XCTUnwrap(first.nextCursor)
        let watermark = try XCTUnwrap(first.watermarkCursor)
        XCTAssertTrue(fixture.append(input("events", 6, action: "b")).accepted)
        let second = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "events", limit: 2, cursor: cursor))
        XCTAssertTrue(second.ok, second.reason ?? "")
        XCTAssertEqual(ids(second), [3, 4])
        let third = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "events", limit: 2, cursor: try XCTUnwrap(second.nextCursor)))
        XCTAssertEqual(ids(third), [5]); XCTAssertFalse(third.hasMore)
        let nextWindow = fixture.capture.query(CaptureQuery(view: "decision-window", stream: "events", afterActionId: "b", cursor: watermark))
        XCTAssertEqual(ids(nextWindow), [6]); XCTAssertEqual(nextWindow.coverage.status, "complete")
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "decision-window", stream: "events", afterActionId: "b")).reason, "decision_watermark_required")
    }

    func testEmptyFilteredHistoryMakesBoundedCursorProgress() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        for id in 1...1100 {
            XCTAssertTrue(fixture.append(input("events", Int64(id), action: "unrelated")).accepted)
            if id % 64 == 0 { _ = fixture.status() }
        }
        XCTAssertTrue(fixture.append(input("events", 1101, action: "wanted")).accepted)
        let first = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "events", afterActionId: "wanted"))
        XCTAssertTrue(first.ok, first.reason ?? ""); XCTAssertTrue(first.items.isEmpty); XCTAssertTrue(first.hasMore)
        let second = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "events", afterActionId: "wanted", cursor: try XCTUnwrap(first.nextCursor)))
        XCTAssertEqual(ids(second), [1101]); XCTAssertFalse(second.hasMore)
    }

    func testExactHistoryReferenceSkipsUnrelatedStoragePartitions() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        let unrelated = try json(["schema": "aiappbridge.fact.v1", "payload": ["kind": "ui"]])
        for id in 1...2000 {
            XCTAssertEqual(fixture.store.record(unrelated, partitionId: 1), .accepted)
            if id % 64 == 0 { _ = fixture.status() }
        }
        let event = input("logs", 1)
        let receipt = fixture.append(event)
        let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs",
            limit: 1, mobileFactId: try XCTUnwrap(receipt.mobileFactId)))
        XCTAssertEqual(fixture.status().recordCount, 2001)
        XCTAssertTrue(page.ok, page.reason ?? "")
        XCTAssertTrue(page.coverage.committed)
        XCTAssertFalse(page.gap); XCTAssertFalse(page.hasMore)
        XCTAssertEqual(try json(page.items), try json([event.record]))
        XCTAssertEqual(page.refs.map(\.mobileFactId), [receipt.mobileFactId!])
    }

    func testClearInvalidatesCursorsAndPersistsWithoutClearingOtherStreams() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        let old = fixture.append(input("logs", 1))
        XCTAssertTrue(fixture.append(input("network", 2)).accepted)
        let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertTrue(fixture.capture.clear("logs").ok)
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", cursor: page.watermarkCursor)).reason, "invalid_capture_cursor")
        try fixture.reopen(epoch: "epoch-2")
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", mobileFactId: old.mobileFactId)).reason, "mobile_fact_unavailable")
        XCTAssertEqual(ids(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "network"))), [2])
    }

    func testStateProjectionHasLatestValueWhileHistoryRetainsEveryChange() throws {
        let fixture = try CaptureDiskFixture(caps: CountCaps(logs: 2, network: 2, events: 2, state: 2))
        defer { fixture.dispose() }
        for id in 1...4 {
            var event = input("state", Int64(id))
            event.stateKey = id == 3 ? "app:second" : "app:ready"
            event.record["key"] = id == 3 ? "second" : "ready"
            XCTAssertTrue(fixture.append(event).accepted)
        }
        let live = fixture.capture.query(CaptureQuery(view: "legacy-live", stream: "state"))
        XCTAssertEqual(ids(live), [3, 4])
        XCTAssertEqual(live.values["app:ready"] as? Int, 4)
        XCTAssertEqual(ids(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "state"))), [1, 2, 3, 4])
        for id in 5...7 { XCTAssertTrue(fixture.append(input("logs", Int64(id))).accepted) }
        let logs = fixture.capture.query(CaptureQuery(view: "legacy-live", stream: "logs"))
        XCTAssertEqual(ids(logs), [6, 7]); XCTAssertEqual(logs.reason, "capture_projection_limit")
        XCTAssertEqual(ids(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))), [5, 6, 7])
    }

    func testClockRollbackAndColdSameEpochQueriesDoNotSkipMatchingRecords() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        for id in 1...260 {
            var event = input("logs", Int64(id))
            event.timestampMs = id == 130 ? 100_000 : 1
            event.record["timestampMs"] = event.timestampMs
            XCTAssertTrue(fixture.append(event).accepted)
            if id % 64 == 0 { _ = fixture.status() }
        }
        let query = CaptureQuery(view: "decision-window", stream: "logs", sinceMs: 99_999)
        let warm = fixture.capture.query(query)
        XCTAssertTrue(warm.ok, warm.reason ?? "")
        XCTAssertEqual(ids(warm), [130])
        try fixture.reopen(epoch: "epoch-1")
        let cold = fixture.capture.query(query)
        XCTAssertTrue(cold.ok, cold.reason ?? "")
        XCTAssertEqual(ids(cold), [130])
    }

    func testRetentionReportsGapAndExactRetainedReferenceStillResolves() throws {
        let fixture = try CaptureDiskFixture(segmentBytes: 4096, quotaBytes: 8192)
        defer { fixture.dispose() }
        var last: String?
        for id in 1...70 {
            var event = input("logs", Int64(id))
            event.record["message"] = String(repeating: "x", count: 1200)
            last = fixture.append(event).mobileFactId
            _ = fixture.status()
        }
        let history = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertTrue(history.ok, history.reason ?? ""); XCTAssertTrue(history.gap)
        XCTAssertLessThan(history.count, 70)
        let exact = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", mobileFactId: try XCTUnwrap(last)))
        XCTAssertEqual(ids(exact), [70]); XCTAssertFalse(exact.gap)
    }

    func testQueueRejectionHasPersistentGapAndPostLossWatermarkCanAdvance() throws {
        let fixture = try CaptureDiskFixture(maxQueued: 1)
        defer { fixture.dispose() }
        let held = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        fixture.writer.async { held.signal(); _ = release.wait(timeout: .now() + 5) }
        XCTAssertEqual(held.wait(timeout: .now() + 1), .success)
        let first = fixture.append(input("logs", 1))
        let overflow = fixture.append(input("logs", 2))
        release.signal()
        XCTAssertTrue(first.accepted); XCTAssertFalse(overflow.accepted)
        XCTAssertEqual(overflow.reason, "capture_queue_full")
        let gap = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertEqual(ids(gap), [1]); XCTAssertTrue(gap.gap)
        try fixture.reopen(epoch: "epoch-2")
        let cold = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertTrue(cold.gap)
        var event = input("logs", 1); event.runtimeEpoch = "epoch-2"
        XCTAssertTrue(fixture.append(event).accepted)
        let recovered = fixture.capture.query(CaptureQuery(view: "decision-window", stream: "logs", cursor: cold.watermarkCursor))
        XCTAssertEqual(ids(recovered), [1]); XCTAssertFalse(recovered.gap)
    }

    func testMetadataCorruptionAndAttachmentCancellationFailClosed() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        XCTAssertTrue(fixture.append(input("logs", 1)).accepted)
        fixture.close()
        try Data("not-json".utf8).write(to: fixture.directory.appendingPathComponent("capture-store-v2.json"))
        try fixture.open(epoch: "epoch-2", requireAttached: false)
        XCTAssertFalse(fixture.capture.status().persistent)
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs")).reason, "capture_metadata_unavailable")
        let replacement = MobileCaptureStore()
        let held = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        fixture.writer.async { held.signal(); _ = release.wait(timeout: .now() + 5) }
        XCTAssertEqual(held.wait(timeout: .now() + 1), .success)
        replacement.attachPersistentStore(fixture.store, directory: fixture.directory, targetKey: "bundle", runtimeEpoch: "epoch-2")
        replacement.detachPersistentStore()
        release.signal(); _ = fixture.status()
        XCTAssertEqual(replacement.query(CaptureQuery(view: "connected-history", stream: "logs")).reason, "capture_store_unavailable")
    }

    func testStrictHttpParametersAndTargetEpochIdentity() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        for http in [["limit": "0"], ["limit": "1001"], ["limit": "abc"], ["sinceId": "-1"],
                     ["sinceMs": "1.2"], ["since-id": "1"], ["sinceMs": "9007199254740992"], ["afterActionId": ""]] {
            let result = CaptureHttpView.fromHttp(store: fixture.capture, stream: "logs", http: http, nowMs: 1)
            XCTAssertEqual(result["ok"] as? Bool, false, "\(http)")
            XCTAssertEqual(result["reason"] as? String, "invalid_argument")
        }
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "decision-window", stream: "logs", runtimeEpoch: "wrong")).reason, "runtime_epoch_changed")
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", targetKey: "wrong")).reason, "target_mismatch")
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", sinceId: 1)).reason, "runtime_epoch_required")
        var invalid = input("logs", 1).record; invalid["id"] = true
        let receipt = awaitCapture { CaptureAppend.appendSanitized(store: fixture.capture, event: invalid, stream: "logs", targetKey: "bundle", runtimeEpoch: "epoch-1", completion: $0) }
        XCTAssertFalse(receipt.accepted)
        XCTAssertEqual(receipt.reason, "invalid_capture_identity")
        XCTAssertEqual(fixture.status().recordCount, 0)
    }

    func testPayloadIdentityCorruptionIsDetectedFromDisk() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        let receipt = fixture.append(input("logs", 1))
        XCTAssertNotNil(receipt.mobileFactId)
        _ = fixture.status()
        let read = fixture.read(partition: 2)
        var payload = try JSONSerialization.jsonObject(with: try XCTUnwrap(read.record).payload) as! [String: Any]
        var capture = payload["capture"] as! [String: Any]
        capture["mobileFactId"] = "mf2:wrong"
        payload["capture"] = capture
        XCTAssertEqual(fixture.store.record(try JSONSerialization.data(withJSONObject: payload), partitionId: 2), .accepted)
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs")).reason, "capture_record_corrupt")
    }

    func testLargePublicNetworkRecordUsesLogicalStoreReadAfterReopen() throws {
        let fixture = try CaptureDiskFixture(segmentBytes: 16 * 1024, quotaBytes: 1024 * 1024)
        defer { fixture.dispose() }
        var event = input("network", 1)
        event.record["responseBody"] = String(repeating: "z", count: 80_000)
        let receipt = fixture.append(event)
        XCTAssertTrue(receipt.accepted, receipt.reason ?? "")
        try fixture.reopen(epoch: "epoch-2")
        let exact = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "network", mobileFactId: receipt.mobileFactId))
        XCTAssertTrue(exact.ok, exact.reason ?? "")
        XCTAssertEqual(try json(exact.items), try json([event.record]))
    }

    func testOriginalWriterFailureCannotAcquireALaterSuccessfulReceipt() throws {
        let native = CaptureFaultNative()
        let fixture = try CaptureDiskFixture(nativeFactory: { native })
        defer { fixture.dispose() }
        XCTAssertTrue(fixture.append(input("logs", 1)).accepted)
        _ = fixture.status()
        fixture.writer.async { native.failAppend = true }
        _ = fixture.status()
        let failed = fixture.append(input("logs", 2))
        XCTAssertTrue(failed.accepted); XCTAssertFalse(failed.committed)
        _ = fixture.status()
        let succeeded = fixture.append(input("logs", 3))
        let history = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertEqual(ids(history), [1, 3]); XCTAssertTrue(history.gap)
        XCTAssertEqual(fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", mobileFactId: failed.mobileFactId)).reason, "mobile_fact_unavailable")
        let exact = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs", mobileFactId: succeeded.mobileFactId))
        XCTAssertEqual(ids(exact), [3]); XCTAssertTrue(exact.coverage.committed)
    }

    func testFlushFailureNeverReturnsCommittedCoverage() throws {
        let native = CaptureFaultNative()
        let fixture = try CaptureDiskFixture(nativeFactory: { native })
        defer { fixture.dispose() }
        XCTAssertTrue(fixture.append(input("logs", 1)).accepted)
        _ = fixture.status()
        fixture.writer.async { native.failFlush = true }
        _ = fixture.status()
        let page = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertFalse(page.ok); XCTAssertFalse(page.coverage.committed)
        XCTAssertEqual(page.reason, "capture_flush_failed")
    }

    func testCommittedWatermarkExcludesAnAppendQueuedDuringFlush() throws {
        let native = CaptureFaultNative()
        let fixture = try CaptureDiskFixture(nativeFactory: { native })
        defer { fixture.dispose() }
        XCTAssertTrue(fixture.append(input("logs", 1)).accepted)
        _ = fixture.status()
        let second = input("logs", 2)
        fixture.writer.async {
            native.onFlush = { XCTAssertTrue(fixture.append(second).accepted) }
        }
        _ = fixture.status()
        let firstCheckpoint = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertEqual(ids(firstCheckpoint), [1], "a later unflushed append cannot enter an already committed watermark")
        let secondCheckpoint = fixture.capture.query(CaptureQuery(view: "connected-history", stream: "logs"))
        XCTAssertEqual(ids(secondCheckpoint), [1, 2])
    }

    func testUnknownPreAttachmentLossCannotBeDismissedBySinceIdZero() throws {
        let fixture = try CaptureDiskFixture()
        defer { fixture.dispose() }
        fixture.capture.detachPersistentStore()
        XCTAssertFalse(fixture.append(input("logs", 40)).accepted)
        fixture.capture.attachPersistentStore(fixture.store, directory: fixture.directory, targetKey: "bundle", runtimeEpoch: "epoch-1")
        _ = fixture.status()
        let page = fixture.capture.query(CaptureQuery(view: "decision-window", stream: "logs", sinceId: 0))
        XCTAssertTrue(page.ok); XCTAssertTrue(page.gap)
        XCTAssertEqual(page.coverage.status, "partial")
        XCTAssertTrue(fixture.append(input("logs", 41)).accepted)
        let next = fixture.capture.query(CaptureQuery(view: "decision-window", stream: "logs", cursor: page.watermarkCursor))
        XCTAssertEqual(ids(next), [41]); XCTAssertFalse(next.gap)
    }

    private func input(_ stream: String, _ id: Int64, action: String? = nil) -> CaptureInput {
        var record: [String: Any] = ["id": id, "timestampMs": id * 100, "source": "sdk", "message": "m\(id)"]
        if let action { record["actionId"] = action }
        if stream == "state" { record.merge(["namespace": "app", "key": "ready", "value": id]) { _, new in new } }
        return CaptureInput(stream: stream, targetKey: "bundle", runtimeEpoch: "epoch-1", captureId: id,
            timestampMs: id * 100, record: record, actionId: action, stateKey: stream == "state" ? "app:ready" : nil)
    }
    private func ids(_ page: CapturePage) -> [Int64] { page.items.compactMap { ($0["id"] as? NSNumber)?.int64Value } }
    private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }
}

private final class CaptureDiskFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("capture-disk-\(UUID().uuidString)")
    let writer = DispatchQueue(label: "capture-disk-test-writer")
    private(set) var store: SegmentedFactStore!
    private(set) var capture: MobileCaptureStore!
    private let caps: CountCaps
    private let segmentBytes: UInt64, quotaBytes: UInt64
    private let maxQueued: Int
    private let nativeFactory: () -> SegmentedFactStoreNative
    private var opened = false

    init(caps: CountCaps = CountCaps(), segmentBytes: UInt64 = 256 * 1024,
         quotaBytes: UInt64 = 8 * 1024 * 1024, maxQueued: Int = 256,
         nativeFactory: @escaping () -> SegmentedFactStoreNative = { CSegmentedFactStoreNative() }) throws {
        self.nativeFactory = nativeFactory
        self.caps = caps; self.segmentBytes = segmentBytes; self.quotaBytes = quotaBytes; self.maxQueued = maxQueued
        try open(epoch: "epoch-1")
    }
    func open(epoch: String, requireAttached: Bool = true) throws {
        store = SegmentedFactStore(nativeFactory: nativeFactory, writer: writer, maxQueuedRecords: maxQueued)
        capture = MobileCaptureStore(caps: caps)
        let result: SegmentedFactStoreOperationResult = wait { store.open(.init(directory: directory,
            segmentSizeBytes: segmentBytes, partitionQuotas: Array(repeating: quotaBytes, count: 8),
            receiveObservationFacts: false), completion: $0) }
        XCTAssertTrue(result.isSuccess, result.message)
        opened = result.isSuccess
        capture.attachPersistentStore(store, directory: directory, targetKey: "bundle", runtimeEpoch: epoch)
        _ = status()
        if requireAttached { XCTAssertTrue(capture.status().persistent, capture.status().reason ?? "") }
    }
    func close() {
        guard opened else { return }
        capture.detachPersistentStore()
        let result: SegmentedFactStoreOperationResult = wait { store.close(completion: $0) }
        XCTAssertTrue(result.isSuccess, result.message)
        opened = false
    }
    func reopen(epoch: String) throws { close(); try open(epoch: epoch) }
    func dispose() { close(); try? FileManager.default.removeItem(at: directory) }
    func append(_ input: CaptureInput) -> AppendReceipt { awaitCapture { capture.append(input, completion: $0) } }
    func status() -> SegmentedFactStoreStatus { wait { store.status(completion: $0) } }
    func read(partition: UInt32) -> SegmentedFactStoreReadResult { wait { store.read(cursor: .init(partitionId: partition), completion: $0) } }
    private func wait<T>(_ submit: (@escaping (T) -> Void) -> Void) -> T {
        let done = XCTestExpectation(description: "fact writer")
        var result: T?
        submit { result = $0; done.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 5), .completed)
        return result!
    }
}

// Faults are set/read on the writer queue; all other operations use the real C store.
private final class CaptureFaultNative: SegmentedFactStoreNative {
    let native = CSegmentedFactStoreNative()
    var failAppend = false, failFlush = false
    var onFlush: (() -> Void)?
    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult { native.open(options) }
    func append(handle: UInt64, partitionId: UInt32, payload: Data, durability: SegmentedFactStoreDurability) -> NativeAppendResult {
        if failAppend {
            failAppend = false
            return .init(operation: .init(code: SegmentedFactStoreResultCode.io, message: "injected write error"), sequence: 0, partitionId: partitionId)
        }
        return native.append(handle: handle, partitionId: partitionId, payload: payload, durability: durability)
    }
    func read(handle: UInt64, cursor: SegmentedFactStoreCursor, bufferCapacity: Int) -> SegmentedFactStoreReadResult {
        native.read(handle: handle, cursor: cursor, bufferCapacity: bufferCapacity)
    }
    func status(handle: UInt64) -> SegmentedFactStoreStatus { native.status(handle: handle) }
    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult {
        if failFlush { failFlush = false; return .init(code: SegmentedFactStoreResultCode.io, message: "injected flush error") }
        let result = native.flush(handle: handle)
        let callback = onFlush; onFlush = nil; callback?()
        return result
    }
    func close(handle: UInt64) -> SegmentedFactStoreOperationResult { native.close(handle: handle) }
}

private func awaitCapture(_ submit: (@escaping (AppendReceipt) -> Void) -> Void) -> AppendReceipt {
    let done = XCTestExpectation(description: "capture receipt")
    var result: AppendReceipt?
    submit { result = $0; done.fulfill() }
    XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 5), .completed)
    return result!
}
