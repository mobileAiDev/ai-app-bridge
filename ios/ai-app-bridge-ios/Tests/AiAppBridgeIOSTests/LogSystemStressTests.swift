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
        var previousDisk: UInt64 = 0
        for (name, count) in tiers {
            let row = try runPersistLoad(tier: name, count: count)
            XCTAssertEqual(row["written"] as? UInt64, UInt64(count))
            XCTAssertEqual(row["dropped"] as? UInt64, 0)
            let disk = row["diskDeltaBytes"] as? UInt64 ?? 0
            XCTAssertGreaterThan(disk, previousDisk, "\(name) disk")
            previousDisk = disk
            print("AAB_LOG_LOAD ios \(row)")
        }
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
        var accepted = 0
        for index in 0..<2_000 {
            let payload = try SanitizedFactPayload.log(
                context: context,
                record: [
                    "type": "log",
                    "source": "nslog",
                    "message": "aab-log-stress-\(index)"
                ]
            )
            XCTAssertEqual(store.record(payload.data, partitionId: payload.partitionId), .accepted)
            accepted += 1
        }
        let status = awaitStatus(store, writtenAtLeast: accepted)
        let elapsedMs = elapsedMs(since: startedAt)

        XCTAssertEqual(status.acceptedRecords, 2_000)
        XCTAssertEqual(status.writtenRecords, 2_000)
        XCTAssertEqual(status.droppedRecords, 0)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
        print("AAB_LOG_STRESS ios-persist-pipeline count=2000 written=\(status.writtenRecords) elapsedMs=\(elapsedMs)")
    }

    private func runPersistLoad(tier: String, count: Int) throws -> [String: Any] {
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
        let store = SegmentedFactStore(maxQueuedRecords: 256)
        XCTAssertTrue(awaitOperation { store.open(options, completion: $0) }.isSuccess)
        var before = rusage()
        getrusage(RUSAGE_SELF, &before)
        let startedAt = DispatchTime.now()
        for index in 0..<count {
            let payload = try SanitizedFactPayload.log(
                context: context,
                record: [
                    "type": "log",
                    "source": "nslog",
                    "message": "aab-log-stress-\(index)"
                ]
            )
            XCTAssertEqual(store.record(payload.data, partitionId: payload.partitionId), .accepted)
        }
        let status = awaitStatus(store, writtenAtLeast: count, timeout: 30)
        let elapsed = elapsedMs(since: startedAt)
        var after = rusage()
        getrusage(RUSAGE_SELF, &after)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
        let cpuMs = cpuMillis(after) - cpuMillis(before)
        return [
            "tier": tier,
            "offered": count,
            "written": status.writtenRecords,
            "dropped": status.droppedRecords,
            "elapsedMs": elapsed,
            "cpuMs": cpuMs,
            "cpuPercent": elapsed == 0 ? 0 : Double(cpuMs) / Double(elapsed) * 100,
            "maxRssBytes": after.ru_maxrss,
            "diskDeltaBytes": directoryBytes(directory),
            "storePayloadBytes": status.payloadBytes
        ]
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

    private func awaitStatus(
        _ store: SegmentedFactStore,
        writtenAtLeast: Int,
        timeout: TimeInterval = 15
    ) -> SegmentedFactStoreStatus {
        let deadline = Date().addingTimeInterval(timeout)
        var last: SegmentedFactStoreStatus?
        while Date() < deadline {
            let expectation = expectation(description: "status")
            var result: SegmentedFactStoreStatus?
            store.status {
                result = $0
                expectation.fulfill()
            }
            wait(for: [expectation], timeout: 5)
            last = result
            if let result, result.writtenRecords >= UInt64(writtenAtLeast), result.queuedRecords == 0 {
                return result
            }
        }
        return last!
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
