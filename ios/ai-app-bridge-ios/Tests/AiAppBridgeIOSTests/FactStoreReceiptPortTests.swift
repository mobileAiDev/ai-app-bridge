import XCTest
@testable import AiAppBridgeIOS

final class FactStoreReceiptPortTests: XCTestCase {
    func testAcceptedCommittedClosedAndDisabledAreDistinct() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-receipt-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SegmentedFactStore(maxQueuedRecords: 4)
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        let accepted = port.appendWithReceipt(Data("g2-fact".utf8))
        XCTAssertEqual(accepted.status, "accepted")
        XCTAssertTrue(accepted.accepted)
        XCTAssertFalse(accepted.committed)
        XCTAssertNotNil(accepted.mobileFactId)
        XCTAssertEqual(port.throughWatermark().throughSequence, 0)

        let immediate = port.readPage(cursor: FactCursor(storeGeneration: accepted.storeGeneration), limit: 8)
        XCTAssertEqual(immediate.items.count, 1)
        XCTAssertEqual(immediate.items[0].mobileFactId, accepted.mobileFactId)
        XCTAssertFalse(immediate.items[0].committed)

        let committed = port.commitWait(mobileFactId: accepted.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(committed.status, "committed")
        XCTAssertTrue(committed.committed)
        XCTAssertEqual(port.throughWatermark().throughSequence, committed.globalSequence)
        let afterCommit = port.readPage(cursor: FactCursor(storeGeneration: accepted.storeGeneration), limit: 8)
        XCTAssertEqual(afterCommit.items.count, 1)
        XCTAssertTrue(afterCommit.items[0].committed)

        let tooLarge = port.appendWithReceipt(Data(repeating: 1, count: 1024 * 1024 + 1))
        XCTAssertEqual(tooLarge.status, "payload-too-large")
        XCTAssertFalse(tooLarge.accepted)

        let oldGeneration = accepted.storeGeneration
        _ = port.clear()
        let stale = port.readPage(cursor: FactCursor(storeGeneration: oldGeneration), limit: 8)
        XCTAssertTrue(stale.generationMismatch)
        XCTAssertTrue(stale.items.isEmpty)

        XCTAssertTrue(awaitClose(store))
        let closed = port.appendWithReceipt(Data("after-close".utf8))
        XCTAssertEqual(closed.status, "closed")

        let disabledDirectory = directory.appendingPathComponent("disabled", isDirectory: true)
        let disabledStore = SegmentedFactStore(maxQueuedRecords: 4)
        var disabledOptions = options
        disabledOptions.directory = disabledDirectory
        disabledOptions.enabled = false
        XCTAssertTrue(awaitOpen(disabledStore, disabledOptions))
        let disabled = FactStoreReceiptPort(store: disabledStore, directory: disabledDirectory)
            .appendWithReceipt(Data("nope".utf8))
        XCTAssertEqual(disabled.status, "disabled")
        XCTAssertTrue(awaitClose(disabledStore))
    }

