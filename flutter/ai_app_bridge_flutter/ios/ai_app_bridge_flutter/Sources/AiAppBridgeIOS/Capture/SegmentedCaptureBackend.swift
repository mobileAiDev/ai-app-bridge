import CoreFoundation
import CryptoKit
import Darwin
import Foundation

// The segmented store owns every payload. Only bounded identity/prefix metadata
// is retained here. Accepted means queued; committed means readable from the
// original store after an atomic flush/watermark checkpoint.
final class SegmentedCaptureBackend {
    static let streams = ["logs", "network", "events", "state"]
    private let store: SegmentedFactStore
    private let metadataURL: URL
    private let targetKey: String
    private let runtimeEpoch: String
    private let epochStartSequence: UInt64
    private let budgets: ByteBudgets
    private let caps: CountCaps
    private let lock = NSLock()
    private var metadata: Metadata
    private var metadataError = false
    private var invalidated = false
    private var lossSaveScheduled = false
    private var recent: [String: String] = [:]
    private var recentOrder: [String] = []
    private var indexes: [String: ReadIndex]
    private var counts: [String: Int]

    init(store: SegmentedFactStore, directory: URL, targetKey: String, runtimeEpoch: String,
         epochStartSequence: UInt64, budgets: ByteBudgets, caps: CountCaps,
         initialLoss: Bool, existingRecords: UInt64) throws {
        self.store = store
        self.metadataURL = directory.appendingPathComponent("capture-store-v2.json")
        self.targetKey = targetKey
        self.runtimeEpoch = runtimeEpoch
        self.budgets = budgets
        self.caps = caps
        indexes = [:]
        counts = Dictionary(uniqueKeysWithValues: Self.streams.map { ($0, 0) })
        let existed = FileManager.default.fileExists(atPath: metadataURL.path)
        if existed {
            metadata = try JSONDecoder().decode(Metadata.self, from: Data(contentsOf: metadataURL))
            guard metadata.version == 2, UUID(uuidString: metadata.namespace) != nil,
                  metadata.generation > 0, Set(metadata.generations.keys) == Set(Self.streams),
                  Set(metadata.losses.keys) == Set(Self.streams),
                  metadata.generations.values.allSatisfy({ $0 > 0 }),
                  metadata.targetKey == targetKey,
                  metadata.losses.values.allSatisfy({ $0.timestampMs >= 0 && $0.captureId >= 0 && UUID(uuidString: $0.version) != nil }),
                  metadata.epochFloor <= epochStartSequence else { throw CaptureFailure("capture_metadata_invalid") }
        } else {
            metadata = Metadata()
            metadata.targetKey = targetKey
        }
        if initialLoss || (!existed && existingRecords > 0) {
            for stream in Self.streams {
                metadata.losses[stream] = Loss(timestampMs: Self.nowMs(), captureId: 0, epoch: runtimeEpoch)
            }
        }
        let epochChanged = metadata.activeEpoch != runtimeEpoch
        if epochChanged {
            metadata.activeEpoch = runtimeEpoch
            metadata.epochFloor = epochStartSequence
        }
        self.epochStartSequence = metadata.epochFloor
        indexes = Dictionary(uniqueKeysWithValues: Self.streams.map {
            ($0, ReadIndex(metadata.epochFloor, trusted: metadata.epochFloor == epochStartSequence))
        })
        if !existed || initialLoss || epochChanged { try saveMetadata() }
    }

