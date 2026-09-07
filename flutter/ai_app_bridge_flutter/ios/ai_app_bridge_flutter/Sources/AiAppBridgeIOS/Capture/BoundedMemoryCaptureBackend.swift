import Foundation

final class BoundedMemoryCaptureBackend {
    private let budgets: ByteBudgets
    private let caps: CountCaps
    private var generation: Int64 = 1
    private var sequence: Int64 = 0
    private var streams: [String: StreamBuffer]

    init(budgets: ByteBudgets, caps: CountCaps) {
        self.budgets = budgets
        self.caps = caps
        streams = [
            "logs": StreamBuffer(name: "logs", budgets: budgets, caps: caps),
            "network": StreamBuffer(name: "network", budgets: budgets, caps: caps),
            "events": StreamBuffer(name: "events", budgets: budgets, caps: caps),
            "state": StreamBuffer(name: "state", budgets: budgets, caps: caps),
        ]
    }

    func append(_ record: CaptureInput, durability: String) -> AppendReceipt {
        guard let stream = streams[record.stream] else {
            return AppendReceipt(status: "dropped", accepted: false, committed: false, dropped: true, deduplicated: false, mobileFactId: nil, reason: "unknown_stream")
        }
        let identity = "\(record.targetKey)|\(record.runtimeEpoch)|\(record.stream)|\(record.captureId)"
        if stream.ids[identity] != nil {
            return AppendReceipt(status: "volatile", accepted: true, committed: false, dropped: false, deduplicated: true, mobileFactId: nil, reason: nil)
        }
        let bytes = jsonBytes(record.record)
        sequence += 1
        let factId = "mf1:\(generation):\(sequence):\(hashPrefix(bytes))"
        let stored = stream.append(
            StoredFact(
                identity: identity,
                stream: record.stream,
                stateKey: record.stateKey,
                captureId: record.captureId,
                timestampMs: record.timestampMs,
                actionId: record.actionId,
                bytes: bytes,
                mobileFactId: factId,
                globalSequence: sequence
            )
        )
        if !stored {
            sequence -= 1
            stream.gap = true
            stream.dropped += 1
            return AppendReceipt(status: "dropped", accepted: false, committed: false, dropped: true, deduplicated: false, mobileFactId: nil, reason: "queue-full")
        }
        stream.ids[identity] = factId
        return AppendReceipt(status: "volatile", accepted: true, committed: false, dropped: false, deduplicated: false, mobileFactId: nil, reason: nil)
    }

    func mark(_ names: [String]) -> CaptureWatermark {
        var marked: [String: Int64] = [:]
        for name in names {
            marked[name] = streams[name]?.facts.last?.captureId ?? 0
        }
        return CaptureWatermark(streams: marked)
    }

    func query(_ query: CaptureQuery) -> CapturePage {
        guard let stream = streams[query.stream] else {
            return CapturePage(
                ok: false,
                type: query.stream,
                items: [],
                count: 0,
                coverage: CaptureCoverage(status: "unavailable", gap: true, committed: false),
                gap: true,
                hasMore: false,
                refs: [],
                values: [:]
            )
        }
        let filtered = stream.visible().filter { fact in
            if let sinceId = query.sinceId, fact.captureId <= sinceId { return false }
            if let sinceMs = query.sinceMs, fact.timestampMs < sinceMs { return false }
            if query.view == "decision-window", let actionId = query.afterActionId, fact.actionId != actionId {
                return false
            }
            return true
        }
        let limit = resolveLimit(query)
        let limited = filtered.count > limit ? Array(filtered.suffix(limit)) : filtered
        let items = limited.map { jsonObject($0.bytes) }
        let refs: [CaptureFactRef] = []
        var values: [String: Any] = [:]
        if query.stream == "state" {
            for fact in limited {
                let parsed = jsonObject(fact.bytes)
                values[fact.stateKey ?? String(describing: parsed["stateKey"] ?? "")] = parsed["value"] ?? NSNull()
            }
        }
        let gap = stream.gap
        return CapturePage(
            ok: true,
            type: query.stream,
            items: items,
            count: items.count,
            coverage: CaptureCoverage(status: gap ? "partial" : "unavailable", gap: gap, committed: false),
            gap: gap,
            hasMore: filtered.count > limited.count,
            refs: refs,
            values: values
        )
    }