    func testQueueFullIsDistinctWhenWriterIsBlocked() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-queue-full-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let native = BlockingFakeNative()
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "g2-queue-full"),
            maxQueuedRecords: 1
        )
        defer {
            native.release.signal()
            _ = awaitClose(store)
        }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        let first = port.appendWithReceipt(Data("held".utf8))
        XCTAssertEqual(first.status, "accepted")
        let full = port.appendWithReceipt(Data("overflow".utf8))
        XCTAssertEqual(full.status, "queue-full")
        XCTAssertFalse(full.accepted)
        XCTAssertNil(full.mobileFactId)
    }

    func testLargeFactCommitAndReopenHydratesPayload() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-large-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let payload = Data(repeating: 7, count: 70 * 1024)
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256 * 1024,
            partitionQuotas: [1024 * 1024],
            receiveObservationFacts: false
        )
        let firstStore = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(firstStore, options))
        let firstPort = FactStoreReceiptPort(store: firstStore, directory: directory)
        let accepted = firstPort.appendWithReceipt(payload)
        XCTAssertEqual(accepted.status, "accepted")
        let committed = firstPort.commitWait(mobileFactId: accepted.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(committed.status, "committed")
        let drain = firstPort.flushDrain(timeoutMs: 2000)
        XCTAssertTrue(drain.ok)
        XCTAssertTrue(awaitClose(firstStore))

        let reopened = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(reopened, options))
        let port = FactStoreReceiptPort(store: reopened, directory: directory)
        let page = port.readPage(cursor: FactCursor(storeGeneration: accepted.storeGeneration), limit: 8)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].payload, payload)
        XCTAssertTrue(awaitClose(reopened))
    }

    func testFlushDrainInvokesNativeFlush() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-flush-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let native = CountingFlushNative()
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "g2-flush"),
            maxQueuedRecords: 4
        )
        defer { _ = awaitClose(store) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        XCTAssertEqual(port.appendWithReceipt(Data("flush-me".utf8)).status, "accepted")
        let drain = port.flushDrain(timeoutMs: 2000)
        XCTAssertTrue(drain.ok)
        XCTAssertGreaterThanOrEqual(native.flushCount, 1)
    }

    func testPostAcceptWriteFailureBecomesDropped() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-dropped-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let native = FailingAppendNative()
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "g2-dropped"),
            maxQueuedRecords: 4
        )
        defer { _ = awaitClose(store) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        let accepted = port.appendWithReceipt(Data("will-drop".utf8))
        XCTAssertEqual(accepted.status, "accepted")
        let waited = port.commitWait(mobileFactId: accepted.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(waited.status, "dropped")
        XCTAssertFalse(waited.accepted)
        XCTAssertFalse(waited.committed)
    }

    func testFlushFailureIsNotASuccessfulDrain() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-flush-fail-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let native = FailingFlushNative()
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "g2-flush-fail"),
            maxQueuedRecords: 4
        )
        defer { _ = awaitClose(store) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        XCTAssertEqual(port.appendWithReceipt(Data("flush-fail".utf8)).status, "accepted")
        let drain = port.flushDrain(timeoutMs: 2000)
        XCTAssertFalse(drain.ok)
        XCTAssertEqual(drain.committed, 0)
    }

    func testClearDoesNotReuseOldStoreSequenceForSamePayload() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-clear-seq-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SegmentedFactStore(maxQueuedRecords: 4)
        defer { _ = awaitClose(store) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        let first = port.appendWithReceipt(Data("same".utf8))
        let committed = port.commitWait(mobileFactId: first.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(committed.status, "committed")
        let oldSequence = committed.globalSequence!
        _ = port.clear()
        let second = port.appendWithReceipt(Data("same".utf8))
        let afterClear = port.commitWait(mobileFactId: second.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(afterClear.status, "committed")
        XCTAssertGreaterThan(afterClear.globalSequence!, oldSequence)
        let unknown = port.commitWait(mobileFactId: "mf1:1:99:deadbeef", timeoutMs: 2000)
        XCTAssertEqual(unknown.status, "dropped")
    }

    func testPendingIsVisibleAfterCommittedCursor() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-pending-cursor-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SegmentedFactStore(maxQueuedRecords: 4)
        defer { _ = awaitClose(store) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        let first = port.appendWithReceipt(Data("one".utf8))
        let committed = port.commitWait(mobileFactId: first.mobileFactId!, timeoutMs: 2000)
        let second = port.appendWithReceipt(Data("two".utf8))
        XCTAssertNil(second.globalSequence)
        let page = port.readPage(
            cursor: FactCursor(storeGeneration: first.storeGeneration, afterSequence: committed.globalSequence!),
            limit: 8
        )
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].mobileFactId, second.mobileFactId)
        XCTAssertFalse(page.items[0].committed)
    }

    func testTruncatedSidecarLineDoesNotFailReopen() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-sidecar-tail-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        let firstStore = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(firstStore, options))
        let firstPort = FactStoreReceiptPort(store: firstStore, directory: directory)
        let accepted = firstPort.appendWithReceipt(Data("keep".utf8))
        XCTAssertEqual(firstPort.commitWait(mobileFactId: accepted.mobileFactId!, timeoutMs: 2000).status, "committed")
        XCTAssertTrue(awaitClose(firstStore))
        let sidecar = directory.appendingPathComponent(FactStoreReceiptPort.sidecarName)
        if let handle = try? FileHandle(forWritingTo: sidecar) {
            handle.seekToEndOfFile()
            handle.write(Data("{\"mobileFactId\":\"mf1".utf8))
            try? handle.close()
        }
        let reopened = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(reopened, options))
        let port = FactStoreReceiptPort(store: reopened, directory: directory)
        let page = port.readPage(cursor: FactCursor(storeGeneration: accepted.storeGeneration), limit: 8)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].mobileFactId, accepted.mobileFactId)
        XCTAssertTrue(awaitClose(reopened))
    }

    func testFailedThenSuccessfulWriteBindsByPayloadHash() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-mix-bind-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let native = FailFirstThenSucceedNative()
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "g2-mix-bind"),
            maxQueuedRecords: 4
        )
        defer { _ = awaitClose(store) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        let lost = Data("lost-a".utf8)
        let kept = Data("kept-b".utf8)
        let first = port.appendWithReceipt(lost)
        let second = port.appendWithReceipt(kept)
        XCTAssertEqual(port.commitWait(mobileFactId: first.mobileFactId!, timeoutMs: 2000).status, "dropped")
        let committed = port.commitWait(mobileFactId: second.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(committed.status, "committed")
        XCTAssertEqual(
            committed.mobileFactId,
            "mf1:\(committed.storeGeneration):\(committed.globalSequence!):\(receiptTestHash(kept))"
        )
        let page = port.readPage(cursor: FactCursor(storeGeneration: second.storeGeneration), limit: 8)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].payload, kept)
        XCTAssertEqual(page.items[0].mobileFactId, committed.mobileFactId)
    }

    func testFailedThenSuccessfulIdenticalPayloadBindsTheSuccessfulAccept() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-same-hash-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let native = FailFirstThenSucceedNative()
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "g2-same-hash"),
            maxQueuedRecords: 4
        )
        defer { _ = awaitClose(store) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOpen(store, options))
        let port = FactStoreReceiptPort(store: store, directory: directory)
        let payload = Data("same-bytes".utf8)
        let first = port.appendWithReceipt(payload)
        let second = port.appendWithReceipt(payload)
        XCTAssertEqual(port.commitWait(mobileFactId: first.mobileFactId!, timeoutMs: 2000).status, "dropped")
        let committed = port.commitWait(mobileFactId: second.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(committed.status, "committed")
        XCTAssertEqual(
            committed.mobileFactId,
            "mf1:\(committed.storeGeneration):\(committed.globalSequence!):\(receiptTestHash(payload))"
        )
        let page = port.readPage(cursor: FactCursor(storeGeneration: second.storeGeneration), limit: 8)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].payload, payload)
        XCTAssertEqual(page.items[0].mobileFactId, committed.mobileFactId)
    }

    func testTornLastSidecarLineDoesNotBindOldRecordToNewId() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-torn-last-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        let firstStore = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(firstStore, options))
        let firstPort = FactStoreReceiptPort(store: firstStore, directory: directory)
        let kept = Data("keep-a".utf8)
        let accepted = firstPort.appendWithReceipt(kept)
        XCTAssertEqual(firstPort.commitWait(mobileFactId: accepted.mobileFactId!, timeoutMs: 2000).status, "committed")
        XCTAssertTrue(awaitClose(firstStore))
        let sidecar = directory.appendingPathComponent(FactStoreReceiptPort.sidecarName)
        try? Data("{\"mobileFactId\":\"mf1".utf8).write(to: sidecar)
        let reopened = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(reopened, options))
        let port = FactStoreReceiptPort(store: reopened, directory: directory)
        let next = Data("new-b".utf8)
        let second = port.appendWithReceipt(next)
        XCTAssertEqual(port.commitWait(mobileFactId: second.mobileFactId!, timeoutMs: 2000).status, "committed")
        let page = port.readPage(cursor: FactCursor(storeGeneration: second.storeGeneration), limit: 8)
        XCTAssertEqual(page.items.count, 2)
        XCTAssertEqual(page.items[0].payload, kept)
        XCTAssertEqual(page.items[1].payload, next)
        XCTAssertEqual(page.items[0].mobileFactId.split(separator: ":").last.map(String.init), receiptTestHash(kept))
        XCTAssertEqual(page.items[1].mobileFactId.split(separator: ":").last.map(String.init), receiptTestHash(next))
        XCTAssertTrue(awaitClose(reopened))
        let secondReopen = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(secondReopen, options))
        let reopenedAgain = FactStoreReceiptPort(store: secondReopen, directory: directory)
        let again = reopenedAgain.readPage(cursor: FactCursor(storeGeneration: second.storeGeneration), limit: 8)
        XCTAssertEqual(again.items.count, 2)
        XCTAssertEqual(again.items[0].payload, kept)
        XCTAssertEqual(again.items[1].payload, next)
        XCTAssertEqual(again.items[0].mobileFactId.split(separator: ":").last.map(String.init), receiptTestHash(kept))
        XCTAssertEqual(again.items[1].mobileFactId.split(separator: ":").last.map(String.init), receiptTestHash(next))
        XCTAssertTrue(awaitClose(secondReopen))
    }

    func testReopenHydratesSidecarPayloadsFromStore() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-reopen-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        let firstStore = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(firstStore, options))
        let firstPort = FactStoreReceiptPort(store: firstStore, directory: directory)
        let payload = Data("g2-reopen".utf8)
        let accepted = firstPort.appendWithReceipt(payload)
        let committed = firstPort.commitWait(mobileFactId: accepted.mobileFactId!, timeoutMs: 2000)
        XCTAssertEqual(committed.status, "committed")
        let watermark = firstPort.throughWatermark()
        XCTAssertTrue(awaitClose(firstStore))

        let reopened = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOpen(reopened, options))
        let port = FactStoreReceiptPort(store: reopened, directory: directory)
        let page = port.readPage(cursor: FactCursor(storeGeneration: accepted.storeGeneration), limit: 8)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].mobileFactId, accepted.mobileFactId)
        XCTAssertTrue(page.items[0].committed)
        XCTAssertEqual(page.items[0].payload, payload)
        XCTAssertEqual(port.throughWatermark().throughSequence, watermark.throughSequence)
        XCTAssertTrue(awaitClose(reopened))
    }

    private func awaitOpen(_ store: SegmentedFactStore, _ options: SegmentedFactStoreOptions) -> Bool {
        let done = expectation(description: "open")
        var ok = false
        store.open(options) {
            ok = $0.isSuccess
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        return ok
    }

    private func awaitClose(_ store: SegmentedFactStore) -> Bool {
        let done = expectation(description: "close")
        var ok = false
        store.close {
            ok = $0.isSuccess
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        return ok
    }
}

private final class BlockingFakeNative: SegmentedFactStoreNative {
    let release = DispatchSemaphore(value: 0)

    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult {
        .init(operation: ok, handle: 1)
    }

    func append(
        handle: UInt64,
        partitionId: UInt32,
        payload: Data,
        durability: SegmentedFactStoreDurability
    ) -> NativeAppendResult {
        _ = release.wait(timeout: .now() + 5)
        return .init(operation: ok, sequence: 1)
    }

    func read(
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        .init(
            operation: .init(code: SegmentedFactStoreResultCode.end),
            cursor: cursor,
            record: nil,
            requiredCapacity: 0
        )
    }

    func status(handle: UInt64) -> SegmentedFactStoreStatus {
        .init(
            operation: ok,
            state: .open,
            enabled: true,
            queuedRecords: 0,
            acceptedRecords: 0,
            writtenRecords: 0,
            droppedRecords: 0,
            formatVersion: 1,
            recoveredTail: false,
            segmentSizeBytes: 256,
            segmentCount: 1,
            firstSegmentId: 1,
            activeSegmentId: 1,
            activeWriteOffset: 64,
            recordCount: 0,
            payloadBytes: 0,
            nextSequence: 1,
            recoveryPartitionId: UInt32.max,
            recoverySegmentId: 0,
            recoveryOffset: 0,
            recoveryDiscardedBytes: 0
        )
    }

    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }
    func close(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }

    private var ok: SegmentedFactStoreOperationResult {
        .init(code: SegmentedFactStoreResultCode.ok)
    }
}