    func append(_ input: CaptureInput, durability: String) -> AppendReceipt {
        guard durability == "async" || durability == "sync" else { return rejected("invalid_durability") }
        guard Self.streams.contains(input.stream), input.targetKey == targetKey,
              input.runtimeEpoch == runtimeEpoch, (0...9_007_199_254_740_991).contains(input.captureId), (0...9_007_199_254_740_991).contains(input.timestampMs),
              input.stream != "state" || input.stateKey != nil else { return rejected("capture_identity_mismatch") }
        lock.lock()
        defer { lock.unlock() }
        guard !invalidated else { return rejected("capture_store_unavailable") }
        guard !metadataError else { return rejected("capture_metadata_unavailable") }
        let generation = metadata.generations[input.stream]!
        let identity = "\(metadata.namespace):\(generation):\(targetKey):\(runtimeEpoch):\(input.stream):\(input.captureId)"
        let content: Data
        do {
            content = try JSONSerialization.data(withJSONObject: ["record": input.record,
                "timestampMs": input.timestampMs, "actionId": input.actionId as Any? ?? NSNull(),
                "stateKey": input.stateKey as Any? ?? NSNull()], options: [.sortedKeys])
        } catch { return rejected("invalid_capture_payload") }
        let hash = Self.sha(content)
        if let previous = recent[identity] {
            return rejected(previous == hash ? "duplicate_capture_identity" : "capture_identity_collision")
        }
        let id = "mf2:\(metadata.namespace):\(generation):\(Self.sha(Data("\(identity):\(hash)".utf8)))"
        let payload: Data
        do {
            payload = try JSONSerialization.data(withJSONObject: [
                "schema": "aiappbridge.fact.v1", "targetKey": targetKey, "runtimeEpoch": runtimeEpoch,
                "partition": MobileFactPartition(rawValue: Self.partition(input.stream))!.wireName,
                "timestamps": ["occurredAtMs": input.timestampMs, "observedAtMs": input.timestampMs,
                               "ingestedAtMs": Self.nowMs()],
                "actionId": input.actionId as Any? ?? NSNull(),
                "capture": ["version": 2, "namespace": metadata.namespace, "generation": generation,
                    "mobileFactId": id, "captureId": input.captureId, "timestampMs": input.timestampMs,
                    "stateKey": input.stateKey as Any? ?? NSNull()],
                "payload": ["kind": "evidence", "stream": input.stream, "record": input.record]
            ], options: [.sortedKeys])
        } catch { return rejected("invalid_capture_payload") }
        let enqueue = store.appendWithReceipt(payload, partitionId: Self.partition(input.stream),
                                               durability: durability == "sync" ? .sync : .memory) { [self] receipt in
            lock.lock()
            defer { lock.unlock() }
            if receipt.operation.isSuccess && receipt.sequence > 0 {
                if metadata.generations[input.stream] == generation {
                    indexes[input.stream]!.commit(receipt.sequence, input.timestampMs, input.captureId, payload.count)
                }
            } else {
                noteLoss(input)
                do { try saveMetadata() } catch { metadataError = true }
            }
        }
        guard enqueue == .accepted else {
            noteLoss(input)
            if !lossSaveScheduled {
                lossSaveScheduled = true
                store.status { [self] _ in
                    lock.lock()
                    defer { lock.unlock() }
                    do { try saveMetadata() } catch { metadataError = true }
                    lossSaveScheduled = false
                }
            }
            let reason: String
            switch enqueue {
            case .accepted: preconditionFailure()
            case .closed: reason = "capture_store_unavailable"
            case .disabled: reason = "capture_store_disabled"
            case .queueFull: reason = "capture_queue_full"
            case .payloadTooLarge: reason = "capture_payload_too_large"
            }
            return rejected(reason)
        }
        recent[identity] = hash
        recentOrder.append(identity)
        if recentOrder.count > 1024 { recent.removeValue(forKey: recentOrder.removeFirst()) }
        counts[input.stream] = min(counts[input.stream]! + 1, caps.cap(for: input.stream))
        return AppendReceipt(status: "accepted", accepted: true, committed: false, dropped: false,
                             deduplicated: false, mobileFactId: id)
    }