    func status() -> CaptureStoreStatus {
        let streamStatus = streams.mapValues { stream in
            StreamStatus(count: stream.visible().count, ownedBytes: stream.ownedBytes, dropped: stream.dropped, gap: stream.gap)
        }
        return CaptureStoreStatus(
            persistent: false,
            generation: generation,
            ownedBytes: streamStatus.values.reduce(0) { $0 + $1.ownedBytes },
            budgetBytes: Int64(budgets.total()),
            dropped: streamStatus.values.reduce(0) { $0 + $1.dropped },
            streams: streamStatus
        )
    }

    func clear(_ scope: String) -> ClearReceipt {
        if scope == "all" {
            streams.values.forEach { $0.clear() }
        } else {
            streams[scope]?.clear()
        }
        generation += 1
        return ClearReceipt(ok: true, generation: generation)
    }

    private func resolveLimit(_ query: CaptureQuery) -> Int {
        return Swift.max(query.limit ?? 200, 1)
    }
}

private final class StreamBuffer {
    let name: String
    let budgets: ByteBudgets
    let caps: CountCaps
    var facts: [StoredFact] = []
    var ids: [String: String] = [:]
    var stateOrder: [String] = []
    var stateFacts: [String: StoredFact] = [:]
    var ownedBytes: Int64 = 0
    var dropped: Int64 = 0
    var gap = false

    init(name: String, budgets: ByteBudgets, caps: CountCaps) {
        self.name = name
        self.budgets = budgets
        self.caps = caps
    }

    func append(_ fact: StoredFact) -> Bool {
        if fact.bytes.count > budgets.bytes(for: name) { return false }
        if name == "state" {
            guard let key = fact.stateKey else { return false }
            if let existing = stateFacts.removeValue(forKey: key) {
                facts.removeAll { $0.identity == existing.identity }
                stateOrder.removeAll { $0 == key }
                ownedBytes -= Int64(existing.bytes.count)
                ids.removeValue(forKey: existing.identity)
            }
        }
        evictWhileNeeded(incoming: fact.bytes.count)
        if facts.count >= caps.cap(for: name) || ownedBytes + Int64(fact.bytes.count) > Int64(budgets.bytes(for: name)) {
            return false
        }
        facts.append(fact)
        ownedBytes += Int64(fact.bytes.count)
        if name == "state", let key = fact.stateKey {
            stateFacts[key] = fact
            stateOrder.append(key)
        }
        return true
    }

    func visible() -> [StoredFact] {
        if name == "state" {
            return stateOrder.compactMap { stateFacts[$0] }
        }
        return facts
    }

    func clear() {
        facts.removeAll()
        ids.removeAll()
        stateOrder.removeAll()
        stateFacts.removeAll()
        ownedBytes = 0
        dropped = 0
        gap = false
    }

    private func evictWhileNeeded(incoming: Int) {
        let budget = budgets.bytes(for: name)
        let cap = caps.cap(for: name)
        while !facts.isEmpty && (facts.count >= cap || ownedBytes + Int64(incoming) > Int64(budget)) {
            evictOldest()
        }
    }

    private func evictOldest() {
        gap = true
        dropped += 1
        if name == "state" {
            guard let key = stateOrder.first else { return }
            stateOrder.removeFirst()
            if let existing = stateFacts.removeValue(forKey: key) {
                facts.removeAll { $0.identity == existing.identity }
                ownedBytes -= Int64(existing.bytes.count)
                ids.removeValue(forKey: existing.identity)
            }
            return
        }
        let first = facts.removeFirst()
        ownedBytes -= Int64(first.bytes.count)
        ids.removeValue(forKey: first.identity)
    }
}

private struct StoredFact {
    var identity: String
    var stream: String
    var stateKey: String?
    var captureId: Int64
    var timestampMs: Int64
    var actionId: String?
    var bytes: Data
    var mobileFactId: String?
    var globalSequence: Int64
}

private func jsonBytes(_ record: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])) ?? Data()
}

private func jsonObject(_ data: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

private func hashPrefix(_ bytes: Data) -> String {
    var hash: UInt32 = 0x811c9dc5
    for byte in bytes {
        hash ^= UInt32(byte)
        hash = hash &* 16777619
    }
    return String(format: "%08x", hash)
}
