#if canImport(AiAppBridgeFactStoreC)
import AiAppBridgeFactStoreC
#endif
import CryptoKit
import Darwin
import Foundation

@_silgen_name("flock")
private func aiAppBridgeFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

internal enum SegmentedFactStoreResultCode {
    internal static let ok: Int32 = 0
    internal static let end: Int32 = 1
    internal static let bufferTooSmall: Int32 = 2
    internal static let invalidArgument: Int32 = -1
    internal static let io: Int32 = -2
    internal static let corrupt: Int32 = -4
    internal static let closed: Int32 = -8
}

internal enum SegmentedFactStoreDurability: Int32, Sendable {
    case memory = 0
    case sync = 1
}

internal enum SegmentedFactStoreState: Equatable, Sendable {
    case closed
    case disabled
    case opening
    case open
    case closing
    case failed
}

internal enum SegmentedFactRecordEnqueueResult: Equatable, Sendable {
    case accepted
    case disabled
    case closed
    case queueFull
    case payloadTooLarge
}

internal struct SegmentedFactStoreOptions: Sendable {
    internal var directory: URL
    internal var segmentSizeBytes: UInt64
    internal var flags: UInt32
    internal var partitionQuotas: [UInt64]
    internal var enabled: Bool
    internal var receiveObservationFacts: Bool
    var profileMaintenance: SegmentedFactStoreProfileMaintenance?

    internal init(
        directory: URL,
        segmentSizeBytes: UInt64 = 1024 * 1024,
        flags: UInt32 = 1,
        partitionQuotas: [UInt64] = [8 * 1024 * 1024],
        enabled: Bool = true,
        receiveObservationFacts: Bool = true
    ) {
        self.directory = directory
        self.segmentSizeBytes = segmentSizeBytes
        self.flags = flags
        self.partitionQuotas = partitionQuotas
        self.enabled = enabled
        self.receiveObservationFacts = receiveObservationFacts
        self.profileMaintenance = nil
    }
}

internal struct SegmentedFactStoreCursor: Equatable, Sendable {
    internal var partitionId: UInt32
    internal var flags: UInt32
    internal var afterSequence: UInt64
    internal var segmentId: UInt64
    internal var offset: UInt64

    internal init(
        partitionId: UInt32 = UInt32.max,
        flags: UInt32 = 0,
        afterSequence: UInt64 = 0,
        segmentId: UInt64 = 0,
        offset: UInt64 = 0
    ) {
        self.partitionId = partitionId
        self.flags = flags
        self.afterSequence = afterSequence
        self.segmentId = segmentId
        self.offset = offset
    }
}

internal struct SegmentedFactStoreRecord: Sendable {
    internal let payload: Data
    internal let partitionId: UInt32
    internal let flags: UInt32
    internal let sequence: UInt64
    internal let segmentId: UInt64
    internal let frameOffset: UInt64
    internal let gapFirstSequence: UInt64
    internal let gapLastSequence: UInt64
}

internal struct SegmentedFactStoreOperationResult: Equatable, Sendable {
    internal let code: Int32
    internal let systemCode: Int32
    internal let message: String

    internal init(code: Int32, systemCode: Int32 = 0, message: String = "") {
        self.code = code
        self.systemCode = systemCode
        self.message = message
    }

    internal var isSuccess: Bool { code == SegmentedFactStoreResultCode.ok }
}

internal struct SegmentedFactStoreReadResult: Sendable {
    internal let operation: SegmentedFactStoreOperationResult
    internal let cursor: SegmentedFactStoreCursor
    internal let record: SegmentedFactStoreRecord?
    internal let requiredCapacity: Int

    internal var isEnd: Bool { operation.code == SegmentedFactStoreResultCode.end }
}

internal struct SegmentedFactStoreStatus: Sendable {
    internal var operation: SegmentedFactStoreOperationResult
    internal var state: SegmentedFactStoreState
    internal var enabled: Bool
    internal var queuedRecords: Int
    internal var acceptedRecords: UInt64
    internal var writtenRecords: UInt64
    internal var droppedRecords: UInt64
    internal var formatVersion: UInt32
    internal var recoveredTail: Bool
    internal var segmentSizeBytes: UInt64
    internal var segmentCount: UInt64
    internal var firstSegmentId: UInt64
    internal var activeSegmentId: UInt64
    internal var activeWriteOffset: UInt64
    internal var recordCount: UInt64
    internal var payloadBytes: UInt64
    internal var nextSequence: UInt64
    internal var recoveryPartitionId: UInt32
    internal var recoverySegmentId: UInt64
    internal var recoveryOffset: UInt64
    internal var recoveryDiscardedBytes: UInt64
    internal var cleanupPending: Bool = false
    internal var inactiveBytes: UInt64 = 0
    internal var cleanupError: String? = nil
    internal var partitionQuotas: [UInt64] = []
}

struct SegmentedFactStoreProfileMaintenance: Sendable {
    let baseDirectory: URL
    let activeProfile: String
    let activeDirectory: URL
}

private struct SegmentedFactStoreProfileMaintenanceResult {
    let cleanupPending: Bool
    let inactiveBytes: UInt64
    let error: String?
}

private enum SegmentedFactStoreProfileJanitor {
    private static let allowedProfiles = ["1gb", "512mb", "256mb", "64mb", "off-low-disk"]
    private static let maintenanceLockName = ".profile-maintenance.lock"
    private static let storeLockName = ".sfs-lock"
    private static let resourceKeys: Set<URLResourceKey> = [
        .isDirectoryKey,
        .isRegularFileKey,
        .isSymbolicLinkKey,
        .fileSizeKey,
        .fileAllocatedSizeKey,
        .totalFileAllocatedSizeKey
    ]

    static func cleanInactiveProfiles(
        _ maintenance: SegmentedFactStoreProfileMaintenance,
        fileManager: FileManager = .default
    ) -> SegmentedFactStoreProfileMaintenanceResult {
        let base = maintenance.baseDirectory.standardizedFileURL
        let active = maintenance.activeDirectory.standardizedFileURL
        guard allowedProfiles.contains(maintenance.activeProfile),
              active.path == base
                .appendingPathComponent(maintenance.activeProfile, isDirectory: true)
                .standardizedFileURL.path else {
            return pendingResult(
                inactiveURLs: [],
                fileManager: fileManager,
                errors: ["invalid_profile_maintenance_scope"]
            )
        }

        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: base.path, isDirectory: &isDirectory) else {
            return .init(cleanupPending: false, inactiveBytes: 0, error: nil)
        }
        guard isDirectory.boolValue else {
            return .init(
                cleanupPending: true,
                inactiveBytes: 0,
                error: "profile_base_not_directory"
            )
        }
        do {
            let values = try base.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values.isSymbolicLink != true else {
                return .init(
                    cleanupPending: true,
                    inactiveBytes: 0,
                    error: "profile_base_is_symlink"
                )
            }
        } catch {
            return .init(
                cleanupPending: true,
                inactiveBytes: 0,
                error: "profile_base_inspection_failed: \(error)"
            )
        }

        let inactiveURLs: [URL]
        do {
            inactiveURLs = try fileManager.contentsOfDirectory(
                at: base,
                includingPropertiesForKeys: Array(resourceKeys),
                options: []
            ).filter {
                allowedProfiles.contains($0.lastPathComponent)
                    && $0.lastPathComponent != maintenance.activeProfile
            }
        } catch {
            return .init(
                cleanupPending: true,
                inactiveBytes: 0,
                error: "profile_base_scan_failed: \(error)"
            )
        }
        guard !inactiveURLs.isEmpty else {
            return .init(cleanupPending: false, inactiveBytes: 0, error: nil)
        }

        let baseLockURL = base.appendingPathComponent(maintenanceLockName, isDirectory: false)
        let baseLock: Int32
        switch acquireNonblockingLock(at: baseLockURL) {
        case let .acquired(descriptor):
            baseLock = descriptor
        case let .busy(message), let .failed(message):
            return pendingResult(
                inactiveURLs: inactiveURLs,
                fileManager: fileManager,
                errors: [message == "profile_lock_busy" ? "maintenance_lock_busy" : "maintenance_\(message)"]
            )
        }
        defer { releaseLock(baseLock) }