    func query(_ query: CaptureQuery) -> CapturePage {
        guard Self.streams.contains(query.stream) else { return unavailable(query, "unknown_stream") }
        guard ["legacy-live", "decision-window", "connected-history"].contains(query.view),
              (1...1000).contains(query.limit ?? 200), query.sinceId == nil || query.sinceId! >= 0,
              query.sinceMs == nil || query.sinceMs! >= 0 else { return unavailable(query, "invalid_argument") }
        if let target = query.targetKey, target != targetKey { return unavailable(query, "target_mismatch") }
        if query.view == "connected-history", query.sinceId != nil, query.runtimeEpoch == nil {
            return unavailable(query, "runtime_epoch_required")
        }
        let currentEpochOnly = query.view != "connected-history"
        if currentEpochOnly, let epoch = query.runtimeEpoch, epoch != runtimeEpoch { return unavailable(query, "runtime_epoch_changed") }
        if query.view == "decision-window", query.afterActionId != nil,
           query.cursor == nil, query.sinceId == nil, query.sinceMs == nil { return unavailable(query, "decision_watermark_required") }
        let snapshot: Snapshot? = awaitWriter { done in
            store.durableStatus { [self] flushed, status in
                lock.lock()
                let index = indexes[query.stream]!
                let value = Snapshot(status: status, flushed: flushed.isSuccess, metadata: metadata, failed: metadataError || invalidated,
                    skipThrough: currentEpochOnly ? index.skip(query.sinceMs, query.sinceId, status.nextSequence > 0 ? status.nextSequence - 1 : 0) : 0,
                    watermark: index.captureId)
                lock.unlock()
                done(value)
            }
        }
        guard let snapshot else { return unavailable(query, "capture_writer_timeout") }
        guard snapshot.flushed else { return unavailable(query, "capture_flush_failed") }
        guard snapshot.status.state == .open, snapshot.status.operation.isSuccess else { return unavailable(query, "capture_store_unavailable") }
        guard !snapshot.failed else { return unavailable(query, "capture_metadata_unavailable") }
        let availableThrough = snapshot.status.nextSequence > 0 ? snapshot.status.nextSequence - 1 : 0
        let cursor: QueryCursor
        do { cursor = try decodeCursor(query.cursor, stream: query.stream, metadata: snapshot.metadata) }
        catch { return unavailable(query, "invalid_capture_cursor") }
        let through = cursor.through ?? availableThrough
        guard cursor.sequence <= through, through <= availableThrough else { return unavailable(query, "invalid_capture_cursor") }
        let loss = snapshot.metadata.losses[query.stream]!
        let requestedEpoch = currentEpochOnly ? runtimeEpoch : query.runtimeEpoch
        let afterLossTime = query.sinceMs.map { $0 > loss.timestampMs } ?? false
        let afterLossId = loss.captureId > 0 && requestedEpoch == loss.epoch && (query.sinceId.map { $0 >= loss.captureId } ?? false)
        var gap = loss.timestampMs > 0 && !afterLossTime && !afterLossId && cursor.lossVersion != loss.version
        var position = min(through, max(cursor.sequence, snapshot.skipThrough))
        let startSequence = position
        var selected: [DiskFact] = []
        var bytes = 0, scanned = 0, scannedBytes = 0
        var more = false, projected = false, finished = false
        let legacy = query.view == "legacy-live"
        let limit = query.limit ?? 200
        let start = DispatchTime.now().uptimeNanoseconds
        while !finished {
            let batchStart = position
            let batch: ([SegmentedFactStoreRecord], SegmentedFactStoreReadResult)? = awaitWriter { done in
                store.readPage(cursor: .init(partitionId: Self.partition(query.stream), afterSequence: position)) { done(($0, $1)) }
            }
            guard let (records, result) = batch else { return unavailable(query, "capture_read_timeout") }
            if !result.operation.isSuccess && !result.isEnd { return unavailable(query, "capture_read_failed") }
            for record in records {
                if record.sequence > through { finished = true; break }
                if record.gapLastSequence > startSequence { gap = true }
                let fact: DiskFact?
                do { fact = try parse(record) } catch { return unavailable(query, "capture_record_corrupt") }
                let matches = fact.map {
                    $0.namespace == snapshot.metadata.namespace && $0.generation == snapshot.metadata.generations[query.stream] &&
                    $0.stream == query.stream && $0.targetKey == targetKey &&
                    (requestedEpoch == nil || $0.epoch == requestedEpoch) &&
                    (query.sinceId == nil || $0.captureId > query.sinceId!) &&
                    (query.sinceMs == nil || $0.timestampMs >= query.sinceMs!) &&
                    (query.mobileFactId == nil || $0.id == query.mobileFactId) &&
                    (query.afterActionId == nil || $0.actionId == query.afterActionId)
                } ?? false
                if matches, let fact {
                    if !legacy && (selected.count >= limit || (!selected.isEmpty && bytes + fact.bytes > 2 * 1024 * 1024)) {
                        more = true; finished = true; break
                    }
                    if legacy && query.stream == "state", let previous = selected.firstIndex(where: { $0.stateKey == fact.stateKey }) {
                        bytes -= selected.remove(at: previous).bytes
                    }
                    selected.append(fact); bytes += fact.bytes
                    if legacy {
                        while selected.count > min(limit, caps.cap(for: query.stream)) || bytes > budgets.bytes(for: query.stream) {
                            bytes -= selected.removeFirst().bytes
                            projected = true
                        }
                    }
                }
                position = record.sequence
                scanned += 1; scannedBytes += record.payload.count
                if matches && query.mobileFactId != nil { finished = true; break }
                // Even a no-match history page makes durable cursor progress.
                // Do not scan an entire phone history to return an empty page.
                if scanned >= 1024 || scannedBytes >= 8 * 1024 * 1024 || DispatchTime.now().uptimeNanoseconds - start >= 2_000_000_000 {
                    more = position < through; finished = true; break
                }
            }
            if finished { break }
            if result.isEnd || position >= through { finished = true; break }
            if records.isEmpty || result.cursor.afterSequence <= batchStart { return unavailable(query, "capture_cursor_stalled") }
        }
        lock.lock()
        let changed = metadata.generation != snapshot.metadata.generation || metadataError || invalidated
        let newLoss = metadata.losses[query.stream]!.version != loss.version
        lock.unlock()
        if changed { return unavailable(query, "capture_store_changed") }
        if newLoss { return unavailable(query, "capture_store_changed") }
        if query.mobileFactId != nil && selected.isEmpty && !more { return unavailable(query, "mobile_fact_unavailable") }
        if query.mobileFactId != nil && selected.count == 1 { gap = false }
        let next = more ? encodeCursor(snapshot.metadata, query.stream, position, cursor.lossVersion, through: through) : nil
        var values: [String: Any] = [:]
        if query.stream == "state" {
            for fact in selected { values[fact.stateKey!] = fact.record["value"] ?? NSNull() }
        }
        return CapturePage(ok: true, type: query.stream, items: selected.map(\.record), count: selected.count,
            coverage: CaptureCoverage(status: gap || more || projected ? "partial" : "complete", gap: gap, committed: true),
            gap: gap, hasMore: more, refs: selected.map { CaptureFactRef(mobileFactId: $0.id, stream: $0.stream,
                captureId: $0.captureId, targetKey: $0.targetKey, runtimeEpoch: $0.epoch, capturedAtMs: $0.timestampMs) },
            values: values, nextCursor: next,
            watermarkCursor: encodeCursor(snapshot.metadata, query.stream, through, loss.version),
            runtimeEpoch: runtimeEpoch, targetKey: targetKey, storeGeneration: snapshot.metadata.generation,
            throughWatermark: snapshot.watermark, reason: gap ? "capture_gap" : more ? "capture_page_limit" : projected ? "capture_projection_limit" : nil,
            window: ["afterActionId": query.afterActionId as Any? ?? NSNull(), "sinceId": query.sinceId as Any? ?? NSNull(),
                     "sinceMs": query.sinceMs as Any? ?? NSNull(), "factCursor": query.cursor as Any? ?? NSNull(),
                     "runtimeEpoch": requestedEpoch as Any? ?? NSNull(), "targetKey": targetKey, "filterApplied": true])
    }

