import Flutter
import Foundation
import UIKit

#if canImport(AiAppBridgeIOS)
import AiAppBridgeIOS
#endif

public final class AiAppBridgeFlutterPlugin: NSObject, FlutterPlugin {
    private static let channelName = "ai_app_bridge"
    private var channel: FlutterMethodChannel?
    private var handlerToken: String?

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
        instance.handlerToken = AiAppBridge.shared.setFlutterActionHandler { [weak instance] method, payload, reply in
            guard let instance else {
                reply(#"{"ok":false,"error":"flutter_plugin_detached"}"#); return
            }
            instance.runFlutterAction(method: method, payloadJson: payload, reply: reply)
        }
    }

    public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
        if let token = handlerToken { AiAppBridge.shared.clearFlutterActionHandler(token: token) }
        handlerToken = nil
        channel = nil
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "checkAction":
            guard let payload = call.arguments as? String else {
                result(#"{"ok":false,"error":"invalid_flutter_execution_identity"}"#); return
            }
            result(AiAppBridge.shared.checkFlutterAction(payload))
        case "updateSnapshot":
            guard let payload = call.arguments as? String else {
                result(["ok": false, "error": "invalid_snapshot_argument"])
                return
            }
            AiAppBridge.shared.updateFlutterSnapshot(payload)
            result(["ok": true])
        case "recordLog", "recordNetwork", "recordState", "recordEvent":
            guard let payload = call.arguments as? String else {
                result(["ok": false, "error": "invalid_capture_argument"])
                return
            }
            AiAppBridge.shared.recordFlutterCapture(method: call.method, payloadJson: payload) { response in
                DispatchQueue.main.async { result(response) }
            }
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    private func runFlutterAction(method: String, payloadJson: String, reply: @escaping (String) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let channel = self?.channel else {
                reply(#"{"ok":false,"error":"flutter_channel_absent"}"#); return
            }
            channel.invokeMethod(method, arguments: payloadJson) { value in
                if let error = value as? FlutterError {
                    reply(Self.jsonString(["ok": false, "error": error.code,
                                           "message": error.message as Any? ?? NSNull()])); return
                }
                guard let result = value as? [String: Any] else {
                    reply(#"{"ok":false,"error":"invalid_flutter_action_result"}"#); return
                }
                reply(Self.jsonString(result))
            }
        }
    }

    private static func jsonString(_ value: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else {
            return #"{"ok":false,"error":"invalid_flutter_action_result"}"#
        }
        return text
    }
}
