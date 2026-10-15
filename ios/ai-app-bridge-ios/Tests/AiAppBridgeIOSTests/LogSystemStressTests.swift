import Darwin
import XCTest
@testable import AiAppBridgeIOS

final class LogSystemStressTests: XCTestCase {
    func testH5DrainParserKeepsHookBufferCap() throws {
        let items = (0..<1_000).map { index in
            [
                "method": index % 2 == 0 ? "log" : "warn",
                "message": "h5-stress-\(index)",
                "atMs": index
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: items)
        let raw = String(decoding: data, as: UTF8.self)
        let startedAt = DispatchTime.now()
        let parsed = H5ConsoleDrainParser.parse(raw)
        let elapsedMs = elapsedMs(since: startedAt)

        XCTAssertEqual(parsed.count, 1_000)
        XCTAssertEqual(parsed.first?.message, "h5-stress-0")
        XCTAssertEqual(parsed.last?.message, "h5-stress-999")
        XCTAssertLessThan(elapsedMs, 2_000)
        print("AAB_LOG_STRESS h5-drain-parse count=1000 elapsedMs=\(elapsedMs)")
    }

    func testLogEnvelopeBurstStaysOnAppLogPartition() throws {
        let context = MobileFactEnvelopeContext(
            platform: "ios",
            packageName: nil,
            bundleId: "com.example.app",
            model: "iPhone Test",
            deviceIdentity: "sha256:stress",
            runtimeEpoch: "runtime-stress",
            actionId: nil,
            occurredAtMs: 1_000,
            observedAtMs: 1_010
        )
        let startedAt = DispatchTime.now()
        let facts = try (0..<5_000).map { index in
            try SanitizedFactPayload.log(
                context: context,
                record: [
                    "type": "log",
                    "source": "nslog",
                    "level": "info",
                    "tag": "NSLog",
                    "message": "aab-log-stress-\(index)"
                ]
            )
        }
        let elapsedMs = elapsedMs(since: startedAt)

        XCTAssertEqual(facts.count, 5_000)
        XCTAssertTrue(facts.allSatisfy { $0.partitionId == MobileFactPartition.appLog.rawValue })
        XCTAssertLessThan(elapsedMs, 3_000)
        print("AAB_LOG_STRESS ios-envelope count=5000 elapsedMs=\(elapsedMs) bytes=\(facts[0].data.count)")
    }

    func testMeasuresCpuMemoryAndDiskAcrossPersistLoadTiers() throws {
        let tiers = [("low", 200), ("medium", 2_000), ("high", 10_000)]
        for (name, count) in tiers {
            let row = try runPersistLoad(tier: name, count: count)
            XCTAssertEqual(row["offered"] as? Int, count)
            // Segments are preallocated, so disk size need not grow at every tier.
            XCTAssertGreaterThan(try XCTUnwrap(row["diskDeltaBytes"] as? UInt64), 0)
            print("AAB_LOG_LOAD ios \(row)")
        }
    }

    func testPersistLoadKeepsAcceptedRecordsWhenTheWriterQueueFills() throws {
        let row = try runPersistLoad(tier: "held-writer", count: 257, holdWriter: true)
        XCTAssertEqual(row["accepted"] as? Int, 256)
        XCTAssertEqual(row["queueFull"] as? Int, 1)
        XCTAssertEqual(row["written"] as? UInt64, 256)
        XCTAssertEqual(row["dropped"] as? UInt64, 1)
    }

    func testPersistPipelineWritesLogEnvelopesToMappedStore() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "aab-log-stress-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let segmentSize: UInt64 = 256 * 1024
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: segmentSize,
            partitionQuotas: [
                segmentSize,
                segmentSize,
                8 * segmentSize,
                2 * segmentSize,
                segmentSize,
                segmentSize,
                segmentSize,
                segmentSize
            ],
            receiveObservationFacts: false
        )
        let context = MobileFactEnvelopeContext(
            platform: "ios",
            packageName: nil,
            bundleId: "com.example.app",
            model: "iPhone Test",
            deviceIdentity: "sha256:stress",
            runtimeEpoch: "runtime-stress",
            actionId: nil,
            occurredAtMs: 1_000,
            observedAtMs: 1_010
        )
        let store = SegmentedFactStore(maxQueuedRecords: 256)
        XCTAssertTrue(awaitOperation { store.open(options, completion: $0) }.isSuccess)

        let startedAt = DispatchTime.now()
        let offered = try offerLogs(store, context: context, count: 2_000)
        let status = try awaitStatus(store)
        let elapsedMs = elapsedMs(since: startedAt)

