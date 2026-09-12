import Foundation

public typealias AiAppBridgeFlutterActionHandler = (String, String, @escaping (String) -> Void) -> Void

final class IOSMainThreadTask: IOSManagedTask {
    private let execute: (@escaping () -> [String: Any], @escaping ([String: Any]) -> Void) -> Void
    init(execute: @escaping (@escaping () -> [String: Any], @escaping ([String: Any]) -> Void) -> Void) {
        self.execute = execute
    }
    func start(check: @escaping () -> [String: Any], complete: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async { self.execute(check, complete) }
    }
    func stop(reason: String) {
        // The queued block must check permission. A submitted WKWebView script
        // has no synchronous abort API; only its original callback can settle it.
    }
}

final class IOSFlutterTask: IOSManagedTask {
    private let handler: AiAppBridgeFlutterActionHandler
    private let body: [String: Any]
    init(handler: @escaping AiAppBridgeFlutterActionHandler, body: [String: Any]) {
        self.handler = handler
        self.body = body
    }
    func start(check: @escaping () -> [String: Any], complete: @escaping ([String: Any]) -> Void) {
        guard let data = try? JSONSerialization.data(withJSONObject: body), let text = String(data: data, encoding: .utf8) else {
            complete(IOSManagedExecution.failure("invalid_flutter_execution")); return
        }
        // Dart asks checkAction before each mutation. Do not grant permission
        // merely because a MethodChannel message was queued on the main thread.
        handler("executeAction", text) { value in
            guard let data = value.data(using: .utf8), let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                complete(IOSManagedExecution.failure("invalid_flutter_execution_receipt")); return
            }
            complete(result)
        }
    }
    func stop(reason: String) {
        guard var execution = body["execution"] as? [String: Any] else { return }
        execution.removeValue(forKey: "timeoutMs")
        execution["reason"] = reason
        guard let data = try? JSONSerialization.data(withJSONObject: execution), let text = String(data: data, encoding: .utf8) else { return }
        // A cancellation acknowledgement only confirms receipt of the request.
        handler("cancelAction", text) { _ in }
    }
}
