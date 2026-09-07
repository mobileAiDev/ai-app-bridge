import Foundation

enum CaptureAppend {
    @discardableResult
    static func appendSanitized(
        store: MobileCaptureStore,
        event: [String: Any],
        stream: String,
        targetKey: String,
        runtimeEpoch: String
    ) -> AppendReceipt {
        switch stream {
        case "logs", "network", "state", "events":
            break
        default:
            preconditionFailure(stream)
        }
        let stateKey: String?
        if stream == "state" {
            guard let namespace = event["namespace"] as? String, let key = event["key"] as? String else {
                preconditionFailure("stateKey")
            }
            stateKey = "\(namespace):\(key)"
        } else {
            stateKey = nil
        }
        guard let captureId = int64(event["id"]), let timestampMs = int64(event["timestampMs"]) else {
            preconditionFailure("id")
        }
        guard let source = event["source"] as? String else {
            preconditionFailure("source")
        }
        return store.append(
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
            )
        )
    }

    static func itemsMatch(_ oracle: [[String: Any]], _ live: [[String: Any]]) -> Bool {
        guard oracle.count == live.count else { return false }
        for index in oracle.indices {
            if !jsonEqual(oracle[index], live[index]) { return false }
        }
        return true
    }

    static func valuesMatch(_ oracle: [String: Any], _ live: [String: Any]) -> Bool {
        jsonEqual(oracle, live)
    }

    private static func jsonEqual(_ left: Any?, _ right: Any?) -> Bool {
        switch (left, right) {
        case let (l as [String: Any], r as [String: Any]):
            guard l.count == r.count else { return false }
            for (key, value) in l {
                if !jsonEqual(value, r[key]) { return false }
            }
            return true
        case let (l as [Any], r as [Any]):
            guard l.count == r.count else { return false }
            for index in l.indices {
                if !jsonEqual(l[index], r[index]) { return false }
            }
            return true
        case let (l as NSNumber, r as NSNumber):
            return l == r
        case let (l as String, r as String):
            return l == r
        case (_ as NSNull, _ as NSNull):
            return true
        default:
            return false
        }
    }

    private static func int64(_ value: Any?) -> Int64? {
        if let number = value as? Int64 { return number }
        if let number = value as? Int { return Int64(number) }
        if let number = value as? NSNumber { return number.int64Value }
        return nil
    }
}