private final class CountingFlushNative: SegmentedFactStoreNative {
    private(set) var flushCount = 0
    private var nextSequence: UInt64 = 1

    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult {
        .init(operation: ok, handle: 1)
    }

    func append(
        handle: UInt64,
        partitionId: UInt32,
        payload: Data,
        durability: SegmentedFactStoreDurability
    ) -> NativeAppendResult {
        let sequence = nextSequence
        nextSequence += 1
        return .init(operation: ok, sequence: sequence)
    }

    func read(
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        .init(
            operation: .init(code: SegmentedFactStoreResultCode.end),
            cursor: cursor,
            record: nil,
            requiredCapacity: 0
        )
    }

    func status(handle: UInt64) -> SegmentedFactStoreStatus {
        .init(
            operation: ok,
            state: .open,
            enabled: true,
            queuedRecords: 0,
            acceptedRecords: 0,
            writtenRecords: 0,
            droppedRecords: 0,
            formatVersion: 1,
            recoveredTail: false,
            segmentSizeBytes: 256,
            segmentCount: 1,
            firstSegmentId: 1,
            activeSegmentId: 1,
            activeWriteOffset: 64,
            recordCount: 0,
            payloadBytes: 0,
            nextSequence: 1,
            recoveryPartitionId: UInt32.max,
            recoverySegmentId: 0,
            recoveryOffset: 0,
            recoveryDiscardedBytes: 0
        )
    }

    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult {
        flushCount += 1
        return ok
    }