        var errors: [String] = []
        for inactiveURL in inactiveURLs {
            let name = inactiveURL.lastPathComponent
            let exactURL = base.appendingPathComponent(name, isDirectory: true).standardizedFileURL
            guard inactiveURL.standardizedFileURL.path == exactURL.path else {
                errors.append("\(name): invalid_profile_path")
                continue
            }
            do {
                let values = try inactiveURL.resourceValues(forKeys: [
                    .isDirectoryKey,
                    .isSymbolicLinkKey
                ])
                guard values.isSymbolicLink != true else {
                    errors.append("\(name): profile_is_symlink")
                    continue
                }
                guard values.isDirectory == true else {
                    errors.append("\(name): profile_not_directory")
                    continue
                }
            } catch {
                errors.append("\(name): profile_inspection_failed: \(error)")
                continue
            }

            let storeLockURL = inactiveURL.appendingPathComponent(storeLockName, isDirectory: false)
            switch acquireNonblockingLock(at: storeLockURL) {
            case let .acquired(storeLock):
                defer { releaseLock(storeLock) }
                do {
                    try fileManager.removeItem(at: inactiveURL)
                } catch {
                    errors.append("\(name): profile_delete_failed: \(error)")
                }
            case let .busy(message), let .failed(message):
                errors.append("\(name): \(message)")
            }
        }

        let remaining: [URL]
        do {
            remaining = try fileManager.contentsOfDirectory(
                at: base,
                includingPropertiesForKeys: Array(resourceKeys),
                options: []
            ).filter {
                allowedProfiles.contains($0.lastPathComponent)
                    && $0.lastPathComponent != maintenance.activeProfile
            }
        } catch {
            return .init(
                cleanupPending: true,
                inactiveBytes: inactiveURLs.reduce(0) {
                    saturatingAdd($0, allocatedBytes(at: $1, fileManager: fileManager).bytes)
                },
                error: (errors + ["profile_rescan_failed: \(error)"]).joined(separator: "; ")
            )
        }
        return pendingResult(
            inactiveURLs: remaining,
            fileManager: fileManager,
            errors: errors
        )
    }

    private enum LockAttempt {
        case acquired(Int32)
        case busy(String)
        case failed(String)
    }

    private static func acquireNonblockingLock(at url: URL) -> LockAttempt {
        let descriptor = url.path.withCString {
            Darwin.open(
                $0,
                O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
                S_IRUSR | S_IWUSR
            )
        }
        guard descriptor >= 0 else {
            let code = errno
            return .failed("lock_open_failed(\(code)): \(errorMessage(code))")
        }
        guard aiAppBridgeFlock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            Darwin.close(descriptor)
            if code == EWOULDBLOCK || code == EAGAIN {
                return .busy("profile_lock_busy")
            }
            return .failed("lock_failed(\(code)): \(errorMessage(code))")
        }
        return .acquired(descriptor)
    }

    private static func releaseLock(_ descriptor: Int32) {
        _ = aiAppBridgeFlock(descriptor, LOCK_UN)
        _ = Darwin.close(descriptor)
    }

    private static func pendingResult(
        inactiveURLs: [URL],
        fileManager: FileManager,
        errors: [String]
    ) -> SegmentedFactStoreProfileMaintenanceResult {
        var bytes: UInt64 = 0
        var allErrors = errors
        for url in inactiveURLs {
            let result = allocatedBytes(at: url, fileManager: fileManager)
            bytes = saturatingAdd(bytes, result.bytes)
            if let error = result.error {
                allErrors.append("\(url.lastPathComponent): \(error)")
            }
        }
        return .init(
            cleanupPending: !inactiveURLs.isEmpty || !allErrors.isEmpty,
            inactiveBytes: bytes,
            error: allErrors.isEmpty ? nil : allErrors.joined(separator: "; ")
        )
    }

    private static func allocatedBytes(
        at url: URL,
        fileManager: FileManager
    ) -> (bytes: UInt64, error: String?) {
        do {
            let rootValues = try url.resourceValues(forKeys: resourceKeys)
            if rootValues.isSymbolicLink == true || rootValues.isDirectory != true {
                return (allocatedBytes(from: rootValues), nil)
            }
            var firstError: Error?
            guard let enumerator = fileManager.enumerator(
                at: url,
                includingPropertiesForKeys: Array(resourceKeys),
                options: [],
                errorHandler: { _, error in
                    if firstError == nil { firstError = error }
                    return false
                }
            ) else {
                return (0, "profile_size_scan_unavailable")
            }
            var total: UInt64 = 0
            for case let child as URL in enumerator {
                do {
                    let values = try child.resourceValues(forKeys: resourceKeys)
                    total = saturatingAdd(total, allocatedBytes(from: values))
                    if values.isSymbolicLink == true {
                        enumerator.skipDescendants()
                    }
                } catch {
                    if firstError == nil { firstError = error }
                    enumerator.skipDescendants()
                }
            }
            return (total, firstError.map { "profile_size_scan_failed: \($0)" })
        } catch {
            return (0, "profile_size_scan_failed: \(error)")
        }
    }

    private static func allocatedBytes(from values: URLResourceValues) -> UInt64 {
        let value = values.totalFileAllocatedSize
            ?? values.fileAllocatedSize
            ?? values.fileSize
            ?? 0
        return UInt64(max(0, value))
    }

    private static func saturatingAdd(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
        let (sum, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? UInt64.max : sum
    }

    private static func errorMessage(_ code: Int32) -> String {
        String(cString: Darwin.strerror(code))
    }
}

/** Cross-platform adapter envelope defined by native/segmented-fact-store/FORMAT.md. */
enum LargeFactWire {
    static let headerBytes = 72
    static let manifestMarker = "ai-app-bridge.large-fact-manifest.v1"
    private static let magic = Data("AIBCHN01".utf8)
    private static let version: UInt32 = 1
    private static let maximumJSONInteger: UInt64 = 9_007_199_254_740_991

    struct IndexMetadata: Equatable, Sendable {
        let partition: String
        let targetKey: String
        let runtimeEpoch: String
        let actionId: String?
        let dedupeKey: String?
        let occurredAtMs: Int64
        let observedAtMs: Int64
        let ingestedAtMs: Int64

        var dictionary: [String: Any] {
            [
                "partition": partition,
                "targetKey": targetKey,
                "runtimeEpoch": runtimeEpoch,
                "actionId": actionId ?? NSNull(),
                "dedupeKey": dedupeKey ?? NSNull(),
                "timestamps": [
                    "occurredAtMs": occurredAtMs,
                    "observedAtMs": observedAtMs,
                    "ingestedAtMs": ingestedAtMs
                ]
            ]
        }
    }

    struct ChunkLocation: Equatable, Sendable {
        let ordinal: Int
        let sequence: UInt64
        let segmentId: UInt64
        let frameOffset: UInt64
        let payloadLength: Int
        let byteLength: Int
    }

    struct DecodedChunk: Sendable {
        let digest: Data
        let ordinal: Int
        let chunkCount: Int
        let totalLength: Int
        let bytes: Data
    }

    struct Manifest: Sendable {
        let index: IndexMetadata
        let digest: Data
        let byteLength: Int
        let chunks: [ChunkLocation]
    }

    struct Invalid: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func sha256(_ bytes: Data) -> Data {
        Data(SHA256.hash(data: bytes))
    }

    static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func isChunk(_ payload: Data) -> Bool {
        payload.count >= magic.count && payload.prefix(magic.count) == magic
    }

    static func encodeChunk(
        digest: Data,
        ordinal: Int,
        chunkCount: Int,
        totalLength: Int,
        bytes: Data
    ) throws -> Data {
        try require(digest.count == 32, "large fact SHA-256 must contain 32 bytes")
        try require(
            ordinal >= 0 && chunkCount > 0 && ordinal < chunkCount,
            "large fact chunk ordinal is invalid"
        )
        try require(totalLength > 0 && !bytes.isEmpty, "large fact chunk lengths are invalid")
        var result = Data(capacity: headerBytes + bytes.count)
        result.append(magic)
        appendUInt32(version, to: &result)
        appendUInt32(UInt32(headerBytes), to: &result)
        result.append(digest)
        appendUInt32(UInt32(ordinal), to: &result)
        appendUInt32(UInt32(chunkCount), to: &result)
        appendUInt64(UInt64(totalLength), to: &result)
        appendUInt32(UInt32(bytes.count), to: &result)
        appendUInt32(0, to: &result)
        result.append(bytes)
        return result
    }

