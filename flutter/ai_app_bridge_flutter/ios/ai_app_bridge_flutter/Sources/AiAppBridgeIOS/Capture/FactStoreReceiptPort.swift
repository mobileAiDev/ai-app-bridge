import Foundation

struct FactReceipt: Equatable, Sendable {
    var status: String
    var accepted: Bool
    var committed: Bool
    var storeGeneration: Int64
    var mobileFactId: String?
    var globalSequence: Int64?
}

struct FactCursor: Equatable, Sendable {
    var storeGeneration: Int64
    var afterSequence: Int64 = 0
}

struct FactPageItem: Equatable, Sendable {
    var mobileFactId: String
    var payload: Data
    var partitionId: UInt32
    var globalSequence: Int64
    var committed: Bool
}

struct FactPage: Equatable, Sendable {
    var items: [FactPageItem]
    var storeGeneration: Int64
    var generationMismatch: Bool = false
}

struct DrainResult: Equatable, Sendable {
    var ok: Bool
    var committed: Int
}

struct ThroughWatermark: Equatable, Sendable {
    var throughSequence: Int64
    var storeGeneration: Int64
}

final class FactStoreReceiptPort: @unchecked Sendable {
    static let sidecarName = "receipt-index-v1.jsonl"

    private let store: SegmentedFactStore
    private let sidecar: URL
    private let lock = NSLock()
    private var pending: [String: PendingFact] = [:]
    private var pendingOrder: [String] = []
    private var aliases: [String: String] = [:]
    private var dropped: Set<String> = []
    private var index: [String: IndexEntry] = [:]
    private var indexOrder: [String] = []
    private var generation: Int64 = 1
    private var sequence: Int64 = 0
    private var generationFloor: Int64 = 0
    private var storeHighWater: Int64 = 0

    init(store: SegmentedFactStore, directory: URL) {
        self.store = store
        self.sidecar = directory.appendingPathComponent(Self.sidecarName)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        loadSidecar()
        hydrateFromStore()
        storeHighWater = index.values.map(\.globalSequence).max() ?? 0
    }

    func appendWithReceipt(
        _ payload: Data,
        partitionId: UInt32 = 0,
        durability: String = "async"
    ) -> FactReceipt {
        let enqueue = store.recordForReceipt(payload, partitionId: partitionId, durability: durabilityOf(durability))
        if enqueue != .accepted {
            return receipt(of: enqueue)
        }
        lock.lock()
        defer { lock.unlock() }
        sequence += 1
        let mobileFactId = "mf1:\(generation):\(sequence):\(receiptHashPrefix(payload))"
        pending[mobileFactId] = PendingFact(
            mobileFactId: mobileFactId,
            payload: payload,
            partitionId: partitionId,
            localSequence: sequence
        )
        pendingOrder.append(mobileFactId)
        return FactReceipt(
            status: "accepted",
            accepted: true,
            committed: false,
            storeGeneration: generation,
            mobileFactId: mobileFactId,
            globalSequence: nil
        )
    }

    func commitWait(mobileFactId: String, timeoutMs: Int) -> FactReceipt {
        if !drainWriter(timeoutMs: timeoutMs) {
            lock.lock()
            defer { lock.unlock() }
            return receiptAfterWait(mobileFactId)
        }
        promoteCommitted(markUnmatchedDropped: true)
        lock.lock()
        defer { lock.unlock() }
        return receiptAfterWait(mobileFactId)
    }

    func readPage(cursor: FactCursor, limit: Int) -> FactPage {
        lock.lock()
        defer { lock.unlock() }
        if cursor.storeGeneration != generation {
            return FactPage(items: [], storeGeneration: generation, generationMismatch: true)
        }
        var items: [FactPageItem] = []
        for id in indexOrder {
            guard let entry = index[id] else { continue }
            if entry.globalSequence <= cursor.afterSequence { continue }
            if items.count == limit { break }
            items.append(entry.item())
        }
        for id in pendingOrder {
            if items.count == limit { break }
            guard let held = pending[id] else { continue }
            items.append(held.item())
        }
        return FactPage(items: items, storeGeneration: generation)
    }

    func flushDrain(timeoutMs: Int) -> DrainResult {
        if !awaitFlush(timeoutMs: timeoutMs) {
            return DrainResult(ok: false, committed: 0)
        }
        lock.lock()
        let before = index.count
        lock.unlock()
        promoteCommitted(markUnmatchedDropped: true)
        lock.lock()
        let after = index.count
        lock.unlock()
        return DrainResult(ok: true, committed: after - before)
    }

