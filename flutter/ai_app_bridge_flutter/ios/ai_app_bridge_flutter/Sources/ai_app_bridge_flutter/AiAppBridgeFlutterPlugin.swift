import Flutter
import Foundation
import UIKit

#if canImport(AiAppBridgeIOS)
import AiAppBridgeIOS
#endif

public final class AiAppBridgeFlutterPlugin: NSObject, FlutterPlugin {
    private static let channelName = "ai_app_bridge"
    private weak var channel: FlutterMethodChannel?

    private init(channel: FlutterMethodChannel) {
        self.channel = channel
        super.init()
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: channelName,
            binaryMessenger: registrar.messenger()
        )
        let instance = AiAppBridgeFlutterPlugin(channel: channel)
        registrar.addMethodCallDelegate(instance, channel: channel)

        AiAppBridge.shared.start()
        AiAppBridge.shared.setFlutterActionHandler { [weak instance] payload in
            instance?.runFlutterAction(payloadJson: payload) ?? #"{"ok":false,"error":"flutter_plugin_detached"}"#
        }
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        do {
            let handled: Bool
            switch call.method {
            case "updateSnapshot":
                AiAppBridge.shared.updateFlutterSnapshot(argumentString(call.arguments))
                handled = true
            case "recordLog":
                handled = recordLog(argumentString(call.arguments))
            case "recordNetwork":
                handled = recordNetwork(argumentString(call.arguments))
            case "recordState":
                handled = recordState(argumentString(call.arguments))
            case "recordEvent":
                handled = recordEvent(argumentString(call.arguments))
            default:
                result(FlutterMethodNotImplemented)
                return
            }
            result(handled ? ["ok": true] : ["ok": false, "reason": "debug_bridge_absent"])
        } catch {
            result(FlutterError(
                code: "AI_APP_BRIDGE_CALL_FAILED",
                message: String(describing: error),
                details: nil
            ))
        }
    }

    private func runFlutterAction(payloadJson: String) -> String {
        guard let channel else {
            return #"{"ok":false,"error":"flutter_channel_absent"}"#
        }
        let semaphore = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var response = #"{"ok":false,"error":"empty_flutter_action_result"}"#

        DispatchQueue.main.async {
            channel.invokeMethod("runAction", arguments: payloadJson) { value in
                lock.lock()
                defer {
                    lock.unlock()
                    semaphore.signal()
                }
                if let error = value as? FlutterError {
                    response = Self.jsonString([
                        "ok": false,
                        "error": error.message ?? error.code
                    ])
                    return
                }
                response = Self.jsonString(value)
            }
        }

        if semaphore.wait(timeout: .now() + 15) == .timedOut {
            return #"{"ok":false,"error":"flutter_action_timeout"}"#
        }
        lock.lock()
        defer { lock.unlock() }
        return response
    }

    private func recordLog(_ body: String) -> Bool {
        let payload = Self.dictionary(body)
        AiAppBridge.shared.recordLog(
            level: string(payload["level"], fallback: "info"),
            tag: string(payload["tag"], fallback: ""),
            message: string(payload["message"], fallback: ""),
            data: payload["data"]
        )
        return true
    }

    private func recordNetwork(_ body: String) -> Bool {
        let payload = Self.dictionary(body)
        AiAppBridge.shared.recordNetwork(
            source: string(payload["source"], fallback: "flutter-sdk"),
            method: string(payload["method"], fallback: "GET"),
            url: string(payload["url"], fallback: ""),
            statusCode: int(payload["statusCode"], fallback: -1),
            durationMs: int64(payload["durationMs"], fallback: -1),
            requestHeaders: payload["requestHeaders"],
            responseHeaders: payload["responseHeaders"],
            requestBody: payload["requestBody"] as? String,
            responseBody: payload["responseBody"] as? String,
            error: payload["error"] as? String
        )
        return true
    }

    private func recordState(_ body: String) -> Bool {
        let payload = Self.dictionary(body)
        AiAppBridge.shared.recordState(
            namespace: string(payload["namespace"], fallback: "app"),
            key: string(payload["key"], fallback: ""),
            value: payload["value"]
        )
        return true
    }

    private func recordEvent(_ body: String) -> Bool {
        let payload = Self.dictionary(body)
        AiAppBridge.shared.recordEvent(
            category: string(payload["category"], fallback: "app"),
            name: string(payload["name"], fallback: ""),
            data: payload["data"]
        )
        return true
    }

    private func argumentString(_ value: Any?) -> String {
        if let value = value as? String {
            return value
        }
        return Self.jsonString(value)
    }

    private func string(_ value: Any?, fallback: String) -> String {
        if let value = value as? String {
            return value
        }
        if let value {
            return String(describing: value)
        }
        return fallback
    }

    private func int(_ value: Any?, fallback: Int) -> Int {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        if let value = value as? String, let parsed = Int(value) { return parsed }
        return fallback
    }

    private func int64(_ value: Any?, fallback: Int64) -> Int64 {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? NSNumber { return value.int64Value }
        if let value = value as? String, let parsed = Int64(value) { return parsed }
        return fallback
    }

    private static func dictionary(_ json: String) -> [String: Any] {
        guard
            let data = json.data(using: .utf8),
            let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
            let dictionary = value as? [String: Any]
        else {
            return [:]
        }
        return dictionary
    }

    private static func jsonString(_ value: Any?) -> String {
        let normalized = normalizeJsonValue(value ?? ["ok": true])
        guard
            JSONSerialization.isValidJSONObject(normalized),
            let data = try? JSONSerialization.data(withJSONObject: normalized, options: []),
            let text = String(data: data, encoding: .utf8)
        else {
            return #"{"ok":true}"#
        }
        return text
    }

    private static func normalizeJsonValue(_ value: Any) -> Any {
        switch value {
        case let dictionary as [String: Any]:
            var output: [String: Any] = [:]
            for (key, item) in dictionary {
                output[key] = normalizeJsonValue(item)
            }
            return output
        case let dictionary as [AnyHashable: Any]:
            var output: [String: Any] = [:]
            for (key, item) in dictionary {
                output[String(describing: key)] = normalizeJsonValue(item)
            }
            return output
        case let array as [Any]:
            return array.map { normalizeJsonValue($0) }
        case _ as NSNull:
            return NSNull()
        default:
            if JSONSerialization.isValidJSONObject(["value": value]) {
                return value
            }
            return String(describing: value)
        }
    }
}