    static func decodeChunk(_ payload: Data) throws -> DecodedChunk {
        try require(payload.count >= headerBytes, "large fact chunk header is truncated")
        try require(isChunk(payload), "large fact chunk magic is invalid")
        try require(readUInt32(payload, at: 8) == version, "large fact chunk version is unsupported")
        try require(
            readUInt32(payload, at: 12) == UInt32(headerBytes),
            "large fact chunk header length is invalid"
        )
        let digest = payload.subdata(in: 16..<48)
        let ordinal = Int(readUInt32(payload, at: 48))
        let chunkCount = Int(readUInt32(payload, at: 52))
        let totalLength = readUInt64(payload, at: 56)
        let byteLength = Int(readUInt32(payload, at: 64))
        try require(
            chunkCount > 0 && ordinal >= 0 && ordinal < chunkCount,
            "large fact chunk ordinal is invalid"
        )
        try require(totalLength > 0 && totalLength <= UInt64(Int.max), "large fact total length is invalid")
        try require(
            byteLength > 0 && byteLength == payload.count - headerBytes,
            "large fact chunk byte length does not match its payload"
        )
        try require(readUInt32(payload, at: 68) == 0, "large fact chunk reserved bytes are non-zero")
        return .init(
            digest: digest,
            ordinal: ordinal,
            chunkCount: chunkCount,
            totalLength: Int(totalLength),
            bytes: payload.subdata(in: headerBytes..<payload.count)
        )
    }

    static func extractIndex(_ payload: Data) throws -> IndexMetadata {
        let value = try JSONSerialization.jsonObject(with: payload)
        guard let dictionary = value as? [String: Any] else {
            throw Invalid(message: "large fact payload is not a JSON object")
        }
        return try parseIndex(dictionary)
    }

    static func encodeManifest(
        index: IndexMetadata,
        digest: Data,
        byteLength: Int,
        chunks: [ChunkLocation]
    ) throws -> Data {
        try require(digest.count == 32 && byteLength > 0 && !chunks.isEmpty, "large fact manifest is invalid")
        let chunkDictionaries: [[String: Any]] = chunks.map { chunk in
            [
                "ordinal": chunk.ordinal,
                "sequence": NSNumber(value: chunk.sequence),
                "segmentId": NSNumber(value: chunk.segmentId),
                "frameOffset": NSNumber(value: chunk.frameOffset),
                "payloadLength": chunk.payloadLength,
                "byteLength": chunk.byteLength
            ]
        }
        return try JSONSerialization.data(
            withJSONObject: [
                "__aiAppBridgeInternal": manifestMarker,
                "index": index.dictionary,
                "content": [
                    "encoding": "json-utf8",
                    "byteLength": byteLength,
                    "sha256": hex(digest),
                    "chunks": chunkDictionaries
                ]
            ],
            options: [.sortedKeys]
        )
    }

    /** Returns nil for an ordinary physical payload and throws for a marked invalid manifest. */
    static func decodeManifest(_ payload: Data, manifestSequence: UInt64) throws -> Manifest? {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: payload)
        } catch {
            return nil
        }
        guard let root = value as? [String: Any],
              root["__aiAppBridgeInternal"] as? String == manifestMarker else {
            return nil
        }
        try require(manifestSequence > 0, "large fact manifest sequence is invalid")
        guard let indexValue = root["index"] as? [String: Any],
              let content = root["content"] as? [String: Any] else {
            throw Invalid(message: "large fact manifest content is missing")
        }
        let index = try parseIndex(indexValue)
        try require(content["encoding"] as? String == "json-utf8", "large fact manifest encoding is invalid")
        let byteLength = try positiveInt(content["byteLength"], "large fact manifest byte length is invalid")
        guard let digestHex = content["sha256"] as? String else {
            throw Invalid(message: "large fact manifest SHA-256 is invalid")
        }
        let digest = try decodeHex(digestHex)
        guard let chunkValues = content["chunks"] as? [[String: Any]], !chunkValues.isEmpty else {
            throw Invalid(message: "large fact manifest chunks are missing")
        }
        var priorSequence: UInt64 = 0
        var totalLength = 0
        var chunks: [ChunkLocation] = []
        for (ordinal, value) in chunkValues.enumerated() {
            let chunk = ChunkLocation(
                ordinal: try nonnegativeInt(value["ordinal"], "large fact manifest chunk ordinal is invalid"),
                sequence: try positiveUInt64(value["sequence"], "large fact manifest chunk sequence is invalid"),
                segmentId: try positiveUInt64(value["segmentId"], "large fact manifest chunk segment is invalid"),
                frameOffset: try positiveUInt64(value["frameOffset"], "large fact manifest chunk offset is invalid"),
                payloadLength: try positiveInt(value["payloadLength"], "large fact manifest chunk payload length is invalid"),
                byteLength: try positiveInt(value["byteLength"], "large fact manifest chunk byte length is invalid")
            )
            try require(chunk.ordinal == ordinal, "large fact manifest chunk ordinal is missing")
            try require(
                chunk.sequence > priorSequence && chunk.sequence < manifestSequence,
                "large fact manifest chunk sequence is out of order"
            )
            try require(chunk.frameOffset >= 64, "large fact manifest chunk offset is invalid")
            try require(
                chunk.payloadLength == headerBytes + chunk.byteLength,
                "large fact manifest chunk physical length is invalid"
            )
            let (nextTotal, overflow) = totalLength.addingReportingOverflow(chunk.byteLength)
            try require(!overflow, "large fact manifest chunk lengths overflow")
            totalLength = nextTotal
            priorSequence = chunk.sequence
            chunks.append(chunk)
        }
        try require(totalLength == byteLength, "large fact manifest chunk lengths do not match its total")
        return .init(index: index, digest: digest, byteLength: byteLength, chunks: chunks)
    }

    private static func parseIndex(_ value: [String: Any]) throws -> IndexMetadata {
        guard let partition = value["partition"] as? String, !partition.isEmpty,
              let targetKey = value["targetKey"] as? String, !targetKey.isEmpty,
              let runtimeEpoch = value["runtimeEpoch"] as? String, !runtimeEpoch.isEmpty,
              let timestamps = value["timestamps"] as? [String: Any] else {
            throw Invalid(message: "large fact index fields are missing")
        }
        return .init(
            partition: partition,
            targetKey: targetKey,
            runtimeEpoch: runtimeEpoch,
            actionId: nullableString(value["actionId"]),
            dedupeKey: nullableString(value["dedupeKey"]),
            occurredAtMs: try integer(timestamps["occurredAtMs"], "large fact occurred timestamp is invalid"),
            observedAtMs: try integer(timestamps["observedAtMs"], "large fact observed timestamp is invalid"),
            ingestedAtMs: try integer(timestamps["ingestedAtMs"], "large fact ingested timestamp is invalid")
        )
    }

    private static func nullableString(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? String
    }

    private static func integer(_ value: Any?, _ message: String) throws -> Int64 {
        guard let number = value as? NSNumber else { throw Invalid(message: message) }
        return number.int64Value
    }

    private static func nonnegativeInt(_ value: Any?, _ message: String) throws -> Int {
        guard let number = value as? NSNumber,
              number.int64Value >= 0,
              number.uint64Value <= UInt64(Int.max) else {
            throw Invalid(message: message)
        }
        return Int(number.uint64Value)
    }

    private static func positiveInt(_ value: Any?, _ message: String) throws -> Int {
        let result = try nonnegativeInt(value, message)
        guard result > 0 else { throw Invalid(message: message) }
        return result
    }

    private static func positiveUInt64(_ value: Any?, _ message: String) throws -> UInt64 {
        guard let number = value as? NSNumber else { throw Invalid(message: message) }
        let result = number.uint64Value
        guard result > 0 && result <= maximumJSONInteger else { throw Invalid(message: message) }
        return result
    }

    private static func decodeHex(_ value: String) throws -> Data {
        let characters = Array(value.utf8)
        try require(
            characters.count == 64 && characters.allSatisfy { byte in
                (48...57).contains(byte) || (97...102).contains(byte)
            },
            "large fact manifest SHA-256 is invalid"
        )
        var result = Data(capacity: 32)
        for index in stride(from: 0, to: characters.count, by: 2) {
            result.append((hexNibble(characters[index]) << 4) | hexNibble(characters[index + 1]))
        }
        return result
    }

    private static func hexNibble(_ byte: UInt8) -> UInt8 {
        byte <= 57 ? byte - 48 : byte - 87
    }

    private static func appendUInt32(_ value: UInt32, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private static func appendUInt64(_ value: UInt64, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        (0..<4).reduce(0) { result, index in
            result | (UInt32(data[offset + index]) << UInt32(index * 8))
        }
    }

    private static func readUInt64(_ data: Data, at offset: Int) -> UInt64 {
        (0..<8).reduce(0) { result, index in
            result | (UInt64(data[offset + index]) << UInt64(index * 8))
        }
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw Invalid(message: message) }
    }
}

/**
 * Async mobile adapter for the portable C fact store.
 *
 * Every C/file call runs on one background writer queue. `record` copies normal facts and performs
 * only bounded in-memory JSON/SHA/chunk preflight for a large fact before enqueueing it, so observer
 * and main-thread callbacks do not perform mmap or filesystem work. Completion callbacks run on the
 * writer queue.
 */