    func clear() -> Int64 {
        let floor = readAllStoreRecords().map(\.sequence).max().map(Int64.init) ?? 0
        _ = store.takeReceiptOutcomes()
        lock.lock()
        defer { lock.unlock() }
        generation += 1
        sequence = 0
        generationFloor = max(generationFloor, floor)
        storeHighWater = max(storeHighWater, generationFloor)
        pending.removeAll()
        pendingOrder.removeAll()
        aliases.removeAll()
        dropped.removeAll()
        index.removeAll()
        indexOrder.removeAll()
        let row = #"{"op":"clear","generation":\#(generation),"throughSequence":\#(generationFloor)}"# + "\n"
        appendSidecar(row)
        return generation
    }

    func storeGeneration() -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return generation
    }

    func throughWatermark() -> ThroughWatermark {
        lock.lock()
        defer { lock.unlock() }
        return ThroughWatermark(
            throughSequence: index.values.map(\.globalSequence).max() ?? 0,
            storeGeneration: generation
        )
    }

    private func receiptAfterWait(_ mobileFactId: String) -> FactReceipt {
        if dropped.contains(mobileFactId) {
            return droppedReceipt(mobileFactId, generation: generation)
        }
        if let held = pending[mobileFactId] {
            return held.receipt(generation: generation)
        }
        if let aliased = aliases[mobileFactId], let entry = index[aliased] {
            return entry.receipt(currentGeneration: generation)
        }
        if let entry = index[mobileFactId] {
            return entry.receipt(currentGeneration: generation)
        }
        return droppedReceipt(mobileFactId, generation: generation)
    }

    private func promoteCommitted(markUnmatchedDropped: Bool) {
        let records = readAllStoreRecords()
        let outcomes = store.takeReceiptOutcomes()
        lock.lock()
        defer { lock.unlock() }
        let taken = Set(index.values.map(\.globalSequence))
        let fresh = records
            .map { (sequence: Int64($0.sequence), record: $0) }
            .filter { $0.sequence > generationFloor && !taken.contains($0.sequence) }
            .sorted { $0.sequence < $1.sequence }
        let successCount = outcomes.filter { $0 }.count
        let newlyWritten = successCount == 0 ? [] : Array(fresh.suffix(successCount))
        let preexisting = successCount == 0 ? fresh : Array(fresh.dropLast(successCount))
        var remaining = pending
        var remainingOrder = pendingOrder
        var promoted: [IndexEntry] = []
        for item in preexisting {
            promoted.append(commitStoreRecord(item.record, acceptId: nil))
        }
        var writtenIndex = 0
        var outcomeIndex = 0
        for id in pendingOrder {
            guard remaining[id] != nil else { continue }
            if outcomeIndex >= outcomes.count { break }
            let success = outcomes[outcomeIndex]
            outcomeIndex += 1
            remaining.removeValue(forKey: id)
            remainingOrder.removeAll { $0 == id }
            if !success {
                if markUnmatchedDropped {
                    dropped.insert(id)
                } else if let held = pending[id] {
                    remaining[id] = held
                    remainingOrder.append(id)
                }
                continue
            }
            if writtenIndex >= newlyWritten.count {
                if markUnmatchedDropped { dropped.insert(id) }
                continue
            }
            let record = newlyWritten[writtenIndex].record
            writtenIndex += 1
            promoted.append(commitStoreRecord(record, acceptId: id))
        }
        while writtenIndex < newlyWritten.count {
            promoted.append(commitStoreRecord(newlyWritten[writtenIndex].record, acceptId: nil))
            writtenIndex += 1
        }
        if markUnmatchedDropped {
            for id in remaining.keys {
                dropped.insert(id)
            }
            remaining.removeAll()
            remainingOrder.removeAll()
        }
        pending = remaining
        pendingOrder = remainingOrder
        storeHighWater = max(storeHighWater, promoted.map(\.globalSequence).max() ?? 0)
        for entry in promoted {
            appendSidecar(entry.jsonLine())
        }
    }

    private func commitStoreRecord(_ record: SegmentedFactStoreRecord, acceptId: String?) -> IndexEntry {
        let sequence = Int64(record.sequence)
        let hash = receiptHashPrefix(record.payload)
        let committedId = "mf1:\(generation):\(sequence):\(hash)"
        if let acceptId, acceptId != committedId {
            aliases[acceptId] = committedId
        }
        let entry = IndexEntry(
            mobileFactId: committedId,
            payload: record.payload,
            partitionId: record.partitionId,
            globalSequence: sequence,
            generation: generation
        )
        index[committedId] = entry
        if !indexOrder.contains(committedId) {
            indexOrder.append(committedId)
        }
        return entry
    }

    private func appendSidecar(_ row: String) {
        ensureSidecarLineBoundary()
        guard let data = row.data(using: .utf8) else { return }
        if FileManager.default.fileExists(atPath: sidecar.path) {
            if let handle = try? FileHandle(forWritingTo: sidecar) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            }
        } else {
            try? data.write(to: sidecar)
        }
    }

    private func ensureSidecarLineBoundary() {
        guard let data = try? Data(contentsOf: sidecar), !data.isEmpty else { return }
        if data.last == UInt8(ascii: "\n") { return }
        guard let handle = try? FileHandle(forWritingTo: sidecar) else { return }
        handle.seekToEndOfFile()
        handle.write(Data("\n".utf8))
        try? handle.close()
    }

    private func readAllStoreRecords() -> [SegmentedFactStoreRecord] {
        var records: [SegmentedFactStoreRecord] = []
        var cursor = SegmentedFactStoreCursor()
        while true {
            guard let page = awaitRead(cursor) else { break }
            if page.isEnd || page.record == nil { break }
            records.append(page.record!)
            cursor = page.cursor
        }
        return records
    }

    private func drainWriter(timeoutMs: Int) -> Bool {
        waitForStore(timeoutMs: timeoutMs) { completion in
            store.status { _ in completion(true) }
        }
    }

    private func awaitFlush(timeoutMs: Int) -> Bool {
        waitForStore(timeoutMs: timeoutMs) { completion in
            store.flush { result in completion(result.isSuccess) }
        }
    }

    private func waitForStore(timeoutMs: Int, start: (@escaping (Bool) -> Void) -> Void) -> Bool {
        let lock = NSLock()
        var done = false
        var ok = false
        start { success in
            lock.lock()
            done = true
            ok = success
            lock.unlock()
        }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while Date() < deadline {
            lock.lock()
            let finished = done
            let success = ok
            lock.unlock()
            if finished { return success }
            Thread.sleep(forTimeInterval: 0.01)
        }
        lock.lock()
        let finished = done
        let success = ok
        lock.unlock()
        return finished && success
    }

    private func awaitRead(_ cursor: SegmentedFactStoreCursor) -> SegmentedFactStoreReadResult? {
        var capacity = 64 * 1024
        for _ in 0..<2 {
            guard let page = awaitReadOnce(cursor, bufferCapacity: capacity) else { return nil }
            if page.operation.code != SegmentedFactStoreResultCode.bufferTooSmall { return page }
            if page.requiredCapacity <= capacity { return page }
            capacity = page.requiredCapacity
        }
        return awaitReadOnce(cursor, bufferCapacity: capacity)
    }

    private func awaitReadOnce(
        _ cursor: SegmentedFactStoreCursor,
        bufferCapacity: Int
    ) -> SegmentedFactStoreReadResult? {
        let lock = NSLock()
        var value: SegmentedFactStoreReadResult?
        store.read(cursor: cursor, bufferCapacity: bufferCapacity) { result in
            lock.lock()
            value = result
            lock.unlock()
        }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            lock.lock()
            let current = value
            lock.unlock()
            if current != nil { return current }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return nil
    }

    private func loadSidecar() {
        guard let text = try? String(contentsOf: sidecar, encoding: .utf8) else { return }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.isEmpty { continue }
            guard let data = line.data(using: .utf8),
                  let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if row["op"] as? String == "clear" {
                generation = (row["generation"] as? NSNumber)?.int64Value ?? generation
                sequence = 0
                generationFloor = max(generationFloor, (row["throughSequence"] as? NSNumber)?.int64Value ?? 0)
                index.removeAll()
                indexOrder.removeAll()
                continue
            }
            guard let mobileFactId = row["mobileFactId"] as? String else { continue }
            let entry = IndexEntry(
                mobileFactId: mobileFactId,
                payload: Data(),
                partitionId: UInt32((row["partitionId"] as? NSNumber)?.intValue ?? 0),
                globalSequence: (row["globalSequence"] as? NSNumber)?.int64Value ?? 0,
                generation: (row["generation"] as? NSNumber)?.int64Value ?? 1
            )
                if entry.generation == generation {
                    index[mobileFactId] = entry
                    if !indexOrder.contains(mobileFactId) {
                        indexOrder.append(mobileFactId)
                    }
                    sequence = max(sequence, entry.localSequence())
                }
        }
    }

    private func hydrateFromStore() {
        lock.lock()
        let empty = index.isEmpty
        lock.unlock()
        if empty { return }
        let records = readAllStoreRecords()
        lock.lock()
        defer { lock.unlock() }
        let bySequence = Dictionary(uniqueKeysWithValues: records.map { (Int64($0.sequence), $0) })
        var hydrated: [String: IndexEntry] = [:]
        for (id, entry) in index {
            guard let record = bySequence[entry.globalSequence] else { continue }
            guard receiptHashPrefix(record.payload) == hashFromId(id) else { continue }
            hydrated[id] = IndexEntry(
                mobileFactId: entry.mobileFactId,
                payload: record.payload,
                partitionId: record.partitionId,
                globalSequence: Int64(record.sequence),
                generation: entry.generation
            )
        }
        index = hydrated
    }

    private func receipt(of enqueue: SegmentedFactRecordEnqueueResult) -> FactReceipt {
        let status: String
        switch enqueue {
        case .queueFull: status = "queue-full"
        case .closed: status = "closed"
        case .disabled: status = "disabled"
        case .payloadTooLarge: status = "payload-too-large"
        case .accepted: status = "accepted"
        }
        lock.lock()
        let current = generation
        lock.unlock()
        return FactReceipt(
            status: status,
            accepted: false,
            committed: false,
            storeGeneration: current,
            mobileFactId: nil,
            globalSequence: nil
        )
    }

    private func droppedReceipt(_ mobileFactId: String, generation: Int64) -> FactReceipt {
        FactReceipt(
            status: "dropped",
            accepted: false,
            committed: false,
            storeGeneration: generation,
            mobileFactId: mobileFactId,
            globalSequence: nil
        )
    }

    private func durabilityOf(_ value: String) -> SegmentedFactStoreDurability {
        if value == "sync" { return .sync }
        if value == "async" { return .memory }
        preconditionFailure(value)
    }
}