    func mark(_ streams: [String]) -> CaptureWatermark {
        lock.lock(); defer { lock.unlock() }
        return CaptureWatermark(streams: Dictionary(uniqueKeysWithValues: streams.compactMap { name in indexes[name].map { (name, $0.captureId) } }))
    }

    func status() -> CaptureStoreStatus {
        lock.lock(); defer { lock.unlock() }
        let streams = Dictionary(uniqueKeysWithValues: Self.streams.map { name in
            (name, StreamStatus(count: counts[name]!, ownedBytes: 0, dropped: metadata.losses[name]!.timestampMs > 0 ? 1 : 0,
                                gap: metadata.losses[name]!.timestampMs > 0))
        })
        return CaptureStoreStatus(persistent: !metadataError && !invalidated, generation: metadata.generation, ownedBytes: 0,
                                  budgetBytes: Int64(budgets.total()), dropped: streams.values.reduce(0) { $0 + $1.dropped }, streams: streams)
    }

    func clear(_ scope: String) -> ClearReceipt {
        lock.lock(); defer { lock.unlock() }
        guard scope == "all" || Self.streams.contains(scope) else { return ClearReceipt(ok: false, generation: metadata.generation, reason: "invalid_capture_scope") }
        guard !invalidated else { return ClearReceipt(ok: false, generation: metadata.generation, reason: "capture_store_unavailable") }
        guard !metadataError else { return ClearReceipt(ok: false, generation: metadata.generation, reason: "capture_metadata_unavailable") }
        metadata.generation += 1
        for stream in scope == "all" ? Self.streams : [scope] {
            metadata.generations[stream]! += 1
            counts[stream] = 0
            indexes[stream] = ReadIndex(epochStartSequence, trusted: false)
        }
        do { try saveMetadata() }
        catch { metadataError = true; return ClearReceipt(ok: false, generation: metadata.generation, reason: "capture_metadata_unavailable") }
        return ClearReceipt(ok: true, generation: metadata.generation)
    }

    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        invalidated = true
    }

    private func noteLoss(_ input: CaptureInput) {
        let old = metadata.losses[input.stream]!
        metadata.losses[input.stream] = Loss(timestampMs: max(old.timestampMs, input.timestampMs),
            captureId: old.epoch == runtimeEpoch ? max(old.captureId, input.captureId) : input.captureId, epoch: runtimeEpoch)
    }

    private func saveMetadata() throws {
        let data = try JSONEncoder().encode(metadata)
        let temporary = metadataURL.appendingPathExtension(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        let handle = try FileHandle(forWritingTo: temporary)
        do { try handle.synchronize(); try handle.close() }
        catch { try? handle.close(); throw error }
        guard Darwin.rename(temporary.path, metadataURL.path) == 0 else { throw CaptureFailure("capture_metadata_rename_failed") }
        let parent = Darwin.open(metadataURL.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard parent >= 0 else { throw CaptureFailure("capture_metadata_directory_failed") }
        defer { Darwin.close(parent) }
        guard Darwin.fsync(parent) == 0 else { throw CaptureFailure("capture_metadata_sync_failed") }
    }

    private func parse(_ record: SegmentedFactStoreRecord) throws -> DiskFact? {
        guard let row = try JSONSerialization.jsonObject(with: record.payload) as? [String: Any] else { throw CaptureFailure("capture_record_corrupt") }
        guard let capture = row["capture"] else { return nil }
        guard let capture = capture as? [String: Any], capture["version"] as? Int == 2,
              row["schema"] as? String == "aiappbridge.fact.v1",
              let payload = row["payload"] as? [String: Any], let item = payload["record"] as? [String: Any],
              payload["kind"] as? String == "evidence",
              let stream = payload["stream"] as? String, Self.streams.contains(stream),
              let namespace = capture["namespace"] as? String, let generation = Self.integer(capture["generation"]), generation > 0,
              let id = capture["mobileFactId"] as? String, let captureId = Self.integer(capture["captureId"]),
              let timestamp = Self.integer(capture["timestampMs"]), let target = row["targetKey"] as? String,
              let epoch = row["runtimeEpoch"] as? String,
              stream != "state" || capture["stateKey"] is String else { throw CaptureFailure("capture_record_corrupt") }
        let identity = "\(namespace):\(generation):\(target):\(epoch):\(stream):\(captureId)"
        let content = try JSONSerialization.data(withJSONObject: ["record": item,
            "timestampMs": timestamp, "actionId": row["actionId"] ?? NSNull(),
            "stateKey": capture["stateKey"] ?? NSNull()], options: [.sortedKeys])
        guard record.partitionId == Self.partition(stream),
              id == "mf2:\(namespace):\(generation):\(Self.sha(Data("\(identity):\(Self.sha(content))".utf8)))" else {
            throw CaptureFailure("capture_record_corrupt")
        }
        return DiskFact(namespace: namespace, generation: generation, id: id, stream: stream, targetKey: target,
                        epoch: epoch, captureId: captureId, timestampMs: timestamp, actionId: row["actionId"] as? String,
                        stateKey: capture["stateKey"] as? String, record: item, bytes: record.payload.count)
    }

    private func encodeCursor(_ metadata: Metadata, _ stream: String, _ sequence: UInt64, _ loss: String,
                              through: UInt64? = nil) -> String {
        "cf3:\(metadata.namespace):\(metadata.generation):\(stream):\(loss):\(sequence):\(through.map(String.init) ?? "-")"
    }
    private func decodeCursor(_ value: String?, stream: String, metadata: Metadata) throws -> QueryCursor {
        guard let value else { return QueryCursor(sequence: 0, lossVersion: "-", through: nil) }
        let parts = value.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 7, parts[0] == "cf3", parts[1] == metadata.namespace,
              Int64(parts[2]) == metadata.generation, parts[3] == stream,
              parts[4] == "-" || UUID(uuidString: parts[4]) != nil,
              let sequence = UInt64(parts[5]),
              parts[6] == "-" || UInt64(parts[6]) != nil else { throw CaptureFailure("invalid_capture_cursor") }
        return QueryCursor(sequence: sequence, lossVersion: parts[4], through: UInt64(parts[6]))
    }
    private func unavailable(_ query: CaptureQuery, _ reason: String) -> CapturePage {
        var page = CapturePage.unavailable(query.stream, reason)
        page.runtimeEpoch = runtimeEpoch; page.targetKey = targetKey
        return page
    }
    private func rejected(_ reason: String) -> AppendReceipt {
        AppendReceipt(status: "dropped", accepted: false, committed: false, dropped: true,
                      deduplicated: false, mobileFactId: nil, reason: reason)
    }
    private func awaitWriter<T>(_ submit: (@escaping (T) -> Void) -> Void) -> T? {
        let result = ResultBox<T>()
        submit { result.complete($0) }
        guard result.signal.wait(timeout: .now() + .seconds(3)) == .success else { return nil }
        return result.value
    }
    private static func partition(_ stream: String) -> UInt32 { stream == "network" ? 0 : stream == "logs" ? 2 : 4 }
    private static func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private static func integer(_ value: Any?) -> Int64? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991,
              value.doubleValue == Double(value.int64Value) else { return nil }
        return value.int64Value
    }

    private struct Metadata: Codable {
        var version = 2
        var targetKey = ""
        var activeEpoch = ""
        var epochFloor: UInt64 = 0
        var namespace = UUID().uuidString.lowercased()
        var generation: Int64 = 1
        var generations = Dictionary(uniqueKeysWithValues: SegmentedCaptureBackend.streams.map { ($0, Int64(1)) })
        var losses = Dictionary(uniqueKeysWithValues: SegmentedCaptureBackend.streams.map { ($0, Loss()) })
    }
    private struct Loss: Codable {
        var timestampMs: Int64 = 0
        var captureId: Int64 = 0
        var epoch = ""
        var version = UUID().uuidString.lowercased()
    }
    private struct Snapshot {
        let status: SegmentedFactStoreStatus
        let flushed: Bool
        let metadata: Metadata
        let failed: Bool
        let skipThrough: UInt64
        let watermark: Int64
    }
    private struct QueryCursor { let sequence: UInt64; let lossVersion: String; let through: UInt64? }
    private struct CaptureFailure: Error { let code: String; init(_ code: String) { self.code = code } }
    private struct DiskFact {
        let namespace: String, generation: Int64, id: String, stream: String, targetKey: String, epoch: String
        let captureId: Int64, timestampMs: Int64
        let actionId: String?, stateKey: String?
        let record: [String: Any]
        let bytes: Int
    }
    private final class ResultBox<T> {
        let signal = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var result: T?
        func complete(_ value: T) { lock.lock(); result = value; lock.unlock(); signal.signal() }
        var value: T? { lock.lock(); defer { lock.unlock() }; return result }
    }
    private struct ReadIndex {
        struct Prefix {
            var sequence: UInt64, timestampMs: Int64, captureId: Int64
            func excludes(_ sinceMs: Int64?, _ sinceId: Int64?) -> Bool {
                (sinceMs.map { timestampMs < $0 } ?? false) || (sinceId.map { captureId <= $0 } ?? false)
            }
        }
        let floor: UInt64
        let trusted: Bool
        var latest: Prefix
        var prefixes: [Prefix] = []
        var records = 0, bytes = 0
        var captureId: Int64 { latest.captureId }
        init(_ floor: UInt64, trusted: Bool) { self.floor = floor; self.trusted = trusted; latest = Prefix(sequence: floor, timestampMs: .min, captureId: 0) }
        mutating func commit(_ sequence: UInt64, _ timestamp: Int64, _ id: Int64, _ payloadBytes: Int) {
            latest = Prefix(sequence: sequence, timestampMs: max(latest.timestampMs, timestamp), captureId: max(latest.captureId, id))
            records += 1; bytes += payloadBytes
            if records >= 128 || bytes >= 65536 {
                prefixes.append(latest)
                if prefixes.count > 512 { prefixes.removeFirst() }
                records = 0; bytes = 0
            }
        }
        func skip(_ sinceMs: Int64?, _ sinceId: Int64?, _ through: UInt64) -> UInt64 {
            guard trusted else { return floor }
            if latest.excludes(sinceMs, sinceId) { return through }
            return prefixes.last(where: { $0.excludes(sinceMs, sinceId) })?.sequence ?? floor
        }
    }
}