internal final class SegmentedFactStore {
    internal static let shared = SegmentedFactStore()
    internal static let maxPersistedPayloadBytes = 1024 * 1024
    internal static let groupFlushIntervalSeconds: TimeInterval = 2
    internal static let groupFlushRecordLimit = 64
    private static let defaultSegmentSizeBytes: UInt64 = 1024 * 1024
    private static let nativeSegmentHeaderBytes: UInt64 = 64
    private static let nativeFramePrefixBytes: UInt64 = 24
    private static let nativeFrameCommitBytes: UInt64 = 8
    private static let maximumJSONInteger: UInt64 = 9_007_199_254_740_991
    private static let recordGapBefore: UInt32 = 1

    private let lock = NSLock()
    private let writer: DispatchQueue
    private let maxQueuedRecords: Int
    private let flushIntervalSeconds: TimeInterval
    private let maxUnflushedRecords: Int
    private let nativeFactory: () -> SegmentedFactStoreNative
    private var native: SegmentedFactStoreNative?
    private var stateValue: SegmentedFactStoreState = .closed
    private var enabledValue = false
    private var handle: UInt64 = 0
    private var receiveObservationFacts = false
    private var pendingRecords = 0
    private var acceptedRecords: UInt64 = 0
    private var writtenRecords: UInt64 = 0
    private var droppedRecords: UInt64 = 0
    private var receiptOutcomes: [Bool] = []
    private var unflushedRecords = 0
    private var flushTimer: DispatchSourceTimer?
    private var lastOperation = SegmentedFactStoreOperationResult(code: SegmentedFactStoreResultCode.closed)
    private var profileMaintenance: SegmentedFactStoreProfileMaintenance?
    private var cleanupPending = false
    private var inactiveBytes: UInt64 = 0
    private var cleanupError: String?
    private var configuredSegmentSizeBytes = defaultSegmentSizeBytes
    private var configuredPartitionQuotas: [UInt64] = []

    internal convenience init(
        maxQueuedRecords: Int = 256,
        flushIntervalSeconds: TimeInterval = SegmentedFactStore.groupFlushIntervalSeconds,
        maxUnflushedRecords: Int = SegmentedFactStore.groupFlushRecordLimit
    ) {
        self.init(
            nativeFactory: { CSegmentedFactStoreNative() },
            writer: DispatchQueue(label: "io.github.mobileaidev.aiappbridge.ios.fact-writer"),
            maxQueuedRecords: maxQueuedRecords,
            flushIntervalSeconds: flushIntervalSeconds,
            maxUnflushedRecords: maxUnflushedRecords
        )
    }

    init(
        nativeFactory: @escaping () -> SegmentedFactStoreNative,
        writer: DispatchQueue,
        maxQueuedRecords: Int,
        flushIntervalSeconds: TimeInterval = SegmentedFactStore.groupFlushIntervalSeconds,
        maxUnflushedRecords: Int = SegmentedFactStore.groupFlushRecordLimit
    ) {
        precondition(maxQueuedRecords > 0, "maxQueuedRecords must be positive")
        precondition(flushIntervalSeconds > 0, "flushIntervalSeconds must be positive")
        precondition(maxUnflushedRecords > 0, "maxUnflushedRecords must be positive")
        self.nativeFactory = nativeFactory
        self.writer = writer
        self.maxQueuedRecords = maxQueuedRecords
        self.flushIntervalSeconds = flushIntervalSeconds
        self.maxUnflushedRecords = maxUnflushedRecords
    }

    internal func open(
        _ options: SegmentedFactStoreOptions,
        completion: @escaping (SegmentedFactStoreOperationResult) -> Void = { _ in }
    ) {
        precondition(options.partitionQuotas.count <= 8, "at most 8 partition quotas are supported")
        let shouldOpen = withLock { () -> Bool in
            switch stateValue {
            case .opening, .open, .closing:
                return false
            case .closed, .disabled, .failed:
                enabledValue = options.enabled
                receiveObservationFacts = options.receiveObservationFacts
                configuredSegmentSizeBytes = options.segmentSizeBytes > 0
                    ? options.segmentSizeBytes
                    : Self.defaultSegmentSizeBytes
                configuredPartitionQuotas = options.partitionQuotas
                profileMaintenance = options.profileMaintenance
                cleanupPending = options.profileMaintenance != nil && !options.enabled
                inactiveBytes = 0
                cleanupError = nil
                stateValue = options.enabled ? .opening : .disabled
                return true
            }
        }
        guard shouldOpen else {
            completion(.init(
                code: SegmentedFactStoreResultCode.invalidArgument,
                message: "fact store is already opening, open, or closing"
            ))
            return
        }
        guard options.enabled else {
            let result = SegmentedFactStoreOperationResult(code: SegmentedFactStoreResultCode.ok)
            guard options.profileMaintenance != nil else {
                withLock { lastOperation = result }
                completion(result)
                return
            }
            writer.async { [self] in
                runProfileMaintenanceOnWriter()
                withLock { lastOperation = result }
                completion(result)
            }
            return
        }
        if options.receiveObservationFacts {
            IOSObservationFactStoreRegistry.attach(self)
        }

        writer.async { [self] in
            let adapter = native ?? nativeFactory()
            native = adapter
            let result: NativeOpenResult
            do {
                try FileManager.default.createDirectory(
                    at: options.directory,
                    withIntermediateDirectories: true
                )
                result = adapter.open(options)
            } catch {
                result = .init(
                    operation: .init(
                        code: SegmentedFactStoreResultCode.io,
                        message: String(describing: error)
                    ),
                    handle: 0
                )
            }
            let geometry = result.operation.isSuccess
                ? adapter.status(handle: result.handle)
                : nil
            let closePending = withLock { () -> Bool in
                lastOperation = result.operation
                if result.operation.isSuccess {
                    handle = result.handle
                    if let geometry, geometry.operation.isSuccess {
                        if geometry.segmentSizeBytes > 0 {
                            configuredSegmentSizeBytes = geometry.segmentSizeBytes
                        }
                        if !geometry.partitionQuotas.isEmpty {
                            configuredPartitionQuotas = geometry.partitionQuotas
                        }
                    }
                    if stateValue != .closing {
                        stateValue = .open
                    }
                } else {
                    handle = 0
                    stateValue = .failed
                }
                return stateValue == .closing
            }
            if result.operation.isSuccess {
                runProfileMaintenanceOnWriter()
            }
            if result.operation.isSuccess && receiveObservationFacts && !closePending {
                IOSObservationFactStoreRegistry.attach(self)
            } else if !result.operation.isSuccess {
                IOSObservationFactStoreRegistry.detach(self)
            }
            if result.operation.isSuccess && !closePending {
                startGroupFlushTimerOnWriter()
            }
            completion(result.operation)
        }
    }

    @discardableResult
    internal func record(
        _ payload: Data,
        partitionId: UInt32 = 0,
        durability: SegmentedFactStoreDurability = .memory
    ) -> SegmentedFactRecordEnqueueResult {
        enqueueRecord(payload, partitionId: partitionId, durability: durability, trackReceiptOutcome: false)
    }

    @discardableResult
    internal func recordForReceipt(
        _ payload: Data,
        partitionId: UInt32 = 0,
        durability: SegmentedFactStoreDurability = .memory
    ) -> SegmentedFactRecordEnqueueResult {
        enqueueRecord(payload, partitionId: partitionId, durability: durability, trackReceiptOutcome: true)
    }

    internal func takeReceiptOutcomes() -> [Bool] {
        withLock {
            let taken = receiptOutcomes
            receiptOutcomes.removeAll()
            return taken
        }
    }

    private func offerReceiptOutcome(_ track: Bool, success: Bool) {
        if !track { return }
        receiptOutcomes.append(success)
    }

