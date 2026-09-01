import CryptoKit
import Foundation

enum MobileFactPartition: UInt32 {
    case network = 0
    case ui = 1
    case appLog = 2
    case deviceLog = 3
    case stateEvent = 4
    case action = 5
    case note = 6
    case index = 7

    var wireName: String {
        switch self {
        case .network: return "network"
        case .ui: return "ui"
        case .appLog: return "app-log"
        case .deviceLog: return "device-log"
        case .stateEvent: return "state-event"
        case .action: return "action"
        case .note: return "note"
        case .index: return "index"
        }
    }
}

struct MobileFactEnvelopeContext: Sendable {
    let platform: String
    let packageName: String?
    let bundleId: String?
    let model: String
    let deviceIdentity: String
    let runtimeEpoch: String
    let actionId: String?
    let occurredAtMs: Int64
    let observedAtMs: Int64
}

struct SanitizedFactPayload {
    let data: Data
    let partitionId: UInt32

    static func log(context: MobileFactEnvelopeContext, record: [String: Any]) throws -> Self {
        try capture(context: context, partition: .appLog, stream: "logs", record: record)
    }

    static func deviceLog(context: MobileFactEnvelopeContext, record: [String: Any]) throws -> Self {
        try capture(context: context, partition: .deviceLog, stream: "logcat", record: record)
    }

    static func network(context: MobileFactEnvelopeContext, record: [String: Any]) throws -> Self {
        try capture(context: context, partition: .network, stream: "network", record: record)
    }

    static func state(context: MobileFactEnvelopeContext, record: [String: Any]) throws -> Self {
        try capture(context: context, partition: .stateEvent, stream: "state", record: record)
    }

    static func event(
        context: MobileFactEnvelopeContext,
        category: String,
        name: String,
        data: [String: Any]
    ) throws -> Self {
        try capture(
            context: context,
            partition: isUiEvent(category: category, name: name) ? .ui : .stateEvent,
            stream: "events",
            record: ["category": category, "name": name, "data": data]
        )
    }

    static func event(
        context: MobileFactEnvelopeContext,
        record: [String: Any]
    ) throws -> Self {
        let category = record["category"] as? String ?? "app"
        let name = record["name"] as? String ?? "event"
        return try capture(
            context: context,
            partition: isUiEvent(category: category, name: name) ? .ui : .stateEvent,
            stream: "events",
            record: record
        )
    }

    static func observation(
        context: MobileFactEnvelopeContext,
        category: String,
        name: String,
        data: [String: Any]
    ) throws -> Self {
        try capture(
            context: context,
            partition: .ui,
            stream: "events",
            record: ["category": category, "name": name, "data": data]
        )
    }

    static func stableDeviceIdentity(
        platform: String,
        appIdentifier: String,
        rawIdentity: String
    ) -> String {
        let input = Data("aiappbridge-device-v1\0\(platform)\0\(appIdentifier)\0\(rawIdentity)".utf8)
        let digest = SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
        return "sha256:\(digest)"
    }

    private static func capture(
        context: MobileFactEnvelopeContext,
        partition: MobileFactPartition,
        stream: String,
        record: [String: Any]
    ) throws -> Self {
        let appIdentifier = context.packageName ?? context.bundleId ?? "unknown"
        var app: [String: Any] = [
            "platform": context.platform,
            "model": context.model,
            "deviceIdentity": context.deviceIdentity
        ]
        if let packageName = context.packageName { app["packageName"] = packageName }
        if let bundleId = context.bundleId { app["bundleId"] = bundleId }
        let envelope: [String: Any] = [
            "schema": "aiappbridge.fact.v1",
            "partition": partition.wireName,
            "platform": context.platform,
            "targetKey": "\(context.platform):\(context.deviceIdentity):\(appIdentifier)",
            "app": app,
            "runtimeEpoch": context.runtimeEpoch,
            "actionId": context.actionId ?? NSNull(),
            "dedupeKey": NSNull(),
            "timestamps": [
                "occurredAtMs": context.occurredAtMs,
                "observedAtMs": context.observedAtMs,
                "ingestedAtMs": context.observedAtMs
            ],
            "payload": [
                "kind": "evidence",
                "stream": stream,
                "record": record
            ]
        ]
        return .init(
            data: try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys]),
            partitionId: partition.rawValue
        )
    }

    private static func isUiEvent(category: String, name: String) -> Bool {
        let category = category.lowercased()
        let name = name.lowercased()
        return category == "ui"
            || category.hasPrefix("ui.")
            || category == "interaction"
            || category == "lifecycle"
            || name.hasPrefix("ui.")
            || name.hasPrefix("lifecycle.")
    }

}

enum IOSObservationFactStoreRegistry {
    private static let lock = NSLock()
    private static weak var store: SegmentedFactStore?

    static func attach(_ store: SegmentedFactStore) {
        lock.lock()
        self.store = store
        lock.unlock()
    }

    static func detach(_ store: SegmentedFactStore) {
        lock.lock()
        if self.store === store {
            self.store = nil
        }
        lock.unlock()
    }

    static func enqueue(_ payload: SanitizedFactPayload) {
        lock.lock()
        let target = store
        lock.unlock()
        target?.record(payload.data, partitionId: payload.partitionId)
    }
}
