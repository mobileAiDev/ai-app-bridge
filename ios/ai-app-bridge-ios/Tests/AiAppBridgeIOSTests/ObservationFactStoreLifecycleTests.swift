import Foundation
import XCTest
@testable import AiAppBridgeIOS

final class ObservationFactStoreLifecycleTests: XCTestCase {
    func testAutoProfilesUseEightBoundedHardQuotas() {
        let defaultProfile = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/profile-default"),
            totalBytes: 32 * gib,
            availableBytes: 8 * gib
        )
        let large = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/profile-large"),
            totalBytes: 16 * gib,
            availableBytes: 4 * gib
        )
        let medium = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/profile-medium"),
            totalBytes: 4 * gib,
            availableBytes: 2 * gib
        )
        let small = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/profile-small"),
            totalBytes: 3 * gib,
            availableBytes: 1 * gib
        )
        let lowDisk = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/profile-low-disk"),
            totalBytes: 3 * gib,
            availableBytes: 300 * mib
        )

        XCTAssertEqual(defaultProfile.profile, "1gb")
        XCTAssertEqual(defaultProfile.budgetBytes, gib)
        XCTAssertEqual(defaultProfile.options.segmentSizeBytes, 4 * mib)
        XCTAssertEqual(large.profile, "512mb")
        XCTAssertEqual(large.budgetBytes, 512 * mib)
        XCTAssertEqual(large.options.segmentSizeBytes, 4 * mib)
        XCTAssertEqual(medium.profile, "256mb")
        XCTAssertEqual(medium.options.segmentSizeBytes, 2 * mib)
        XCTAssertEqual(small.profile, "64mb")
        XCTAssertEqual(small.options.segmentSizeBytes, 512 * 1024)
        XCTAssertEqual(lowDisk.profile, "off-low-disk")
        XCTAssertEqual(lowDisk.budgetBytes, 0)
        XCTAssertEqual(lowDisk.disabledReason, "insufficient-space")
        XCTAssertFalse(lowDisk.options.enabled)
        XCTAssertEqual(lowDisk.options.partitionQuotas, Array(repeating: 0, count: 8))
        for configuration in [defaultProfile, large, medium, small] {
            XCTAssertEqual(configuration.options.partitionQuotas.count, 8)
            XCTAssertTrue(configuration.options.partitionQuotas.allSatisfy {
                $0 >= configuration.options.segmentSizeBytes
                    && $0 % configuration.options.segmentSizeBytes == 0
            })
            XCTAssertLessThanOrEqual(
                configuration.options.partitionQuotas.reduce(0, +),
                configuration.budgetBytes
            )
            XCTAssertEqual(configuration.options.directory.lastPathComponent, configuration.profile)
        }
    }

    func testEachDeviceAppContainerOwnsItsFullQuotaWithoutCrossEviction() {
        let first = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/device-a-app-a"),
            totalBytes: 32 * gib,
            availableBytes: 8 * gib
        )
        let second = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/device-b-app-b"),
            totalBytes: 32 * gib,
            availableBytes: 8 * gib
        )

        XCTAssertEqual(first.budgetBytes, gib)
        XCTAssertEqual(second.budgetBytes, gib)
        XCTAssertNotEqual(first.options.directory.path, second.options.directory.path)
        XCTAssertEqual(first.options.partitionQuotas, second.options.partitionQuotas)
    }

    func testLifecycleCoalescesOpenAndReopensOnlyAfterInflightClose() {
        let store = FakeLifecycleStore()
        let lifecycle = ObservationFactStoreLifecycle(store: store)
        let first = configuration("first")
        let second = configuration("second")

        lifecycle.start(first)
        lifecycle.start(first)
        XCTAssertEqual(store.openCount, 1)

        lifecycle.stop()
        XCTAssertEqual(store.closeCount, 1)
        lifecycle.start(second)
        XCTAssertEqual(store.openCount, 1)

        store.completeOpen()
        XCTAssertEqual(store.openCount, 1)
        store.completeClose()
        XCTAssertEqual(store.openCount, 2)
        XCTAssertEqual(store.lastOptions?.directory, second.options.directory)
    }

    func testLowDiskProfileDisablesPersistenceWithoutAllocatingMinimumBudget() throws {
        let configuration = MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/profile-low-disk-lifecycle"),
            totalBytes: 3 * gib,
            availableBytes: 300 * mib
        )
        let store = SegmentedFactStore(maxQueuedRecords: 4)
        let lifecycle = ObservationFactStoreLifecycle(store: store)

        lifecycle.start(configuration)
        let status = try awaitStatus(lifecycle) { $0.lifecycleState == .disabled }

        XCTAssertTrue(status.desiredRunning)
        XCTAssertEqual(status.profile, "off-low-disk")
        XCTAssertEqual(status.disabledReason, "insufficient-space")
        XCTAssertEqual(status.store.state, .disabled)
        XCTAssertEqual(store.record(Data([1])), .disabled)
        lifecycle.stop()
    }

    func testLifecycleCreatesRealStoreAndExposesProfileStatus() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("ai-app-bridge-mobile-lifecycle-(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let configuration = MobileFactStoreProfiles.configuration(
            baseDirectory: base,
            totalBytes: 3 * gib,
            availableBytes: 1 * gib
        )
        let store = SegmentedFactStore(maxQueuedRecords: 8)
        let lifecycle = ObservationFactStoreLifecycle(store: store)

        lifecycle.start(configuration)
        var status = try awaitStatus(lifecycle) { $0.store.state == .open }
        XCTAssertTrue(status.desiredRunning)
        XCTAssertEqual(status.profile, "64mb")
        XCTAssertEqual(status.directory, configuration.options.directory.path)
        XCTAssertEqual(status.partitionQuotas.count, 8)

        let context = factContext()
        try [
            SanitizedFactPayload.event(
                context: context,
                category: "ui",
                name: "ui.changed",
                data: ["nodeCount": 1]
            ),
            SanitizedFactPayload.network(context: context, record: ["url": "https://example.test"]),
            SanitizedFactPayload.log(context: context, record: ["message": "ready"]),
            SanitizedFactPayload.state(context: context, record: ["key": "cart"])
        ].forEach(IOSObservationFactStoreRegistry.enqueue)
        status = try awaitStatus(lifecycle) { $0.store.writtenRecords == 4 }
        XCTAssertEqual(status.store.writtenRecords, 4)
        XCTAssertEqual(status.store.recordCount, 4)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: configuration.options.directory.appendingPathComponent(".sfs-manifest").path
        ))
        for partitionId in [0, 1, 2, 4] {
            let partitionFiles = try FileManager.default.contentsOfDirectory(
                at: configuration.options.directory.appendingPathComponent("partition-\(partitionId)"),
                includingPropertiesForKeys: nil
            )
            XCTAssertTrue(partitionFiles.contains { $0.pathExtension == "sfs" })
        }
        lifecycle.stop()
        status = try awaitStatus(lifecycle) { $0.store.state == .closed }
        XCTAssertFalse(status.desiredRunning)
        XCTAssertEqual(store.record(Data([1])), .closed)
    }

    private func configuration(_ name: String) -> MobileFactStoreConfiguration {
        MobileFactStoreProfiles.configuration(
            baseDirectory: URL(fileURLWithPath: "/tmp/\(name)"),
            totalBytes: 3 * gib,
            availableBytes: 1 * gib
        )
    }

    private func factContext() -> MobileFactEnvelopeContext {
        .init(
            platform: "ios",
            packageName: nil,
            bundleId: "com.example.app",
            model: "test",
            deviceIdentity: "sha256:test",
            runtimeEpoch: "runtime-test",
            actionId: nil,
            occurredAtMs: 100,
            observedAtMs: 100
        )
    }

    private func awaitStatus(
        _ lifecycle: ObservationFactStoreLifecycle,
        predicate: (ObservationFactStoreRuntimeStatus) -> Bool
    ) throws -> ObservationFactStoreRuntimeStatus {
        let deadline = Date().addingTimeInterval(5)
        var last: ObservationFactStoreRuntimeStatus?
        while Date() < deadline {
            let semaphore = DispatchSemaphore(value: 0)
            lifecycle.status {
                last = $0
                semaphore.signal()
            }
            XCTAssertEqual(semaphore.wait(timeout: .now() + 1), .success)
            if let last, predicate(last) { return last }
            Thread.sleep(forTimeInterval: 0.01)
        }
        throw NSError(
            domain: "ObservationFactStoreLifecycleTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "status did not reach expected state: \(String(describing: last))"]
        )
    }

    private final class FakeLifecycleStore: ObservationFactStore {
        var openCount = 0
        var closeCount = 0
        var lastOptions: SegmentedFactStoreOptions?
        private var openCompletions: [(SegmentedFactStoreOperationResult) -> Void] = []
        private var closeCompletions: [(SegmentedFactStoreOperationResult) -> Void] = []

        func open(
            _ options: SegmentedFactStoreOptions,
            completion: @escaping (SegmentedFactStoreOperationResult) -> Void
        ) {
            openCount += 1
            lastOptions = options
            openCompletions.append(completion)
        }

        func close(completion: @escaping (SegmentedFactStoreOperationResult) -> Void) {
            closeCount += 1
            closeCompletions.append(completion)
        }

        func status(completion: @escaping (SegmentedFactStoreStatus) -> Void) {
            completion(closedStatus())
        }

        func completeOpen() { openCompletions.removeFirst()(ok) }
        func completeClose() { closeCompletions.removeFirst()(ok) }

        private var ok: SegmentedFactStoreOperationResult { .init(code: 0) }
        private func closedStatus() -> SegmentedFactStoreStatus {
            .init(
                operation: ok,
                state: .closed,
                enabled: false,
                queuedRecords: 0,
                acceptedRecords: 0,
                writtenRecords: 0,
                droppedRecords: 0,
                formatVersion: 0,
                recoveredTail: false,
                segmentSizeBytes: 0,
                segmentCount: 0,
                firstSegmentId: 0,
                activeSegmentId: 0,
                activeWriteOffset: 0,
                recordCount: 0,
                payloadBytes: 0,
                nextSequence: 0,
                recoveryPartitionId: 0,
                recoverySegmentId: 0,
                recoveryOffset: 0,
                recoveryDiscardedBytes: 0
            )
        }
    }

    private let mib: UInt64 = 1024 * 1024
    private var gib: UInt64 { 1024 * mib }
}
