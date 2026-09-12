import Foundation

public struct CaptureInput {
    public var stream: String
    public var targetKey: String
    public var runtimeEpoch: String
    public var captureId: Int64
    public var timestampMs: Int64
    public var record: [String: Any]
    public var actionId: String?
    public var source: String
    public var stateKey: String?

    public init(
        stream: String,
        targetKey: String,
        runtimeEpoch: String,
        captureId: Int64,
        timestampMs: Int64,
        record: [String: Any],
        actionId: String? = nil,
        source: String = "sdk",
        stateKey: String? = nil
    ) {
        self.stream = stream
        self.targetKey = targetKey
        self.runtimeEpoch = runtimeEpoch
        self.captureId = captureId
        self.timestampMs = timestampMs
        self.record = record
        self.actionId = actionId
        self.source = source
        self.stateKey = stateKey
    }
}

public struct AppendReceipt {
    public var status: String
    public var accepted: Bool
    public var committed: Bool
    public var dropped: Bool
    public var deduplicated: Bool
    public var mobileFactId: String?
    public var reason: String?
}

public struct CaptureQuery {
    public var view: String
    public var stream: String
    public var sinceId: Int64?
    public var sinceMs: Int64?
    public var limit: Int?
    public var platform: String
    public var afterActionId: String?
    public var cursor: String?
    public var runtimeEpoch: String?
    public var targetKey: String?
    public var mobileFactId: String?

    public init(
        view: String,
        stream: String,
        sinceId: Int64? = nil,
        sinceMs: Int64? = nil,
        limit: Int? = nil,
        platform: String = "ios",
        afterActionId: String? = nil,
        cursor: String? = nil,
        runtimeEpoch: String? = nil,
        targetKey: String? = nil,
        mobileFactId: String? = nil
    ) {
        self.view = view
        self.stream = stream
        self.sinceId = sinceId
        self.sinceMs = sinceMs
        self.limit = limit
        self.platform = platform
        self.afterActionId = afterActionId
        self.cursor = cursor
        self.runtimeEpoch = runtimeEpoch
        self.targetKey = targetKey
        self.mobileFactId = mobileFactId
    }
}

public struct CaptureCoverage {
    public var status: String
    public var gap: Bool
    public var committed: Bool
}

public struct CaptureFactRef {
    public var mobileFactId: String
    public var stream: String
    public var captureId: Int64
    public var targetKey: String? = nil
    public var runtimeEpoch: String? = nil
    public var capturedAtMs: Int64? = nil
}

public struct CapturePage {
    public var ok: Bool
    public var type: String
    public var items: [[String: Any]]
    public var count: Int
    public var coverage: CaptureCoverage
    public var gap: Bool
    public var hasMore: Bool
    public var refs: [CaptureFactRef]
    public var values: [String: Any]
    public var nextCursor: String? = nil
    public var watermarkCursor: String? = nil
    public var runtimeEpoch: String? = nil
    public var targetKey: String? = nil
    public var storeGeneration: Int64? = nil
    public var throughWatermark: Int64? = nil
    public var reason: String? = nil
    public var window: [String: Any]? = nil

    static func unavailable(_ stream: String, _ reason: String) -> CapturePage {
        CapturePage(ok: false, type: stream, items: [], count: 0,
                    coverage: CaptureCoverage(status: "unavailable", gap: true, committed: false),
                    gap: true, hasMore: false, refs: [], values: [:], reason: reason)
    }
}

public struct CaptureWatermark {
    public var streams: [String: Int64]
}

public struct ClearReceipt {
    public var ok: Bool
    public var generation: Int64
    public var reason: String? = nil
}

public struct StreamStatus {
    public var count: Int
    public var ownedBytes: Int64
    public var dropped: Int64
    public var gap: Bool
}

public struct CaptureStoreStatus {
    public var persistent: Bool
    public var generation: Int64
    public var ownedBytes: Int64
    public var budgetBytes: Int64
    public var dropped: Int64
    public var streams: [String: StreamStatus]
    public var reason: String? = nil
    public var pendingRecords: Int = 0
    public var pendingBytes: Int = 0
}

public struct ByteBudgets {
    public var logs: Int
    public var network: Int
    public var events: Int
    public var state: Int

    public init(logs: Int = 256 * 1024, network: Int = 384 * 1024, events: Int = 256 * 1024, state: Int = 128 * 1024) {
        self.logs = logs
        self.network = network
        self.events = events
        self.state = state
    }

    public func total() -> Int { logs + network + events + state }

    public func bytes(for stream: String) -> Int {
        switch stream {
        case "logs": return logs
        case "network": return network
        case "events": return events
        case "state": return state
        default: return 0
        }
    }
}

public struct CountCaps {
    public var logs: Int
    public var network: Int
    public var events: Int
    public var state: Int

    public init(logs: Int = 4096, network: Int = 2048, events: Int = 4096, state: Int = 512) {
        self.logs = logs
        self.network = network
        self.events = events
        self.state = state
    }

    public func cap(for stream: String) -> Int {
        switch stream {
        case "logs": return logs
        case "network": return network
        case "events": return events
        case "state": return state
        default: return 0
        }
    }
}

public final class MobileCaptureStore {
    private struct PendingAppend {
        let input: CaptureInput
        let durability: String
        let completion: (AppendReceipt) -> Void
    }

    // This queue only bridges store opening; queries never read it. A receipt
    // is delivered after the persistent backend assigns the original identity.
    private let maxPendingRecords = 256
    private let maxPendingBytes = 1024 * 1024
    private var opening = false
    private var pending: [PendingAppend] = []
    private var pendingBytes = 0
    private var backend: SegmentedCaptureBackend?
    private let budgets: ByteBudgets
    private let caps: CountCaps
    private var attachmentLoss = false
    private var attachmentVersion = 0
    private var unavailableReason = "capture_store_unavailable"
    private let lock = NSLock()

