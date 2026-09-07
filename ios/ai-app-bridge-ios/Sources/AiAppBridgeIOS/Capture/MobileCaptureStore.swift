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

    public init(
        view: String,
        stream: String,
        sinceId: Int64? = nil,
        sinceMs: Int64? = nil,
        limit: Int? = nil,
        platform: String = "ios",
        afterActionId: String? = nil
    ) {
        self.view = view
        self.stream = stream
        self.sinceId = sinceId
        self.sinceMs = sinceMs
        self.limit = limit
        self.platform = platform
        self.afterActionId = afterActionId
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
}

public struct CaptureWatermark {
    public var streams: [String: Int64]
}

public struct ClearReceipt {
    public var ok: Bool
    public var generation: Int64
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
    private let backend: BoundedMemoryCaptureBackend
    private let lock = NSLock()

    public init(budgets: ByteBudgets = ByteBudgets(), caps: CountCaps = CountCaps()) {
        backend = BoundedMemoryCaptureBackend(budgets: budgets, caps: caps)
    }

    public func append(_ record: CaptureInput, durability: String = "async") -> AppendReceipt {
        lock.lock()
        defer { lock.unlock() }
        return backend.append(record, durability: durability)
    }

    public func mark(_ streams: [String]) -> CaptureWatermark {
        lock.lock()
        defer { lock.unlock() }
        return backend.mark(streams)
    }

    public func query(_ query: CaptureQuery) -> CapturePage {
        lock.lock()
        defer { lock.unlock() }
        return backend.query(query)
    }

    public func status() -> CaptureStoreStatus {
        lock.lock()
        defer { lock.unlock() }
        return backend.status()
    }

    public func clear(_ scope: String = "all") -> ClearReceipt {
        lock.lock()
        defer { lock.unlock() }
        return backend.clear(scope)
    }
}