    func close(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }

    private var ok: SegmentedFactStoreOperationResult {
        .init(code: SegmentedFactStoreResultCode.ok)
    }
}

private func receiptTestHash(_ bytes: Data) -> String {
    var hash: UInt32 = 0x811c9dc5
    for byte in bytes {
        hash ^= UInt32(byte)
        hash = hash &* 16777619
    }
    return String(format: "%08x", hash)
}

private final class FailFirstThenSucceedNative: SegmentedFactStoreNative {
    private var written: [(sequence: UInt64, payload: Data)] = []
    private var attempts = 0
    private var nextSequence: UInt64 = 1

    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult {
        .init(operation: ok, handle: 1)
    }

    func append(
        handle: UInt64,
        partitionId: UInt32,
        payload: Data,
        durability: SegmentedFactStoreDurability
    ) -> NativeAppendResult {
        attempts += 1
        if attempts == 1 {
            return .init(operation: .init(code: SegmentedFactStoreResultCode.io, message: "write-failed"), sequence: 0)
        }
        let sequence = nextSequence
        nextSequence += 1
        written.append((sequence, payload))
        return .init(operation: ok, sequence: sequence)
    }

    func read(
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        guard let next = written.first(where: { $0.sequence > cursor.afterSequence }) else {
            return .init(
                operation: .init(code: SegmentedFactStoreResultCode.end),
                cursor: cursor,
                record: nil,
                requiredCapacity: 0
            )
        }
        return .init(
            operation: ok,
            cursor: SegmentedFactStoreCursor(
                partitionId: cursor.partitionId,
                flags: cursor.flags,
                afterSequence: next.sequence,
                segmentId: cursor.segmentId,
                offset: cursor.offset
            ),
            record: SegmentedFactStoreRecord(
                payload: next.payload,
                partitionId: 0,
                flags: 0,
                sequence: next.sequence,
                segmentId: 1,
                frameOffset: 0,
                gapFirstSequence: 0,
                gapLastSequence: 0
            ),
            requiredCapacity: 0
        )
    }