    public init(budgets: ByteBudgets = ByteBudgets(), caps: CountCaps = CountCaps()) {
        self.budgets = budgets
        self.caps = caps
    }

    func beginOpening() {
        lock.lock()
        defer { lock.unlock() }
        precondition(!opening && backend == nil && pending.isEmpty)
        opening = true
        unavailableReason = "capture_store_opening"
    }

    // Lifecycle calls this after each open. The token prevents a late writer
    // callback from attaching a store that has already been stopped/replaced.
    func attachPersistentStore(_ store: SegmentedFactStore, directory: URL,
                               targetKey: String, runtimeEpoch: String) {
        lock.lock()
        attachmentVersion += 1
        let version = attachmentVersion
        backend?.invalidate()
        backend = nil
        opening = true
        unavailableReason = "capture_store_opening"
        lock.unlock()
        store.status { [self] status in
            lock.lock()
            guard version == attachmentVersion else { lock.unlock(); return }
            if status.state == .open, status.operation.isSuccess {
                do {
                    backend = try SegmentedCaptureBackend(store: store, directory: directory,
                        targetKey: targetKey, runtimeEpoch: runtimeEpoch,
                        epochStartSequence: status.nextSequence > 0 ? status.nextSequence - 1 : 0,
                        budgets: budgets, caps: caps, initialLoss: attachmentLoss, existingRecords: status.recordCount)
                    attachmentLoss = false
                } catch { unavailableReason = "capture_metadata_unavailable" }
            } else {
                unavailableReason = "capture_store_unavailable"
            }
            let queued = pending
            pending = []
            pendingBytes = 0
            opening = false
            if backend == nil && !queued.isEmpty { attachmentLoss = true }
            // Submit all startup writes before publishing the backend to a
            // concurrent query and its durable watermark barrier.
            let receipts = queued.map { entry in
                backend?.append(entry.input, durability: entry.durability) ?? rejected(unavailableReason)
            }
            lock.unlock()
            for (entry, receipt) in zip(queued, receipts) { entry.completion(receipt) }
        }
    }

    func detachPersistentStore(reason: String = "capture_store_unavailable") {
        lock.lock()
        attachmentVersion += 1
        backend?.invalidate()
        backend = nil
        opening = false
        unavailableReason = reason
        let queued = pending
        pending = []
        pendingBytes = 0
        if !queued.isEmpty { attachmentLoss = true }
        lock.unlock()
        for entry in queued { entry.completion(rejected(reason)) }
    }

    // Completion may run on the store writer, like SegmentedFactStore's own
    // callbacks. It must not synchronously wait for a disk query on that writer.
    public func append(_ record: CaptureInput, durability: String = "async",
                       completion: @escaping (AppendReceipt) -> Void) {
        lock.lock()
        if let backend {
            let receipt = backend.append(record, durability: durability)
            lock.unlock()
            completion(receipt)
            return
        }
        var reason = unavailableReason
        if opening {
            do {
                let data = try JSONSerialization.data(withJSONObject: record.record, options: [.sortedKeys])
                let byteCount = data.count + record.stream.utf8.count + record.targetKey.utf8.count
                    + record.runtimeEpoch.utf8.count + record.source.utf8.count
                    + (record.actionId?.utf8.count ?? 0) + (record.stateKey?.utf8.count ?? 0)
                if pending.count >= maxPendingRecords || byteCount > maxPendingBytes - pendingBytes {
                    reason = "capture_startup_queue_full"
                } else {
                    var snapshot = record
                    snapshot.record = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                    pending.append(PendingAppend(input: snapshot, durability: durability, completion: completion))
                    pendingBytes += byteCount
                    lock.unlock()
                    return
                }
            } catch { reason = "invalid_capture_payload" }
        }
        attachmentLoss = true
        lock.unlock()
        completion(rejected(reason))
    }

    private func rejected(_ reason: String) -> AppendReceipt {
        AppendReceipt(status: "dropped", accepted: false, committed: false, dropped: true,
                      deduplicated: false, mobileFactId: nil, reason: reason)
    }

    public func mark(_ streams: [String]) -> CaptureWatermark {
        lock.lock()
        defer { lock.unlock() }
        return backend?.mark(streams) ?? CaptureWatermark(streams: [:])
    }

    public func query(_ query: CaptureQuery) -> CapturePage {
        lock.lock()
        let selected = backend
        let reason = unavailableReason
        lock.unlock()
        return selected?.query(query) ?? .unavailable(query.stream, reason)
    }

    public func status() -> CaptureStoreStatus {
        lock.lock()
        defer { lock.unlock() }
        return backend?.status() ?? CaptureStoreStatus(persistent: false, generation: 0,
            ownedBytes: 0, budgetBytes: Int64(budgets.total()), dropped: attachmentLoss ? 1 : 0,
            streams: Dictionary(uniqueKeysWithValues: ["logs", "network", "events", "state"].map {
                ($0, StreamStatus(count: 0, ownedBytes: 0, dropped: attachmentLoss ? 1 : 0, gap: attachmentLoss))
            }), reason: unavailableReason, pendingRecords: pending.count, pendingBytes: pendingBytes)
    }

    public func clear(_ scope: String = "all") -> ClearReceipt {
        lock.lock()
        defer { lock.unlock() }
        return backend?.clear(scope) ?? ClearReceipt(ok: false, generation: 0, reason: "capture_store_unavailable")
    }
}
