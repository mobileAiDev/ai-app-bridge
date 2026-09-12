import CoreFoundation
import Foundation

enum CaptureAppend {
    static func appendSanitized(
        store: MobileCaptureStore,
        event: [String: Any],
        stream: String,
        targetKey: String,
        runtimeEpoch: String,
        completion: @escaping (AppendReceipt) -> Void
    ) {
        switch stream {
        case "logs", "network", "state", "events":
            break
        default:
            completion(invalid("unknown_stream")); return
        }
        let stateKey: String?
        if stream == "state" {
            guard let namespace = event["namespace"] as? String, let key = event["key"] as? String else {
                completion(invalid("invalid_state_key")); return
            }
            stateKey = "\(namespace):\(key)"
        } else {
            stateKey = nil
        }
        guard let captureId = int64(event["id"]), let timestampMs = int64(event["timestampMs"]) else {
            completion(invalid("invalid_capture_identity")); return
        }
        guard let source = event["source"] as? String else {
            completion(invalid("invalid_capture_source")); return
        }
        store.append(
            CaptureInput(
                stream: stream,
                targetKey: targetKey,
                runtimeEpoch: runtimeEpoch,
                captureId: captureId,
                timestampMs: timestampMs,
                record: event,
                actionId: event["actionId"] as? String,
                source: source,
                stateKey: stateKey
            ), completion: completion
        )
    }

    private static func invalid(_ reason: String) -> AppendReceipt {
        AppendReceipt(status: "dropped", accepted: false, committed: false, dropped: true,
                      deduplicated: false, mobileFactId: nil, reason: reason)
    }

    static func response(receipt: AppendReceipt, event: [String: Any]) -> [String: Any] {
        var body: [String: Any] = ["ok": receipt.accepted, "record": event,
         "receipt": ["status": receipt.status, "accepted": receipt.accepted,
                     "committed": receipt.committed, "dropped": receipt.dropped,
                     "mobileFactId": receipt.mobileFactId as Any? ?? NSNull(),
                     "reason": receipt.reason as Any? ?? NSNull()]]
        if !receipt.accepted { body["error"] = receipt.reason ?? "capture_rejected" }
        return body
    }

    private static func int64(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue == Double(number.int64Value) else { return nil }
        return number.int64Value
    }
}