    func status(handle: UInt64) -> SegmentedFactStoreStatus {
        .init(
            operation: ok,
            state: .open,
            enabled: true,
            queuedRecords: 0,
            acceptedRecords: UInt64(attempts),
            writtenRecords: UInt64(written.count),
            droppedRecords: attempts > 0 ? 1 : 0,
            formatVersion: 1,
            recoveredTail: false,
            segmentSizeBytes: 256,
            segmentCount: 1,
            firstSegmentId: 1,
            activeSegmentId: 1,
            activeWriteOffset: 64,
            recordCount: UInt64(written.count),
            payloadBytes: 0,
            nextSequence: nextSequence,
            recoveryPartitionId: UInt32.max,
            recoverySegmentId: 0,
            recoveryOffset: 0,
            recoveryDiscardedBytes: 0
        )
    }

    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }
    func close(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }

    private var ok: SegmentedFactStoreOperationResult {
        .init(code: SegmentedFactStoreResultCode.ok)
    }
}

private final class FailingAppendNative: SegmentedFactStoreNative {
    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult {
        .init(operation: ok, handle: 1)
    }

    func append(
        handle: UInt64,
        partitionId: UInt32,
        payload: Data,
        durability: SegmentedFactStoreDurability
    ) -> NativeAppendResult {
        .init(operation: .init(code: SegmentedFactStoreResultCode.io, message: "write-failed"), sequence: 0)
    }