private struct PendingFact {
    var mobileFactId: String
    var payload: Data
    var partitionId: UInt32
    var localSequence: Int64

    func receipt(generation: Int64) -> FactReceipt {
        FactReceipt(
            status: "accepted",
            accepted: true,
            committed: false,
            storeGeneration: generation,
            mobileFactId: mobileFactId,
            globalSequence: nil
        )
    }

    func item() -> FactPageItem {
        FactPageItem(
            mobileFactId: mobileFactId,
            payload: payload,
            partitionId: partitionId,
            globalSequence: localSequence,
            committed: false
        )
    }
}

private struct IndexEntry {
    var mobileFactId: String
    var payload: Data
    var partitionId: UInt32
    var globalSequence: Int64
    var generation: Int64

    func receipt(currentGeneration: Int64) -> FactReceipt {
        FactReceipt(
            status: "committed",
            accepted: true,
            committed: true,
            storeGeneration: currentGeneration,
            mobileFactId: mobileFactId,
            globalSequence: globalSequence
        )
    }

    func item() -> FactPageItem {
        FactPageItem(
            mobileFactId: mobileFactId,
            payload: payload,
            partitionId: partitionId,
            globalSequence: globalSequence,
            committed: true
        )
    }

    func jsonLine() -> String {
        #"{"mobileFactId":"\#(mobileFactId)","partitionId":\#(partitionId),"globalSequence":\#(globalSequence),"generation":\#(generation)}"# + "\n"
    }

    func localSequence() -> Int64 {
        let parts = mobileFactId.split(separator: ":")
        guard parts.count > 2, let value = Int64(parts[2]) else {
            preconditionFailure(mobileFactId)
        }
        return value
    }
}

private func receiptHashPrefix(_ bytes: Data) -> String {
    var hash: UInt32 = 0x811c9dc5
    for byte in bytes {
        hash ^= UInt32(byte)
        hash = hash &* 16777619
    }
    return String(format: "%08x", hash)
}

private func hashFromId(_ mobileFactId: String) -> String {
    String(mobileFactId.split(separator: ":")[3])
}