    @discardableResult
    private func enqueueRecord(
        _ payload: Data,
        partitionId: UInt32,
        durability: SegmentedFactStoreDurability,
        trackReceiptOutcome: Bool
    ) -> SegmentedFactRecordEnqueueResult {
        let configuration = withLock {
            RecordConfiguration(
                state: stateValue,
                segmentSizeBytes: configuredSegmentSizeBytes,
                partitionQuotas: configuredPartitionQuotas
            )
        }
        if configuration.state == .disabled { return .disabled }
        guard configuration.state == .opening || configuration.state == .open else { return .closed }
        let maximumNativePayload = maximumNativePayload(
            segmentSizeBytes: configuration.segmentSizeBytes
        )
        let largePlan: LargeFactWritePlan?
        if payload.count > Self.maxPersistedPayloadBytes {
            largePlan = nil
        } else if UInt64(payload.count) > maximumNativePayload {
            do {
                largePlan = try createLargeFactPlan(payload, partitionId: partitionId, configuration: configuration)
            } catch {
                withLock { droppedRecords += 1 }
                return .payloadTooLarge
            }
        } else {
            largePlan = nil
        }
        let accepted = withLock { () -> SegmentedFactRecordEnqueueResult in
            if stateValue == .disabled { return .disabled }
            guard stateValue == .opening || stateValue == .open else { return .closed }
            guard payload.count <= Self.maxPersistedPayloadBytes else {
                droppedRecords += 1
                return .payloadTooLarge
            }
            guard pendingRecords < maxQueuedRecords else {
                droppedRecords += 1
                return .queueFull
            }
            pendingRecords += 1
            acceptedRecords += 1
            return .accepted
        }
        guard accepted == .accepted else { return accepted }
        let ownedPayload = largePlan == nil ? Data(payload) : nil
        writer.async { [self] in
            defer { withLock { pendingRecords -= 1 } }
            let snapshot = withLock { (handle, native) }
            guard snapshot.0 != 0, let adapter = snapshot.1 else {
                withLock {
                    droppedRecords += 1
                    offerReceiptOutcome(trackReceiptOutcome, success: false)
                }
                return
            }
            let result: NativeAppendResult
            if let largePlan {
                result = appendLargeFact(
                    adapter: adapter,
                    handle: snapshot.0,
                    partitionId: partitionId,
                    durability: durability,
                    plan: largePlan
                )
            } else {
                result = adapter.append(
                    handle: snapshot.0,
                    partitionId: partitionId,
                    payload: ownedPayload!,
                    durability: durability
                )
            }
            withLock {
                lastOperation = result.operation
                if result.operation.isSuccess {
                    writtenRecords += 1
                    offerReceiptOutcome(trackReceiptOutcome, success: true)
                } else {
                    droppedRecords += 1
                    offerReceiptOutcome(trackReceiptOutcome, success: false)
                }
            }
            if result.operation.isSuccess {
                unflushedRecords += 1
                if unflushedRecords >= maxUnflushedRecords {
                    flushPendingOnWriter(adapter: adapter, handle: snapshot.0)
                }
            }
        }
        return .accepted
    }

    internal func read(
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int = 64 * 1024,
        completion: @escaping (SegmentedFactStoreReadResult) -> Void
    ) {
        precondition(bufferCapacity >= 0 && UInt64(bufferCapacity) <= UInt64(UInt32.max))
        writer.async { [self] in
            let snapshot = withLock { (handle, native) }
            guard snapshot.0 != 0, let adapter = snapshot.1 else {
                completion(.init(
                    operation: .init(code: SegmentedFactStoreResultCode.closed),
                    cursor: cursor,
                    record: nil,
                    requiredCapacity: 0
                ))
                return
            }
            completion(readLogical(
                adapter: adapter,
                handle: snapshot.0,
                cursor: cursor,
                bufferCapacity: bufferCapacity
            ))
        }
    }

    internal func flush(completion: @escaping (SegmentedFactStoreOperationResult) -> Void) {
        writer.async { [self] in
            let snapshot = withLock { (handle, native) }
            guard snapshot.0 != 0, let adapter = snapshot.1 else {
                completion(.init(code: SegmentedFactStoreResultCode.closed))
                return
            }
            if unflushedRecords == 0 {
                completion(.init(code: SegmentedFactStoreResultCode.ok))
                return
            }
            flushPendingOnWriter(adapter: adapter, handle: snapshot.0)
            completion(withLock { lastOperation })
        }
    }

    internal func status(completion: @escaping (SegmentedFactStoreStatus) -> Void) {
        writer.async { [self] in
            if withLock({ cleanupPending }) {
                runProfileMaintenanceOnWriter()
            }
            let wrapper = wrapperStatus()
            let snapshot = withLock { (handle, native) }
            guard snapshot.0 != 0, let adapter = snapshot.1 else {
                completion(wrapper)
                return
            }
            var status = adapter.status(handle: snapshot.0)
            status.state = wrapper.state
            status.enabled = wrapper.enabled
            status.queuedRecords = wrapper.queuedRecords
            status.acceptedRecords = wrapper.acceptedRecords
            status.writtenRecords = wrapper.writtenRecords
            status.droppedRecords = wrapper.droppedRecords
            status.cleanupPending = wrapper.cleanupPending
            status.inactiveBytes = wrapper.inactiveBytes
            status.cleanupError = wrapper.cleanupError
            completion(status)
        }
    }

    internal func close(
        completion: @escaping (SegmentedFactStoreOperationResult) -> Void = { _ in }
    ) {
        let shouldClose = withLock { () -> Bool in
            switch stateValue {
            case .opening, .open:
                stateValue = .closing
                return true
            case .closed, .disabled, .failed:
                enabledValue = false
                stateValue = .closed
                return false
            case .closing:
                return false
            }
        }
        IOSObservationFactStoreRegistry.detach(self)
        guard shouldClose else {
            completion(.init(code: SegmentedFactStoreResultCode.ok))
            return
        }
        writer.async { [self] in
            flushTimer?.cancel()
            flushTimer = nil
            let snapshot = withLock { (handle, native) }
            if snapshot.0 != 0, let adapter = snapshot.1 {
                flushPendingOnWriter(adapter: adapter, handle: snapshot.0)
            }
            let closeResult = snapshot.0 != 0
                ? snapshot.1?.close(handle: snapshot.0)
                : nil
            let result = closeResult ?? .init(code: SegmentedFactStoreResultCode.closed)
            withLock {
                handle = 0
                enabledValue = false
                stateValue = .closed
                lastOperation = result
            }
            unflushedRecords = 0
            completion(result)
        }
    }

    private func createLargeFactPlan(
        _ payload: Data,
        partitionId: UInt32,
        configuration: RecordConfiguration
    ) throws -> LargeFactWritePlan {
        let partitionIndex = Int(partitionId)
        guard partitionIndex < configuration.partitionQuotas.count else {
            throw LargeFactWire.Invalid(message: "large fact partition is invalid")
        }
        let quota = configuration.partitionQuotas[partitionIndex]
        guard quota >= configuration.segmentSizeBytes else {
            throw LargeFactWire.Invalid(message: "large fact partition is disabled or has an invalid quota")
        }
        let maxNativePayload = maximumNativePayload(
            segmentSizeBytes: configuration.segmentSizeBytes
        )
        guard maxNativePayload > UInt64(LargeFactWire.headerBytes) else {
            throw LargeFactWire.Invalid(message: "large fact segment is too small")
        }
        let maxChunkBytes = Int(maxNativePayload - UInt64(LargeFactWire.headerBytes))
        let digest = LargeFactWire.sha256(payload)
        let index = try LargeFactWire.extractIndex(payload)
        var chunks: [Data] = []
        var offset = 0
        while offset < payload.count {
            let end = min(payload.count, offset + maxChunkBytes)
            chunks.append(payload.subdata(in: offset..<end))
            offset = end
        }
        let upperLocations = chunks.enumerated().map { ordinal, bytes in
            LargeFactWire.ChunkLocation(
                ordinal: ordinal,
                sequence: Self.maximumJSONInteger - UInt64(chunks.count) + UInt64(ordinal),
                segmentId: Self.maximumJSONInteger,
                frameOffset: Self.maximumJSONInteger,
                payloadLength: LargeFactWire.headerBytes + bytes.count,
                byteLength: bytes.count
            )
        }
        let manifestUpperBound = try LargeFactWire.encodeManifest(
            index: index,
            digest: digest,
            byteLength: payload.count,
            chunks: upperLocations
        )
        guard UInt64(manifestUpperBound.count) <= maxNativePayload else {
            throw LargeFactWire.Invalid(message: "large fact manifest does not fit in an empty segment")
        }
        let physicalLengths = chunks.map { LargeFactWire.headerBytes + $0.count }
            + [manifestUpperBound.count]
        let segmentCount = try requiredSegments(
            segmentSizeBytes: configuration.segmentSizeBytes,
            payloadLengths: physicalLengths
        )
        guard UInt64(segmentCount) <= quota / configuration.segmentSizeBytes else {
            throw LargeFactWire.Invalid(message: "large fact exceeds its partition quota")
        }
        return .init(index: index, digest: digest, byteLength: payload.count, chunks: chunks)
    }

