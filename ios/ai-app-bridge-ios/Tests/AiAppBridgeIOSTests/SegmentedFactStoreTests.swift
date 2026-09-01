import Darwin
import Foundation
import XCTest
@testable import AiAppBridgeIOS

@_silgen_name("flock")
private func aiAppBridgeTestFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

final class SegmentedFactStoreTests: XCTestCase {
    func testRecordOnlyEnqueuesAndNativeAppendRunsOnWriter() {
        let native = FakeNative()
        let store = makeStore(native)
        XCTAssertTrue(awaitOperation { store.open(options(), completion: $0) }.isSuccess)

        XCTAssertEqual(store.record(Data("fact".utf8)), .accepted)
        let status = awaitStatus(store)

        XCTAssertEqual(native.appendedPayloads, [Data("fact".utf8)])
        XCTAssertFalse(native.appendWasOnMainThread)
        XCTAssertEqual(status.acceptedRecords, 1)
        XCTAssertEqual(status.writtenRecords, 1)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testStatusReportsRecoveryAndStoreCanCloseThenReopen() {
        let native = FakeNative(recoveredTail: true)
        let store = makeStore(native)

        XCTAssertTrue(awaitOperation { store.open(options(), completion: $0) }.isSuccess)
        let recovered = awaitStatus(store)
        XCTAssertTrue(recovered.recoveredTail)
        XCTAssertEqual(recovered.recoveryDiscardedBytes, 12)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
        XCTAssertTrue(awaitOperation { store.open(options(), completion: $0) }.isSuccess)
        XCTAssertEqual(native.openCount, 2)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testGroupFlushBoundsDurabilityWindowByRecordCount() {
        let native = FakeNative()
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "fact-store-group-flush-test"),
            maxQueuedRecords: 4,
            flushIntervalSeconds: 60,
            maxUnflushedRecords: 2
        )
        XCTAssertTrue(awaitOperation { store.open(options(), completion: $0) }.isSuccess)

        XCTAssertEqual(store.record(Data("one".utf8)), .accepted)
        XCTAssertEqual(store.record(Data("two".utf8)), .accepted)
        _ = awaitStatus(store)

        XCTAssertEqual(native.flushCount, 1)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
        XCTAssertEqual(native.flushCount, 1)
    }

