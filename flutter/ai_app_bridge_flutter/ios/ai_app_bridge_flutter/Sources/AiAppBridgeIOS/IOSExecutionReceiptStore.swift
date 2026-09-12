import CryptoKit
import Foundation

// Only completion credentials are queried here. App capture events cannot
// impersonate them: these records live in the internal action partition.
final class IOSExecutionReceiptStore {
    static let schema = "aab.ios-completion/v1"
    private let store: SegmentedFactStore
    private let bundleId: String

    init(store: SegmentedFactStore, bundleId: String) {
        self.store = store
        self.bundleId = bundleId
    }

    func ready(_ reply: @escaping (Bool) -> Void) {
        store.status { reply($0.state == .open) }
    }

    func commit(kind: String, result: [String: Any], reply: @escaping (Bool) -> Void) {
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "schema": Self.schema, "targetKey": bundleId, "kind": kind, "executionResult": result
        ], options: [.sortedKeys]), data.count <= 128 * 1024 else { reply(false); return }
        let queued = store.appendWithReceipt(data, partitionId: MobileFactPartition.action.rawValue, durability: .sync) {
            reply($0.operation.isSuccess && $0.sequence > 0)
        }
        if queued != .accepted { reply(false) }
    }

    // One page owns a finite, flushed upper bound. A cold Host can continue
    // through nextSequence; missing/evicted/incomplete history is never a pass.
    func lookup(kind: String, actionId: String, epoch: String, cursor: String? = nil,
                reply: @escaping ([String: Any]) -> Void) {
        let scope = SHA256.hash(data: try! JSONSerialization.data(withJSONObject: [bundleId, kind, actionId, epoch]))
            .map { String(format: "%02x", $0) }.joined()
        store.durableStatus { [self] operation, status in
            guard operation.isSuccess, status.state == .open else {
                reply(Self.failure("ios_completion_store_unavailable")); return
            }
            let position: Cursor
            if let cursor {
                guard cursor.utf8.count <= 2048, let data = Data(base64Encoded: cursor),
                      let decoded = try? JSONDecoder().decode(Cursor.self, from: data), decoded.version == 1,
                      decoded.scope == scope, decoded.afterSequence > 0, decoded.afterSequence < decoded.throughSequence,
                      decoded.segmentId > 0, decoded.offset >= 64 else {
                    reply(Self.failure("invalid_ios_completion_cursor")); return
                }
                position = decoded
            } else {
                position = Cursor(scope: scope, throughSequence: status.nextSequence > 0 ? status.nextSequence - 1 : 0)
            }
            guard position.throughSequence < status.nextSequence else {
                reply(Self.failure("invalid_ios_completion_cursor")); return
            }
            if position.afterSequence == position.throughSequence {
                reply(absent(position, hasMore: false)); return
            }
            // Partition scans use physical segment/offset coordinates. A bare
            // global sequence is not a partition seek cursor in the C API.
            store.readPage(cursor: SegmentedFactStoreCursor(partitionId: MobileFactPartition.action.rawValue,
                afterSequence: position.afterSequence, segmentId: position.segmentId, offset: position.offset),
                maxRecords: 64, maxBytes: 2 * 1024 * 1024) { [self] records, read in
                guard read.operation.isSuccess || read.isEnd else {
                    reply(Self.failure("ios_completion_read_failed")); return
                }
                for record in records where record.sequence <= position.throughSequence {
                    guard let value = try? JSONSerialization.jsonObject(with: record.payload) as? [String: Any],
                          value["schema"] as? String == Self.schema, value["targetKey"] as? String == bundleId,
                          value["kind"] as? String == kind, let result = value["executionResult"] as? [String: Any],
                          result["actionId"] as? String == actionId, result["runtimeEpoch"] as? String == epoch else { continue }
                    guard IOSManagedExecution.validTerminal(result, kind: kind, actionId: actionId, epoch: epoch) else {
                        reply(Self.failure("invalid_ios_completion_record")); return
                    }
                    reply(["ok": true, "found": true, "actionId": actionId, "runtimeEpoch": epoch,
                           "executionResult": result, "receipt": ["sequence": record.sequence,
                           "sha256": SHA256.hash(data: record.payload).map { String(format: "%02x", $0) }.joined(), "committed": true]])
                    return
                }
                var next = position
                next.afterSequence = min(read.cursor.afterSequence, position.throughSequence)
                next.segmentId = read.cursor.segmentId; next.offset = read.cursor.offset
                let more = !read.isEnd && next.afterSequence < position.throughSequence
                if more && next.afterSequence <= position.afterSequence { reply(Self.failure("ios_completion_cursor_stalled")); return }
                reply(absent(next, hasMore: more))
            }
        }
    }

    private struct Cursor: Codable {
        var version = 1
        let scope: String
        let throughSequence: UInt64
        var afterSequence: UInt64 = 0
        var segmentId: UInt64 = 0
        var offset: UInt64 = 0
    }

    private func absent(_ cursor: Cursor, hasMore: Bool) -> [String: Any] {
        ["ok": true, "found": false, "settled": false, "hasMore": hasMore,
         "nextSequence": cursor.afterSequence, "throughSequence": cursor.throughSequence,
         "nextCursor": hasMore ? (try! JSONEncoder().encode(cursor)).base64EncodedString() as Any : NSNull()]
    }

    private static func failure(_ error: String) -> [String: Any] {
        ["ok": false, "error": error, "settled": false]
    }
}