    private func appendLargeFact(
        adapter: SegmentedFactStoreNative,
        handle: UInt64,
        partitionId: UInt32,
        durability: SegmentedFactStoreDurability,
        plan: LargeFactWritePlan
    ) -> NativeAppendResult {
        do {
            var locations: [LargeFactWire.ChunkLocation] = []
            for (ordinal, bytes) in plan.chunks.enumerated() {
                let chunkPayload = try LargeFactWire.encodeChunk(
                    digest: plan.digest,
                    ordinal: ordinal,
                    chunkCount: plan.chunks.count,
                    totalLength: plan.byteLength,
                    bytes: bytes
                )
                let receipt = adapter.append(
                    handle: handle,
                    partitionId: partitionId,
                    payload: chunkPayload,
                    durability: .memory
                )
                guard receipt.operation.isSuccess else { return receipt }
                guard receipt.partitionId == partitionId,
                      receipt.sequence > 0,
                      receipt.sequence <= Self.maximumJSONInteger,
                      receipt.segmentId > 0,
                      receipt.segmentId <= Self.maximumJSONInteger,
                      receipt.frameOffset >= Self.nativeSegmentHeaderBytes,
                      receipt.frameOffset <= Self.maximumJSONInteger,
                      receipt.payloadLength == chunkPayload.count else {
                    return corruptAppend("large fact chunk append receipt is invalid")
                }
                locations.append(.init(
                    ordinal: ordinal,
                    sequence: receipt.sequence,
                    segmentId: receipt.segmentId,
                    frameOffset: receipt.frameOffset,
                    payloadLength: receipt.payloadLength,
                    byteLength: bytes.count
                ))
            }
            let manifest = try LargeFactWire.encodeManifest(
                index: plan.index,
                digest: plan.digest,
                byteLength: plan.byteLength,
                chunks: locations
            )
            return adapter.append(
                handle: handle,
                partitionId: partitionId,
                payload: manifest,
                durability: durability
            )
        } catch {
            return corruptAppend(error.localizedDescription)
        }
    }

    private func readLogical(
        adapter: SegmentedFactStoreNative,
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        var physicalCursor = cursor
        var skippedGapFirstSequence: UInt64 = 0
        var skippedGapLastSequence: UInt64 = 0
        while true {
            let physical = scanPhysical(
                adapter: adapter,
                handle: handle,
                cursor: physicalCursor,
                requestedCapacity: bufferCapacity
            )
            guard physical.operation.isSuccess else { return physical }
            guard let record = physical.record else {
                return corruptRead(cursor, "native scan returned no record")
            }
            if record.flags & Self.recordGapBefore != 0 {
                if skippedGapFirstSequence == 0 {
                    skippedGapFirstSequence = record.gapFirstSequence
                }
                skippedGapLastSequence = max(skippedGapLastSequence, record.gapLastSequence)
            }
            if LargeFactWire.isChunk(record.payload) {
                physicalCursor = physical.cursor
                continue
            }
            let manifest: LargeFactWire.Manifest?
            do {
                manifest = try LargeFactWire.decodeManifest(record.payload, manifestSequence: record.sequence)
            } catch {
                return corruptRead(cursor, error.localizedDescription)
            }
            guard let manifest else {
                if record.payload.count > bufferCapacity {
                    return bufferTooSmallRead(cursor, record.payload.count)
                }
                return .init(
                    operation: physical.operation,
                    cursor: physical.cursor,
                    record: recordWithSkippedGap(
                        record,
                        payload: record.payload,
                        first: skippedGapFirstSequence,
                        last: skippedGapLastSequence
                    ),
                    requiredCapacity: 0
                )
            }
            if manifest.byteLength > bufferCapacity {
                return bufferTooSmallRead(cursor, manifest.byteLength)
            }
            do {
                let assembled = try assembleLargeFact(
                    adapter: adapter,
                    handle: handle,
                    manifestRecord: record,
                    manifest: manifest
                )
                return .init(
                    operation: physical.operation,
                    cursor: physical.cursor,
                    record: recordWithSkippedGap(
                        record,
                        payload: assembled,
                        first: skippedGapFirstSequence,
                        last: skippedGapLastSequence
                    ),
                    requiredCapacity: 0
                )
            } catch {
                return corruptRead(cursor, error.localizedDescription)
            }
        }
    }

    private func scanPhysical(
        adapter: SegmentedFactStoreNative,
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        requestedCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        let first = adapter.read(handle: handle, cursor: cursor, bufferCapacity: requestedCapacity)
        guard first.operation.code == SegmentedFactStoreResultCode.bufferTooSmall else { return first }
        guard first.requiredCapacity > 0 else {
            return corruptRead(cursor, "native scan reported an invalid required capacity")
        }
        return adapter.read(handle: handle, cursor: cursor, bufferCapacity: first.requiredCapacity)
    }

    private func assembleLargeFact(
        adapter: SegmentedFactStoreNative,
        handle: UInt64,
        manifestRecord: SegmentedFactStoreRecord,
        manifest: LargeFactWire.Manifest
    ) throws -> Data {
        var assembled = Data(capacity: manifest.byteLength)
        for expected in manifest.chunks {
            let exactCursor = SegmentedFactStoreCursor(
                partitionId: manifestRecord.partitionId,
                afterSequence: expected.sequence - 1,
                segmentId: expected.segmentId,
                offset: expected.frameOffset
            )
            let scanned = scanPhysical(
                adapter: adapter,
                handle: handle,
                cursor: exactCursor,
                requestedCapacity: expected.payloadLength
            )
            guard scanned.operation.isSuccess, let record = scanned.record else {
                throw LargeFactWire.Invalid(message: "large fact chunk \(expected.ordinal) is missing")
            }
            guard record.partitionId == manifestRecord.partitionId,
                  record.sequence == expected.sequence,
                  record.segmentId == expected.segmentId,
                  record.frameOffset == expected.frameOffset,
                  record.payload.count == expected.payloadLength else {
                throw LargeFactWire.Invalid(message: "large fact chunk \(expected.ordinal) location changed")
            }
            let chunk = try LargeFactWire.decodeChunk(record.payload)
            guard chunk.ordinal == expected.ordinal,
                  chunk.chunkCount == manifest.chunks.count,
                  chunk.totalLength == manifest.byteLength,
                  chunk.bytes.count == expected.byteLength,
                  chunk.digest == manifest.digest else {
                throw LargeFactWire.Invalid(
                    message: "large fact chunk \(expected.ordinal) metadata does not match the manifest"
                )
            }
            assembled.append(chunk.bytes)
        }
        guard assembled.count == manifest.byteLength else {
            throw LargeFactWire.Invalid(message: "large fact assembled length is invalid")
        }
        guard LargeFactWire.sha256(assembled) == manifest.digest else {
            throw LargeFactWire.Invalid(message: "large fact SHA-256 does not match the manifest")
        }
        guard try LargeFactWire.extractIndex(assembled) == manifest.index else {
            throw LargeFactWire.Invalid(message: "large fact index metadata does not match the manifest")
        }
        return assembled
    }

    private func maximumNativePayload(segmentSizeBytes: UInt64) -> UInt64 {
        let fixedBytes = Self.nativeSegmentHeaderBytes + Self.nativeFrameCommitBytes
        guard segmentSizeBytes > fixedBytes else { return 0 }
        let availableFrameBody = segmentSizeBytes - fixedBytes
        guard availableFrameBody >= Self.nativeFramePrefixBytes else { return 0 }
        return (availableFrameBody & ~UInt64(7)) - Self.nativeFramePrefixBytes
    }

    private func requiredSegments(segmentSizeBytes: UInt64, payloadLengths: [Int]) throws -> Int {
        var segments = 1
        var offset = Self.nativeSegmentHeaderBytes
        for payloadLength in payloadLengths {
            let frameLength = nativeFrameLength(payloadLength)
            guard Self.nativeSegmentHeaderBytes + frameLength <= segmentSizeBytes else {
                throw LargeFactWire.Invalid(message: "large fact frame does not fit in an empty segment")
            }
            if offset + frameLength > segmentSizeBytes {
                segments += 1
                offset = Self.nativeSegmentHeaderBytes
            }
            offset += frameLength
        }
        return segments
    }

    private func nativeFrameLength(_ payloadLength: Int) -> UInt64 {
        let unaligned = Self.nativeFramePrefixBytes + UInt64(payloadLength)
        return ((unaligned + 7) & ~UInt64(7)) + Self.nativeFrameCommitBytes
    }

    private func recordWithSkippedGap(
        _ record: SegmentedFactStoreRecord,
        payload: Data,
        first: UInt64,
        last: UInt64
    ) -> SegmentedFactStoreRecord {
        let hasSkippedGap = first > 0 && last >= first
        return .init(
            payload: payload,
            partitionId: record.partitionId,
            flags: hasSkippedGap ? record.flags | Self.recordGapBefore : record.flags,
            sequence: record.sequence,
            segmentId: record.segmentId,
            frameOffset: record.frameOffset,
            gapFirstSequence: hasSkippedGap
                ? min(first, record.gapFirstSequence > 0 ? record.gapFirstSequence : first)
                : record.gapFirstSequence,
            gapLastSequence: hasSkippedGap ? max(last, record.gapLastSequence) : record.gapLastSequence
        )
    }