    func testGroupFlushBoundsDurabilityWindowByElapsedTime() {
        let native = FakeNative()
        let flushed = expectation(description: "timed group flush")
        native.onFlush = { flushed.fulfill() }
        let store = SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "fact-store-timed-flush-test"),
            maxQueuedRecords: 4,
            flushIntervalSeconds: 0.02,
            maxUnflushedRecords: 100
        )
        XCTAssertTrue(awaitOperation { store.open(options(), completion: $0) }.isSuccess)

        XCTAssertEqual(store.record(Data("one".utf8)), .accepted)

        wait(for: [flushed], timeout: 1)
        XCTAssertEqual(native.flushCount, 1)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testDisabledStoreDoesNotLoadNativeOrAcceptFacts() {
        let native = FakeNative()
        var factoryCalls = 0
        let store = SegmentedFactStore(
            nativeFactory: {
                factoryCalls += 1
                return native
            },
            writer: DispatchQueue(label: "fact-store-test"),
            maxQueuedRecords: 4
        )

        XCTAssertTrue(awaitOperation {
            store.open(options(enabled: false), completion: $0)
        }.isSuccess)
        XCTAssertEqual(store.record(Data([1])), .disabled)
        let status = awaitStatus(store)
        XCTAssertEqual(status.state, .disabled)
        XCTAssertFalse(status.enabled)
        XCTAssertEqual(factoryCalls, 0)
        XCTAssertEqual(native.openCount, 0)
    }

    func testOversizedPayloadIsRejectedBeforeQueueAndDoesNotBlockFollowingFact() {
        let native = FakeNative()
        let store = makeStore(native)
        XCTAssertTrue(awaitOperation { store.open(options(), completion: $0) }.isSuccess)

        XCTAssertEqual(
            store.record(Data(count: SegmentedFactStore.maxPersistedPayloadBytes + 1)),
            .payloadTooLarge
        )
        XCTAssertEqual(store.record(Data("following".utf8)), .accepted)
        let status = awaitStatus(store)

        XCTAssertEqual(native.appendedPayloads, [Data("following".utf8)])
        XCTAssertEqual(status.acceptedRecords, 1)
        XCTAssertEqual(status.writtenRecords, 1)
        XCTAssertEqual(status.droppedRecords, 1)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testPortableCAdapterPersistsAndReadsAcrossReopen() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ai-app-bridge-sfs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        let first = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation { first.open(options, completion: $0) }.isSuccess)
        XCTAssertEqual(first.record(Data([0x61, 0x00, 0x62]), durability: .sync), .accepted)
        _ = awaitStatus(first)
        XCTAssertTrue(awaitOperation { first.close(completion: $0) }.isSuccess)

        let reopened = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation { reopened.open(options, completion: $0) }.isSuccess)
        let read = awaitRead(reopened, cursor: .init())
        XCTAssertEqual(read.record?.payload, Data([0x61, 0x00, 0x62]))
        XCTAssertEqual(read.record?.sequence, 1)
        XCTAssertTrue(awaitOperation { reopened.close(completion: $0) }.isSuccess)
    }

    func testSixHundredKibUiTreeIsOneLogicalMappedFactAcrossReopenAndChunksNeverPage() throws {
        let directory = temporaryDirectory("large-fact")
        defer { try? FileManager.default.removeItem(at: directory) }
        let segmentSize: UInt64 = 512 * 1024
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: segmentSize,
            partitionQuotas: [0, 4 * segmentSize],
            receiveObservationFacts: false
        )
        let payload = try largeUiTreeFact(treeBytes: 600 * 1024)

        let first = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation { first.open(options, completion: $0) }.isSuccess)
        XCTAssertEqual(first.record(payload, partitionId: 1, durability: .sync), .accepted)
        let written = awaitStatus(first)
        XCTAssertEqual(written.acceptedRecords, 1)
        XCTAssertEqual(written.writtenRecords, 1)
        XCTAssertEqual(written.droppedRecords, 0)

        let tooSmall = awaitRead(first, cursor: .init(), bufferCapacity: 64 * 1024)
        XCTAssertEqual(tooSmall.operation.code, SegmentedFactStoreResultCode.bufferTooSmall)
        XCTAssertEqual(tooSmall.requiredCapacity, payload.count)
        XCTAssertNil(tooSmall.record)

        let immediate = awaitRead(first, cursor: .init(), bufferCapacity: payload.count)
        XCTAssertEqual(immediate.record?.payload, payload)
        XCTAssertEqual(immediate.record?.partitionId, 1)
        XCTAssertEqual(immediate.record?.sequence, immediate.cursor.afterSequence)
        XCTAssertTrue(awaitRead(first, cursor: immediate.cursor, bufferCapacity: payload.count).isEnd)
        XCTAssertTrue(awaitOperation { first.close(completion: $0) }.isSuccess)

        let reopened = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation { reopened.open(options, completion: $0) }.isSuccess)
        let afterReopen = awaitRead(reopened, cursor: .init(), bufferCapacity: payload.count)
        XCTAssertEqual(afterReopen.record?.payload, payload)
        XCTAssertTrue(awaitRead(reopened, cursor: afterReopen.cursor, bufferCapacity: payload.count).isEnd)
        XCTAssertTrue(awaitOperation { reopened.close(completion: $0) }.isSuccess)
    }

    func testEvictedLargeFactChunkReturnsCorruptAndNeverReturnsPartialPayload() throws {
        let directory = temporaryDirectory("large-fact-missing-chunk")
        defer { try? FileManager.default.removeItem(at: directory) }
        let segmentSize: UInt64 = 512 * 1024
        let options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: segmentSize,
            partitionQuotas: [0, 2 * segmentSize],
            receiveObservationFacts: false
        )
        let payload = try largeUiTreeFact(treeBytes: 600 * 1024)
        let store = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation { store.open(options, completion: $0) }.isSuccess)
        XCTAssertEqual(store.record(payload, partitionId: 1, durability: .sync), .accepted)
        _ = awaitStatus(store)
        XCTAssertEqual(
            store.record(Data(repeating: 7, count: 450 * 1024), partitionId: 1, durability: .sync),
            .accepted
        )
        _ = awaitStatus(store)

        let read = awaitRead(store, cursor: .init(), bufferCapacity: payload.count)
        XCTAssertEqual(read.operation.code, SegmentedFactStoreResultCode.corrupt)
        XCTAssertNil(read.record)
        XCTAssertEqual(read.cursor, SegmentedFactStoreCursor())
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testImpossibleLargeFactIsRejectedBeforeAcceptedInsteadOfAsyncDrop() throws {
        let directory = temporaryDirectory("large-fact-preflight")
        defer { try? FileManager.default.removeItem(at: directory) }
        let segmentSize: UInt64 = 512 * 1024
        let store = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation {
            store.open(
                .init(
                    directory: directory,
                    segmentSizeBytes: segmentSize,
                    partitionQuotas: [0, segmentSize],
                    receiveObservationFacts: false
                ),
                completion: $0
            )
        }.isSuccess)

        XCTAssertEqual(
            store.record(try largeUiTreeFact(treeBytes: 600 * 1024), partitionId: 1),
            .payloadTooLarge
        )
        let status = awaitStatus(store)
        XCTAssertEqual(status.acceptedRecords, 0)
        XCTAssertEqual(status.writtenRecords, 0)
        XCTAssertEqual(status.droppedRecords, 1)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testReopenWildcardsUsePersistedGeometryForLargeFactPreflight() throws {
        let directory = temporaryDirectory("large-fact-reopen-geometry")
        defer { try? FileManager.default.removeItem(at: directory) }
        let segmentSize: UInt64 = 512 * 1024
        let persisted = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: segmentSize,
            partitionQuotas: [0, 4 * segmentSize],
            receiveObservationFacts: false
        )
        let payload = try largeUiTreeFact(treeBytes: 600 * 1024)
        let creator = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation { creator.open(persisted, completion: $0) }.isSuccess)
        XCTAssertTrue(awaitOperation { creator.close(completion: $0) }.isSuccess)

        let reopened = SegmentedFactStore(maxQueuedRecords: 4)
        var wildcard = persisted
        wildcard.segmentSizeBytes = 0
        wildcard.partitionQuotas = [0, 0]
        XCTAssertTrue(awaitOperation { reopened.open(wildcard, completion: $0) }.isSuccess)
        XCTAssertEqual(reopened.record(payload, partitionId: 1, durability: .sync), .accepted)
        let written = awaitStatus(reopened)
        XCTAssertEqual(written.writtenRecords, 1)
        XCTAssertEqual(written.droppedRecords, 0)
        XCTAssertEqual(
            awaitRead(reopened, cursor: .init(), bufferCapacity: payload.count).record?.payload,
            payload
        )
        XCTAssertTrue(awaitOperation { reopened.close(completion: $0) }.isSuccess)
    }

    func testNonAlignedSegmentAndNonMultipleQuotaUseNativeFrameGeometry() throws {
        let directory = temporaryDirectory("large-fact-frame-geometry")
        defer { try? FileManager.default.removeItem(at: directory) }
        let segmentSize: UInt64 = 512 * 1024 + 1
        let payload = try largeUiTreeFact(treeBytes: 600 * 1024)
        let store = SegmentedFactStore(maxQueuedRecords: 4)
        XCTAssertTrue(awaitOperation {
            store.open(
                .init(
                    directory: directory,
                    segmentSizeBytes: segmentSize,
                    partitionQuotas: [0, 2 * segmentSize + segmentSize / 2],
                    receiveObservationFacts: false
                ),
                completion: $0
            )
        }.isSuccess)
        XCTAssertEqual(store.record(payload, partitionId: 1, durability: .sync), .accepted)
        let written = awaitStatus(store)
        XCTAssertEqual(written.writtenRecords, 1)
        XCTAssertEqual(written.droppedRecords, 0)
        XCTAssertEqual(
            awaitRead(store, cursor: .init(), bufferCapacity: payload.count).record?.payload,
            payload
        )
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testLargeFactWireReadsSharedGoldenAndWritesExactBinaryHeaderWithoutBase64() throws {
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: largeFactGolden())) as? [String: Any]
        )
        let fixture = try XCTUnwrap(root["fixture"] as? [String: Any])
        let payload = Data(try XCTUnwrap(fixture["payloadUtf8"] as? String).utf8)
        let expectedDigest = try XCTUnwrap(fixture["sha256Hex"] as? String)

        let digest = LargeFactWire.sha256(payload)
        let encoded = try LargeFactWire.encodeChunk(
            digest: digest,
            ordinal: 0,
            chunkCount: 1,
            totalLength: payload.count,
            bytes: payload
        )
        let decoded = try LargeFactWire.decodeChunk(encoded)

        XCTAssertEqual(LargeFactWire.hex(digest), expectedDigest)
        XCTAssertEqual(LargeFactWire.hex(encoded.prefix(72)), fixture["chunkHeaderHex"] as? String)
        XCTAssertEqual(decoded.ordinal, 0)
        XCTAssertEqual(decoded.chunkCount, 1)
        XCTAssertEqual(decoded.totalLength, payload.count)
        XCTAssertEqual(decoded.bytes, payload)
        var corrupt = encoded
        corrupt[68] = 1
        XCTAssertThrowsError(try LargeFactWire.decodeChunk(corrupt))

        let manifest = try LargeFactWire.encodeManifest(
            index: LargeFactWire.extractIndex(payload),
            digest: digest,
            byteLength: payload.count,
            chunks: [
                .init(
                    ordinal: 0,
                    sequence: 41,
                    segmentId: 7,
                    frameOffset: 64,
                    payloadLength: encoded.count,
                    byteLength: payload.count
                )
            ]
        )
        let actualManifest = try XCTUnwrap(
            JSONSerialization.jsonObject(with: manifest) as? NSDictionary
        )
        let expectedManifest = try XCTUnwrap(fixture["manifest"] as? NSDictionary)
        XCTAssertEqual(actualManifest, expectedManifest)
        let goldenManifest = try JSONSerialization.data(withJSONObject: expectedManifest)
        let parsedManifest = try XCTUnwrap(
            LargeFactWire.decodeManifest(goldenManifest, manifestSequence: 42)
        )
        XCTAssertEqual(parsedManifest.byteLength, payload.count)
        XCTAssertEqual(parsedManifest.chunks.count, 1)
        XCTAssertEqual(parsedManifest.chunks.first?.sequence, 41)
        XCTAssertEqual(LargeFactWire.hex(parsedManifest.digest), expectedDigest)
    }

    func testManagedProfileOpenCleansOnlyInactiveAllowlistedProfiles() throws {
        let base = temporaryDirectory("profile-clean")
        defer { try? FileManager.default.removeItem(at: base) }
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        for name in ["1gb", "512mb", "256mb", "off-low-disk", "unrelated"] {
            let directory = base.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data(repeating: 0x41, count: 128).write(
                to: directory.appendingPathComponent("payload.bin")
            )
        }
        let configuration = MobileFactStoreProfiles.configuration(
            baseDirectory: base,
            totalBytes: 3 * 1024 * 1024 * 1024,
            availableBytes: 1024 * 1024 * 1024
        )
        XCTAssertEqual(configuration.profile, "64mb")
        let store = makeStore(FakeNative())

        XCTAssertTrue(awaitOperation {
            store.open(configuration.options, completion: $0)
        }.isSuccess)
        let status = awaitStatus(store)

        for name in ["1gb", "512mb", "256mb", "off-low-disk"] {
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: base.appendingPathComponent(name).path
            ))
        }
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: base.appendingPathComponent("64mb").path
        ))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: base.appendingPathComponent("unrelated/payload.bin").path
        ))
        XCTAssertFalse(status.cleanupPending)
        XCTAssertEqual(status.inactiveBytes, 0)
        XCTAssertNil(status.cleanupError)
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testFailedManagedOpenDoesNotDeleteAnyProfile() throws {
        let base = temporaryDirectory("profile-open-failure")
        defer { try? FileManager.default.removeItem(at: base) }
        let inactiveDirectory = base.appendingPathComponent("512mb", isDirectory: true)
        try FileManager.default.createDirectory(
            at: inactiveDirectory,
            withIntermediateDirectories: true
        )
        try Data("keep".utf8).write(
            to: inactiveDirectory.appendingPathComponent("payload.bin")
        )
        let configuration = MobileFactStoreProfiles.configuration(
            baseDirectory: base,
            totalBytes: 3 * 1024 * 1024 * 1024,
            availableBytes: 1024 * 1024 * 1024
        )
        let store = makeStore(FakeNative(openCode: SegmentedFactStoreResultCode.io))

        XCTAssertFalse(awaitOperation {
            store.open(configuration.options, completion: $0)
        }.isSuccess)
        let status = awaitStatus(store)

        XCTAssertEqual(status.state, .failed)
        XCTAssertFalse(status.cleanupPending)
        XCTAssertEqual(status.inactiveBytes, 0)
        XCTAssertNil(status.cleanupError)
        XCTAssertEqual(
            try Data(contentsOf: inactiveDirectory.appendingPathComponent("payload.bin")),
            Data("keep".utf8)
        )
    }

    func testBusyInactiveProfileIsReportedThenRetriedAfterItsWriterCloses() throws {
        let base = temporaryDirectory("profile-busy")
        defer { try? FileManager.default.removeItem(at: base) }
        let inactiveDirectory = base.appendingPathComponent("512mb", isDirectory: true)
        let blockingStore = SegmentedFactStore(maxQueuedRecords: 4)
        let blockingOptions = SegmentedFactStoreOptions(
            directory: inactiveDirectory,
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            receiveObservationFacts: false
        )
        XCTAssertTrue(awaitOperation {
            blockingStore.open(blockingOptions, completion: $0)
        }.isSuccess)

        let activeConfiguration = MobileFactStoreProfiles.configuration(
            baseDirectory: base,
            totalBytes: 3 * 1024 * 1024 * 1024,
            availableBytes: 1024 * 1024 * 1024
        )
        let activeStore = makeStore(FakeNative())
        XCTAssertTrue(awaitOperation {
            activeStore.open(activeConfiguration.options, completion: $0)
        }.isSuccess)

        var status = awaitStatus(activeStore)
        XCTAssertTrue(status.cleanupPending)
        XCTAssertGreaterThan(status.inactiveBytes, 0)
        XCTAssertTrue(status.cleanupError?.contains("512mb: profile_lock_busy") == true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: inactiveDirectory.path))

        XCTAssertTrue(awaitOperation { blockingStore.close(completion: $0) }.isSuccess)
        status = awaitStatus(activeStore)
        XCTAssertFalse(status.cleanupPending)
        XCTAssertEqual(status.inactiveBytes, 0)
        XCTAssertNil(status.cleanupError)
        XCTAssertFalse(FileManager.default.fileExists(atPath: inactiveDirectory.path))
        XCTAssertTrue(awaitOperation { activeStore.close(completion: $0) }.isSuccess)
    }

    func testBusyBaseMaintenanceLockDefersAllDeletionUntilStatusRetry() throws {
        let base = temporaryDirectory("profile-maintenance-busy")
        defer { try? FileManager.default.removeItem(at: base) }
        let inactiveDirectory = base.appendingPathComponent("512mb", isDirectory: true)
        try FileManager.default.createDirectory(
            at: inactiveDirectory,
            withIntermediateDirectories: true
        )
        try Data(repeating: 0x43, count: 128).write(
            to: inactiveDirectory.appendingPathComponent("payload.bin")
        )
        let maintenanceLock = base.appendingPathComponent(".profile-maintenance.lock").path
            .withCString {
                Darwin.open(
                    $0,
                    O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
                    S_IRUSR | S_IWUSR
                )
            }
        XCTAssertGreaterThanOrEqual(maintenanceLock, 0)
        XCTAssertEqual(aiAppBridgeTestFlock(maintenanceLock, LOCK_EX | LOCK_NB), 0)
        var lockHeld = true
        defer {
            if lockHeld { _ = aiAppBridgeTestFlock(maintenanceLock, LOCK_UN) }
            _ = Darwin.close(maintenanceLock)
        }

        let configuration = MobileFactStoreProfiles.configuration(
            baseDirectory: base,
            totalBytes: 3 * 1024 * 1024 * 1024,
            availableBytes: 1024 * 1024 * 1024
        )
        let store = makeStore(FakeNative())
        XCTAssertTrue(awaitOperation {
            store.open(configuration.options, completion: $0)
        }.isSuccess)

        var status = awaitStatus(store)
        XCTAssertTrue(status.cleanupPending)
        XCTAssertGreaterThan(status.inactiveBytes, 0)
        XCTAssertTrue(status.cleanupError?.contains("maintenance_lock_busy") == true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: inactiveDirectory.path))

        XCTAssertEqual(aiAppBridgeTestFlock(maintenanceLock, LOCK_UN), 0)
        lockHeld = false
        status = awaitStatus(store)
        XCTAssertFalse(status.cleanupPending)
        XCTAssertEqual(status.inactiveBytes, 0)
        XCTAssertNil(status.cleanupError)
        XCTAssertFalse(FileManager.default.fileExists(atPath: inactiveDirectory.path))
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    func testLowDiskProfileCleansDataProfilesAsynchronouslyWithoutLoadingNative() throws {
        let base = temporaryDirectory("profile-low-disk-clean")
        defer { try? FileManager.default.removeItem(at: base) }
        let inactiveDirectory = base.appendingPathComponent("1gb", isDirectory: true)
        try FileManager.default.createDirectory(
            at: inactiveDirectory,
            withIntermediateDirectories: true
        )
        try Data(repeating: 0x42, count: 128).write(
            to: inactiveDirectory.appendingPathComponent("payload.bin")
        )
        let configuration = MobileFactStoreProfiles.configuration(
            baseDirectory: base,
            totalBytes: 3 * 1024 * 1024 * 1024,
            availableBytes: 300 * 1024 * 1024
        )
        XCTAssertEqual(configuration.profile, "off-low-disk")
        var factoryCalls = 0
        let store = SegmentedFactStore(
            nativeFactory: {
                factoryCalls += 1
                return FakeNative()
            },
            writer: DispatchQueue(label: "fact-store-low-disk-clean-test"),
            maxQueuedRecords: 4
        )
        var completionWasOnMainThread = true

        let result = awaitOperation { completion in
            store.open(configuration.options) {
                completionWasOnMainThread = Thread.isMainThread
                completion($0)
            }
        }
        let status = awaitStatus(store)

        XCTAssertTrue(result.isSuccess)
        XCTAssertFalse(completionWasOnMainThread)
        XCTAssertEqual(factoryCalls, 0)
        XCTAssertEqual(status.state, .disabled)
        XCTAssertFalse(status.cleanupPending)
        XCTAssertEqual(status.inactiveBytes, 0)
        XCTAssertNil(status.cleanupError)
        XCTAssertFalse(FileManager.default.fileExists(atPath: inactiveDirectory.path))
    }

    func testProfileSymlinkIsNeverFollowedOrDeleted() throws {
        let base = temporaryDirectory("profile-symlink")
        let outside = temporaryDirectory("profile-symlink-outside")
        defer {
            try? FileManager.default.removeItem(at: base)
            try? FileManager.default.removeItem(at: outside)
        }
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let sentinel = outside.appendingPathComponent("sentinel.txt")
        try Data("keep".utf8).write(to: sentinel)
        let symlink = base.appendingPathComponent("512mb", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
        let configuration = MobileFactStoreProfiles.configuration(
            baseDirectory: base,
            totalBytes: 3 * 1024 * 1024 * 1024,
            availableBytes: 1024 * 1024 * 1024
        )
        let store = makeStore(FakeNative())

        XCTAssertTrue(awaitOperation {
            store.open(configuration.options, completion: $0)
        }.isSuccess)
        let status = awaitStatus(store)

        XCTAssertTrue(status.cleanupPending)
        XCTAssertTrue(status.cleanupError?.contains("512mb: profile_is_symlink") == true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: symlink.path))
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("keep".utf8))
        XCTAssertTrue(awaitOperation { store.close(completion: $0) }.isSuccess)
    }

    private func makeStore(_ native: FakeNative) -> SegmentedFactStore {
        SegmentedFactStore(
            nativeFactory: { native },
            writer: DispatchQueue(label: "fact-store-test"),
            maxQueuedRecords: 4
        )
    }

    private func temporaryDirectory(_ label: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(
            "ai-app-bridge-\(label)-\(UUID().uuidString)",
            isDirectory: true
        )
    }

    private func options(enabled: Bool = true) -> SegmentedFactStoreOptions {
        .init(
            directory: FileManager.default.temporaryDirectory.appendingPathComponent("unused"),
            segmentSizeBytes: 256,
            partitionQuotas: [1024],
            enabled: enabled,
            receiveObservationFacts: false
        )
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
        wait(for: [expectation], timeout: 5)
        return result
    }

    private func awaitStatus(_ store: SegmentedFactStore) -> SegmentedFactStoreStatus {
        let expectation = expectation(description: "status")
        var result: SegmentedFactStoreStatus?
        store.status {
            result = $0
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 5)
        return try! XCTUnwrap(result)
    }

    private func awaitRead(
        _ store: SegmentedFactStore,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int = 64 * 1024
    ) -> SegmentedFactStoreReadResult {
        let expectation = expectation(description: "read")
        var result: SegmentedFactStoreReadResult?
        store.read(cursor: cursor, bufferCapacity: bufferCapacity) {
            result = $0
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 5)
        return try! XCTUnwrap(result)
    }

    private func largeUiTreeFact(treeBytes: Int) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "partition": "ui",
            "targetKey": "ios:golden:com.example",
            "app": ["platform": "ios", "bundleId": "com.example"],
            "runtimeEpoch": "runtime-large-tree",
            "actionId": NSNull(),
            "dedupeKey": NSNull(),
            "timestamps": [
                "occurredAtMs": 1,
                "observedAtMs": 2,
                "ingestedAtMs": 3
            ],
            "payload": [
                "kind": "evidence",
                "stream": "uia-tree",
                "record": ["value": String(repeating: "x", count: treeBytes)]
            ]
        ])
    }

    private func largeFactGolden() -> URL {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<4 { root.deleteLastPathComponent() }
        return root.appendingPathComponent("native/segmented-fact-store/tests/golden/large-fact-v1.json")
    }

    private final class FakeNative: SegmentedFactStoreNative {
        let recoveredTail: Bool
        let openCode: Int32
        var openCount = 0
        var appendWasOnMainThread = true
        var appendedPayloads: [Data] = []
        var flushCount = 0
        var onFlush: (() -> Void)?

        init(
            recoveredTail: Bool = false,
            openCode: Int32 = SegmentedFactStoreResultCode.ok
        ) {
            self.recoveredTail = recoveredTail
            self.openCode = openCode
        }

        func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult {
            openCount += 1
            return .init(
                operation: .init(code: openCode),
                handle: openCode == SegmentedFactStoreResultCode.ok ? UInt64(openCount) : 0
            )
        }

        func append(
            handle: UInt64,
            partitionId: UInt32,
            payload: Data,
            durability: SegmentedFactStoreDurability
        ) -> NativeAppendResult {
            appendWasOnMainThread = Thread.isMainThread
            appendedPayloads.append(payload)
            return .init(operation: ok, sequence: UInt64(appendedPayloads.count))
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
                recoveredTail: recoveredTail,
                segmentSizeBytes: 256,
                segmentCount: 1,
                firstSegmentId: 1,
                activeSegmentId: 1,
                activeWriteOffset: 64,
                recordCount: UInt64(appendedPayloads.count),
                payloadBytes: UInt64(appendedPayloads.reduce(0) { $0 + $1.count }),
                nextSequence: UInt64(appendedPayloads.count + 1),
                recoveryPartitionId: recoveredTail ? 0 : UInt32.max,
                recoverySegmentId: recoveredTail ? 1 : 0,
                recoveryOffset: recoveredTail ? 80 : 0,
                recoveryDiscardedBytes: recoveredTail ? 12 : 0
            )
        }

        func flush(handle: UInt64) -> SegmentedFactStoreOperationResult {
            flushCount += 1
            onFlush?()
            return ok
        }
        func close(handle: UInt64) -> SegmentedFactStoreOperationResult { ok }

        private var ok: SegmentedFactStoreOperationResult {
            .init(code: SegmentedFactStoreResultCode.ok)
        }
    }
}