    func read(
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        .init(
            operation: .init(code: SegmentedFactStoreResultCode.end),
            cursor: cursor,
            record: nil,
            requiredCapacity: 0
        )
    }

    func status(handle: UInt64) -> SegmentedFactStoreStatus {
        .init(
            operation: ok,
            state: .open,
            enabled: true,
            queuedRecords: 0,
            acceptedRecords: 0,
            writtenRecords: 0,
            droppedRecords: 1,
            formatVersion: 1,
            recoveredTail: false,
            segmentSizeBytes: 256,
            segmentCount: 1,
            firstSegmentId: 1,
            activeSegmentId: 1,
            activeWriteOffset: 64,
            recordCount: 0,
            payloadBytes: 0,
            nextSequence: 1,
            recoveryPartitionId: UInt32.max,
            recoverySegmentId: 0,
            recoveryOffset: 0,
            recoveryDiscardedBytes: 0
        )
    }

    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }
    func close(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }

    private var ok: SegmentedFactStoreOperationResult {
        .init(code: SegmentedFactStoreResultCode.ok)
    }
}

private final class FailingFlushNative: SegmentedFactStoreNative {
    private var nextSequence: UInt64 = 1

    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult {
        .init(operation: ok, handle: 1)
    }

    func append(
        handle: UInt64,
        partitionId: UInt32,
        payload: Data,
        durability: SegmentedFactStoreDurability
    ) -> NativeAppendResult {
        let sequence = nextSequence
        nextSequence += 1
        return .init(operation: ok, sequence: sequence)
    }

    func read(
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        .init(
            operation: .init(code: SegmentedFactStoreResultCode.end),
            cursor: cursor,
            record: nil,
            requiredCapacity: 0
        )
    }

    func status(handle: UInt64) -> SegmentedFactStoreStatus {
        .init(
            operation: ok,
            state: .open,
            enabled: true,
            queuedRecords: 0,
            acceptedRecords: 0,
            writtenRecords: 0,
            droppedRecords: 0,
            formatVersion: 1,
            recoveredTail: false,
            segmentSizeBytes: 256,
            segmentCount: 1,
            firstSegmentId: 1,
            activeSegmentId: 1,
            activeWriteOffset: 64,
            recordCount: 0,
            payloadBytes: 0,
            nextSequence: 1,
            recoveryPartitionId: UInt32.max,
            recoverySegmentId: 0,
            recoveryOffset: 0,
            recoveryDiscardedBytes: 0
        )
    }

    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult {
        .init(code: SegmentedFactStoreResultCode.io)
    }

    func close(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }

    private var ok: SegmentedFactStoreOperationResult {
        .init(code: SegmentedFactStoreResultCode.ok)
    }
}