    private func corruptAppend(_ message: String) -> NativeAppendResult {
        .init(
            operation: .init(code: SegmentedFactStoreResultCode.corrupt, message: message),
            sequence: 0
        )
    }

    private func bufferTooSmallRead(
        _ cursor: SegmentedFactStoreCursor,
        _ requiredCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        .init(
            operation: .init(code: SegmentedFactStoreResultCode.bufferTooSmall),
            cursor: cursor,
            record: nil,
            requiredCapacity: requiredCapacity
        )
    }

    private func corruptRead(
        _ cursor: SegmentedFactStoreCursor,
        _ message: String
    ) -> SegmentedFactStoreReadResult {
        .init(
            operation: .init(code: SegmentedFactStoreResultCode.corrupt, message: message),
            cursor: cursor,
            record: nil,
            requiredCapacity: 0
        )
    }

    private func startGroupFlushTimerOnWriter() {
        flushTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: writer)
        timer.schedule(
            deadline: .now() + flushIntervalSeconds,
            repeating: flushIntervalSeconds
        )
        timer.setEventHandler { [weak self] in
            guard let self, self.unflushedRecords > 0 else { return }
            let snapshot = self.withLock { (self.handle, self.native) }
            guard snapshot.0 != 0, let adapter = snapshot.1 else { return }
            self.flushPendingOnWriter(adapter: adapter, handle: snapshot.0)
        }
        flushTimer = timer
        timer.resume()
    }

    private func flushPendingOnWriter(adapter: SegmentedFactStoreNative, handle: UInt64) {
        guard unflushedRecords > 0 else { return }
        let result = adapter.flush(handle: handle)
        withLock { lastOperation = result }
        if result.isSuccess { unflushedRecords = 0 }
    }

    private func runProfileMaintenanceOnWriter() {
        guard let maintenance = withLock({ profileMaintenance }) else { return }
        let result = SegmentedFactStoreProfileJanitor.cleanInactiveProfiles(maintenance)
        withLock {
            cleanupPending = result.cleanupPending
            inactiveBytes = result.inactiveBytes
            cleanupError = result.error
        }
    }

    private func wrapperStatus() -> SegmentedFactStoreStatus {
        withLock {
            .init(
                operation: lastOperation,
                state: stateValue,
                enabled: enabledValue,
                queuedRecords: pendingRecords,
                acceptedRecords: acceptedRecords,
                writtenRecords: writtenRecords,
                droppedRecords: droppedRecords,
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
                recoveryDiscardedBytes: 0,
                cleanupPending: cleanupPending,
                inactiveBytes: inactiveBytes,
                cleanupError: cleanupError
            )
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

struct MobileFactStoreConfiguration: Sendable {
    let profile: String
    let budgetBytes: UInt64
    let disabledReason: String?
    let options: SegmentedFactStoreOptions
}

enum MobileFactStoreProfiles {
    private static let mib: UInt64 = 1024 * 1024
    private static let gib: UInt64 = 1024 * mib
    private static let minimumSafetyReserve: UInt64 = 256 * mib
    private static let partitionWeights: [UInt64] = [25, 18, 10, 7, 10, 13, 5, 2]

    static func defaultConfiguration(fileManager: FileManager = .default) -> MobileFactStoreConfiguration {
        // The cache root is inside this application's container. Each App
        // installation on each device owns an independent 64/256/512 MiB or 1 GiB
        // budget; no other bundle or device participates in its eviction.
        let storageRoot = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let attributes = try? fileManager.attributesOfFileSystem(forPath: storageRoot.path)
        let total = (attributes?[.systemSize] as? NSNumber)?.uint64Value ?? 0
        let available = (attributes?[.systemFreeSize] as? NSNumber)?.uint64Value ?? 0
        return configuration(
            baseDirectory: storageRoot
                .appendingPathComponent("ai-app-bridge", isDirectory: true)
                .appendingPathComponent("segmented-fact-store", isDirectory: true),
            totalBytes: total,
            availableBytes: available
        )
    }

    static func configuration(
        baseDirectory: URL,
        totalBytes: UInt64,
        availableBytes: UInt64
    ) -> MobileFactStoreConfiguration {
        if availableBytes < 64 * mib + minimumSafetyReserve {
            let profile = "off-low-disk"
            let directory = baseDirectory.appendingPathComponent(profile, isDirectory: true)
            var options = SegmentedFactStoreOptions(
                directory: directory,
                segmentSizeBytes: 512 * 1024,
                flags: 1,
                partitionQuotas: Array(repeating: 0, count: 8),
                enabled: false,
                receiveObservationFacts: false
            )
            options.profileMaintenance = .init(
                baseDirectory: baseDirectory,
                activeProfile: profile,
                activeDirectory: directory
            )
            return .init(
                profile: profile,
                budgetBytes: 0,
                disabledReason: "insufficient-space",
                options: options
            )
        }
        let profile: String
        if totalBytes >= 32 * gib && availableBytes >= 8 * gib {
            profile = "1gb"
        } else if totalBytes >= 16 * gib && availableBytes >= 4 * gib {
            profile = "512mb"
        } else if totalBytes >= 4 * gib && availableBytes >= 2 * gib {
            profile = "256mb"
        } else {
            profile = "64mb"
        }
        let budgetBytes: UInt64
        let segmentSizeBytes: UInt64
        switch profile {
        case "1gb":
            budgetBytes = gib
            segmentSizeBytes = 4 * mib
        case "512mb":
            budgetBytes = 512 * mib
            segmentSizeBytes = 4 * mib
        case "256mb":
            budgetBytes = 256 * mib
            segmentSizeBytes = 2 * mib
        default:
            budgetBytes = 64 * mib
            segmentSizeBytes = 512 * 1024
        }
        let quotas = partitionWeights.map { weight -> UInt64 in
            let target = budgetBytes * weight / 100
            return max(segmentSizeBytes, target / segmentSizeBytes * segmentSizeBytes)
        }
        precondition(quotas.count == 8 && quotas.reduce(0, +) <= budgetBytes)
        let directory = baseDirectory.appendingPathComponent(profile, isDirectory: true)
        var options = SegmentedFactStoreOptions(
            directory: directory,
            segmentSizeBytes: segmentSizeBytes,
            flags: 1,
            partitionQuotas: quotas,
            enabled: true,
            receiveObservationFacts: true
        )
        options.profileMaintenance = .init(
            baseDirectory: baseDirectory,
            activeProfile: profile,
            activeDirectory: directory
        )
        return .init(
            profile: profile,
            budgetBytes: budgetBytes,
            disabledReason: nil,
            options: options
        )
    }
}

protocol ObservationFactStore: AnyObject {
    func open(
        _ options: SegmentedFactStoreOptions,
        completion: @escaping (SegmentedFactStoreOperationResult) -> Void
    )
    func close(completion: @escaping (SegmentedFactStoreOperationResult) -> Void)
    func status(completion: @escaping (SegmentedFactStoreStatus) -> Void)
}

extension SegmentedFactStore: ObservationFactStore {}

struct ObservationFactStoreRuntimeStatus: Sendable {
    let desiredRunning: Bool
    let lifecycleState: SegmentedFactStoreState
    let profile: String?
    let budgetBytes: UInt64
    let disabledReason: String?
    let directory: String?
    let partitionQuotas: [UInt64]
    let store: SegmentedFactStoreStatus
}

final class ObservationFactStoreLifecycle {
    private let lock = NSLock()
    private let store: ObservationFactStore
    private var desiredRunning = false
    private var lifecycleState: SegmentedFactStoreState = .closed
    private var configuration: MobileFactStoreConfiguration?
    private var closeIssued = false

    init(store: ObservationFactStore = SegmentedFactStore.shared) {
        self.store = store
    }

    func start(_ configuration: MobileFactStoreConfiguration) {
        let shouldOpen = withLock { () -> Bool in
            desiredRunning = true
            self.configuration = configuration
            switch lifecycleState {
            case .closed, .disabled, .failed:
                lifecycleState = .opening
                return true
            case .opening, .open, .closing:
                return false
            }
        }
        if shouldOpen { requestOpen(configuration) }
    }

    func stop() {
        let shouldClose = withLock { () -> Bool in
            desiredRunning = false
            switch lifecycleState {
            case .opening where !closeIssued,
                 .open where !closeIssued:
                lifecycleState = .closing
                closeIssued = true
                return true
            case .failed, .disabled:
                lifecycleState = .closed
                return false
            case .closed, .closing, .opening, .open:
                return false
            }
        }
        if shouldClose { requestClose() }
    }

    func status(completion: @escaping (ObservationFactStoreRuntimeStatus) -> Void) {
        let metadata = snapshot()
        store.status { storeStatus in
            completion(.init(
                desiredRunning: metadata.desiredRunning,
                lifecycleState: metadata.lifecycleState,
                profile: metadata.profile,
                budgetBytes: metadata.budgetBytes,
                disabledReason: metadata.disabledReason,
                directory: metadata.directory,
                partitionQuotas: metadata.partitionQuotas,
                store: storeStatus
            ))
        }
    }

    func snapshot() -> ObservationFactStoreRuntimeStatus {
        withLock { metadataSnapshot() }
    }

    private func requestOpen(_ configuration: MobileFactStoreConfiguration) {
        store.open(configuration.options) { [weak self] result in
            guard let self else { return }
            var shouldClose = false
            self.withLock {
                if result.isSuccess {
                    if !configuration.options.enabled {
                        self.lifecycleState = .disabled
                    } else if self.desiredRunning && !self.closeIssued {
                        self.lifecycleState = .open
                    } else if !self.closeIssued {
                        self.lifecycleState = .closing
                        self.closeIssued = true
                        shouldClose = true
                    }
                } else if !self.closeIssued {
                    self.lifecycleState = .failed
                }
            }
            if shouldClose { self.requestClose() }
        }
    }

    private func requestClose() {
        store.close { [weak self] _ in
            guard let self else { return }
            let reopen = self.withLock { () -> MobileFactStoreConfiguration? in
                self.closeIssued = false
                self.lifecycleState = .closed
                return self.desiredRunning ? self.configuration : nil
            }
            guard let reopen else { return }
            let shouldOpen = self.withLock { () -> Bool in
                guard self.lifecycleState == .closed, self.desiredRunning else { return false }
                self.lifecycleState = .opening
                return true
            }
            if shouldOpen { self.requestOpen(reopen) }
        }
    }

    private func metadataSnapshot() -> ObservationFactStoreRuntimeStatus {
        .init(
            desiredRunning: desiredRunning,
            lifecycleState: lifecycleState,
            profile: configuration?.profile,
            budgetBytes: configuration?.budgetBytes ?? 0,
            disabledReason: configuration?.disabledReason,
            directory: configuration?.options.directory.path,
            partitionQuotas: configuration?.options.partitionQuotas ?? [],
            store: .init(
                operation: .init(code: SegmentedFactStoreResultCode.closed),
                state: lifecycleState,
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
        )
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

struct NativeOpenResult {
    let operation: SegmentedFactStoreOperationResult
    let handle: UInt64
}

private struct RecordConfiguration {
    let state: SegmentedFactStoreState
    let segmentSizeBytes: UInt64
    let partitionQuotas: [UInt64]
}

private struct LargeFactWritePlan {
    let index: LargeFactWire.IndexMetadata
    let digest: Data
    let byteLength: Int
    let chunks: [Data]
}

struct NativeAppendResult {
    let operation: SegmentedFactStoreOperationResult
    let sequence: UInt64
    let partitionId: UInt32
    let segmentId: UInt64
    let frameOffset: UInt64
    let payloadLength: Int

    init(
        operation: SegmentedFactStoreOperationResult,
        sequence: UInt64,
        partitionId: UInt32 = 0,
        segmentId: UInt64 = 0,
        frameOffset: UInt64 = 0,
        payloadLength: Int = 0
    ) {
        self.operation = operation
        self.sequence = sequence
        self.partitionId = partitionId
        self.segmentId = segmentId
        self.frameOffset = frameOffset
        self.payloadLength = payloadLength
    }
}

protocol SegmentedFactStoreNative: AnyObject {
    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult
    func append(
        handle: UInt64,
        partitionId: UInt32,
        payload: Data,
        durability: SegmentedFactStoreDurability
    ) -> NativeAppendResult
    func read(
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult
    func status(handle: UInt64) -> SegmentedFactStoreStatus
    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult
    func close(handle: UInt64) -> SegmentedFactStoreOperationResult
}

final class CSegmentedFactStoreNative: SegmentedFactStoreNative {
    func open(_ options: SegmentedFactStoreOptions) -> NativeOpenResult {
        let quotas = options.partitionQuotas
        let result = options.directory.path.withCString { directory in
            quotas.withUnsafeBufferPointer { quotaBuffer in
                aib_sfs_open(
                    directory,
                    options.segmentSizeBytes,
                    options.flags,
                    quotaBuffer.baseAddress,
                    UInt32(quotaBuffer.count)
                )
            }
        }
        return NativeOpenResult(
            operation: operation(result.operation),
            handle: result.handle
        )
    }

    func append(
        handle: UInt64,
        partitionId: UInt32,
        payload: Data,
        durability: SegmentedFactStoreDurability
    ) -> NativeAppendResult {
        let result = payload.withUnsafeBytes { bytes in
            aib_sfs_append(
                handle,
                partitionId,
                bytes.baseAddress,
                UInt32(bytes.count),
                durability.rawValue
            )
        }
        return NativeAppendResult(
            operation: operation(result.operation),
            sequence: result.sequence,
            partitionId: result.partition_id,
            segmentId: result.segment_id,
            frameOffset: result.frame_offset,
            payloadLength: Int(result.payload_length)
        )
    }

    func read(
        handle: UInt64,
        cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult {
        var payload = Data(count: bufferCapacity)
        let result = payload.withUnsafeMutableBytes { bytes in
            aib_sfs_read(
                handle,
                cursor.partitionId,
                cursor.flags,
                cursor.afterSequence,
                cursor.segmentId,
                cursor.offset,
                bytes.baseAddress,
                UInt32(bytes.count)
            )
        }
        let nextCursor = SegmentedFactStoreCursor(
            partitionId: result.cursor_partition_id,
            flags: result.cursor_flags,
            afterSequence: result.cursor_after_sequence,
            segmentId: result.cursor_segment_id,
            offset: result.cursor_offset
        )
        let op = operation(result.operation)
        let record: SegmentedFactStoreRecord?
        if op.code == SegmentedFactStoreResultCode.ok {
            payload = Data(payload.prefix(Int(result.payload_length)))
            record = .init(
                payload: payload,
                partitionId: result.record_partition_id,
                flags: result.record_flags,
                sequence: result.sequence,
                segmentId: result.record_segment_id,
                frameOffset: result.frame_offset,
                gapFirstSequence: result.gap_first_sequence,
                gapLastSequence: result.gap_last_sequence
            )
        } else {
            record = nil
        }
        return .init(
            operation: op,
            cursor: nextCursor,
            record: record,
            requiredCapacity: op.code == SegmentedFactStoreResultCode.bufferTooSmall
                ? Int(result.payload_length)
                : 0
        )
    }

    func status(handle: UInt64) -> SegmentedFactStoreStatus {
        let value = aib_sfs_get_status(handle)
        let partitionQuotas = withUnsafeBytes(of: value.partition_quotas) { rawBuffer in
            Array(rawBuffer.bindMemory(to: UInt64.self).prefix(Int(AIB_SFS_MAX_PARTITIONS)))
        }
        return .init(
            operation: operation(value.operation),
            state: .open,
            enabled: true,
            queuedRecords: 0,
            acceptedRecords: 0,
            writtenRecords: 0,
            droppedRecords: 0,
            formatVersion: value.format_version,
            recoveredTail: value.flags & 1 != 0,
            segmentSizeBytes: value.segment_size,
            segmentCount: value.segment_count,
            firstSegmentId: value.first_segment_id,
            activeSegmentId: value.active_segment_id,
            activeWriteOffset: value.active_write_offset,
            recordCount: value.record_count,
            payloadBytes: value.payload_bytes,
            nextSequence: value.next_sequence,
            recoveryPartitionId: value.recovery_partition_id,
            recoverySegmentId: value.recovery_segment_id,
            recoveryOffset: value.recovery_offset,
            recoveryDiscardedBytes: value.recovery_discarded_bytes,
            partitionQuotas: partitionQuotas
        )
    }

    func flush(handle: UInt64) -> SegmentedFactStoreOperationResult {
        operation(aib_sfs_flush(handle))
    }

    func close(handle: UInt64) -> SegmentedFactStoreOperationResult {
        operation(aib_sfs_close(handle))
    }

    private func operation(_ value: aib_sfs_operation_t) -> SegmentedFactStoreOperationResult {
        var messageBytes = value.message
        let message = withUnsafePointer(to: &messageBytes) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: Int(AIB_SFS_ERROR_MESSAGE_CAPACITY)) {
                String(cString: $0)
            }
        }
        return .init(
            code: value.code,
            systemCode: value.system_code,
            message: message
        )
    }
}