        assertAccounting(status, accepted: offered.accepted, queueFull: offered.queueFull, offered: 2_000)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
        try assertPersisted(options: options, accepted: offered.accepted)
        print("AAB_LOG_STRESS ios-persist-pipeline offered=2000 accepted=\(offered.accepted.count) queueFull=\(offered.queueFull) written=\(status.writtenRecords) elapsedMs=\(elapsedMs)")
    }

    private func runPersistLoad(tier: String, count: Int, holdWriter: Bool = false) throws -> [String: Any] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "aab-log-load-\(tier)-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let segmentSize: UInt64 = 256 * 1024
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: segmentSize,
            partitionQuotas: [
                segmentSize,
                segmentSize,
                32 * segmentSize,
                2 * segmentSize,
                segmentSize,
                segmentSize,
                segmentSize,
                segmentSize
            ],
            receiveObservationFacts: false
        )
        let context = MobileFactEnvelopeContext(
            platform: "ios",
            packageName: nil,
            bundleId: "com.example.app",
            model: "iPhone Test",
            deviceIdentity: "sha256:stress",
            runtimeEpoch: "runtime-stress",
            actionId: nil,
            occurredAtMs: 1_000,
            observedAtMs: 1_010
        )
        let writer = DispatchQueue(label: "aab-log-load-writer")
        let store = SegmentedFactStore(nativeFactory: { CSegmentedFactStoreNative() },
                                       writer: writer, maxQueuedRecords: 256)
        XCTAssertTrue(awaitOperation { store.open(options, completion: $0) }.isSuccess)
        var before = rusage()
        getrusage(RUSAGE_SELF, &before)
        let startedAt = DispatchTime.now()
        let offered = try { () throws -> (accepted: [Data], queueFull: Int) in
            if holdWriter { writer.suspend() }
            defer { if holdWriter { writer.resume() } }
            return try offerLogs(store, context: context, count: count)
        }()
        let status = try awaitStatus(store)
        assertAccounting(status, accepted: offered.accepted, queueFull: offered.queueFull, offered: count)
        let elapsed = elapsedMs(since: startedAt)
        var after = rusage()
        getrusage(RUSAGE_SELF, &after)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
        let cpuMs = cpuMillis(after) - cpuMillis(before)
        let diskBytes = directoryBytes(directory)
        try assertPersisted(options: options, accepted: offered.accepted)
        return [
            "tier": tier,
            "offered": count,
            "accepted": offered.accepted.count,
            "queueFull": offered.queueFull,
            "written": status.writtenRecords,
            "dropped": status.droppedRecords,
            "elapsedMs": elapsed,
            "cpuMs": cpuMs,
            "cpuPercent": elapsed == 0 ? 0 : Double(cpuMs) / Double(elapsed) * 100,
            "maxRssBytes": after.ru_maxrss,
            "diskDeltaBytes": diskBytes,
            "storePayloadBytes": status.payloadBytes
        ]
    }

    private func offerLogs(_ store: SegmentedFactStore, context: MobileFactEnvelopeContext,
                           count: Int) throws -> (accepted: [Data], queueFull: Int) {
        var accepted: [Data] = []
        var queueFull = 0
        for index in 0..<count {
            let payload = try SanitizedFactPayload.log(context: context,
                record: ["type": "log", "source": "nslog", "message": "aab-log-stress-\(index)"])
            switch store.record(payload.data, partitionId: payload.partitionId) {
            case .accepted: accepted.append(payload.data)
            case .queueFull: queueFull += 1
            default: XCTFail("unexpected admission result")
            }
        }
        return (accepted, queueFull)
    }

    private func assertAccounting(_ status: SegmentedFactStoreStatus, accepted: [Data],
                                  queueFull: Int, offered: Int) {
        XCTAssertGreaterThan(accepted.count, 0)
        XCTAssertEqual(accepted.count + queueFull, offered)
        XCTAssertEqual(status.acceptedRecords, UInt64(accepted.count))
        XCTAssertEqual(status.writtenRecords, UInt64(accepted.count))
        XCTAssertEqual(status.droppedRecords, UInt64(queueFull))
        XCTAssertEqual(status.queuedRecords, 0)
        XCTAssertEqual(status.payloadBytes, UInt64(accepted.reduce(0) { $0 + $1.count }))
        XCTAssertTrue(status.operation.isSuccess)
    }

    private func assertPersisted(options: SegmentedFactStoreOptions, accepted: [Data]) throws {
        let reopened = SegmentedFactStore(maxQueuedRecords: 256)
        XCTAssertTrue(awaitOperation { reopened.open(options, completion: $0) }.isSuccess)
        defer { XCTAssertTrue(awaitOperation { reopened.close(completion: $0) }.isSuccess) }
        let read = expectation(description: "read persisted accepted records")
        var records: [SegmentedFactStoreRecord] = []
        var end: SegmentedFactStoreReadResult?
        reopened.readPage(cursor: .init(partitionId: MobileFactPartition.appLog.rawValue),
                          maxRecords: accepted.count + 1,
                          maxBytes: accepted.reduce(1) { $0 + $1.count }) {
            records = $0; end = $1; read.fulfill()
        }
        wait(for: [read], timeout: 5)
        XCTAssertTrue(try XCTUnwrap(end).isEnd)
        XCTAssertEqual(records.map(\.payload), accepted)
        XCTAssertEqual(records.map(\.sequence), (0..<accepted.count).map { UInt64($0 + 1) })
        XCTAssertTrue(records.allSatisfy { $0.partitionId == MobileFactPartition.appLog.rawValue })
    }

    private func awaitOperation(
        _ action: (@escaping (SegmentedFactStoreOperationResult) -> Void) -> Void
    ) -> SegmentedFactStoreOperationResult {
        let expectation = expectation(description: "operation")
        var result = SegmentedFactStoreOperationResult(code: -999)
        action {
            result = $0
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 10)
        return result
    }

    private func awaitStatus(_ store: SegmentedFactStore) throws -> SegmentedFactStoreStatus {
        // status is queued after all offered writes on the same serial writer.
        let ready = expectation(description: "status")
        var result: SegmentedFactStoreStatus?
        store.status { result = $0; ready.fulfill() }
        wait(for: [ready], timeout: 5)
        return try XCTUnwrap(result)
    }

    private func elapsedMs(since startedAt: DispatchTime) -> UInt64 {
        (DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
    }

    private func cpuMillis(_ usage: rusage) -> Int64 {
        Int64(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000
            + Int64(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
    }

    private func directoryBytes(_ root: URL) -> UInt64 {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) else {
            return 0
        }
        var total: UInt64 = 0
        for case let file as URL in enumerator {
            let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            if values?.isRegularFile == true {
                total += UInt64(values?.fileSize ?? 0)
            }
        }
        return total
    }
}
