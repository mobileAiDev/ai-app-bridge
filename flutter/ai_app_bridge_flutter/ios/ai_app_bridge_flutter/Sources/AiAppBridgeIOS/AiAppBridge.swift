import Foundation
#if canImport(UIKit)
import Network
import UIKit
import WebKit

public final class AiAppBridge {
    public static let shared = AiAppBridge()

    private let bridgeVersion = "0.3.4"
    private let runtimeEpoch = UUID().uuidString
    private lazy var h5Bridge = IOSH5Bridge(runtimeEpoch: runtimeEpoch)
    private let captureQueue = DispatchQueue(label: "io.github.mobileaidev.aiappbridge.ios.capture")
    private let serverQueue = DispatchQueue(label: "io.github.mobileaidev.aiappbridge.ios.server")
    private let maxCapturedBodyChars = 20_000
    private let redactedValue = "[redacted]"

    private lazy var observationFactStoreLifecycle = ObservationFactStoreLifecycle(
        onOpening: { [weak self] in self?.captureStore.beginOpening() },
        onOpened: { [weak self] configuration in
            guard let self else { return }
            captureStore.attachPersistentStore(SegmentedFactStore.shared, directory: configuration.options.directory,
                targetKey: Bundle.main.bundleIdentifier ?? "unknown", runtimeEpoch: runtimeEpoch)
        },
        onOpenFailed: { [weak self] reason in self?.captureStore.detachPersistentStore(reason: reason) },
        onStopped: { [weak self] in self?.captureStore.detachPersistentStore() }
    )
    private var listener: NWListener?
    private var activePort: UInt16 = 0
    private var started = false
    private var runtimeDescriptorReady = false
    private var appName = ""
    private var flutterSnapshot: [String: Any] = [:]
    private var flutterActionHandler: AiAppBridgeFlutterActionHandler?
    private var flutterHandlerToken: String?
    private lazy var executionReceipts = IOSExecutionReceiptStore(store: SegmentedFactStore.shared,
        bundleId: Bundle.main.bundleIdentifier ?? "")
    private lazy var managedExecution = IOSManagedExecution(receipts: executionReceipts) { [weak self] kind in
        guard let self else { return nil }
        if kind == "h5" { return runtimeEpoch }
        return captureQueue.sync {
            guard self.flutterActionHandler != nil,
                  let layout = self.flutterSnapshot["layout"] as? [String: Any],
                  let operable = layout["operable"] as? [String: Any] else { return nil }
            return operable["runtimeEpoch"] as? String
        }
    }
    private var captureSequence: Int64 = 0
    let captureStore = MobileCaptureStore(
        caps: CountCaps(logs: 300, network: 200, events: 300, state: 200)
    )
    #if DEBUG
    private var uiObserver: AiAppBridgeUiObserver?
    #endif

    private init() {}

    public func start(appName: String = "") {
        #if DEBUG
        captureQueue.sync {
            if !appName.isEmpty {
                self.appName = appName
            }
        }
        observationFactStoreLifecycle.start(MobileFactStoreProfiles.defaultConfiguration())
        startAutomaticLogPersist()
        runOnMain { [weak self] in
            self?.startUiObservationIfNeeded()
        }
        serverQueue.async {
            self.startServerIfNeeded()
        }
        #endif
    }

    #if DEBUG
    private func startUiObservationIfNeeded() {
        precondition(Thread.isMainThread, "iOS UI observation must start on the main thread")
        if uiObserver == nil {
            uiObserver = AiAppBridgeUiObserver { [weak self] category, name, data in
                guard let self else { return }
                self.recordEventPayload([
                    "category": category,
                    "name": name,
                    "data": data
                ], source: "ios-ui-observer")
            }
        }
        uiObserver?.start()
    }
    #endif

    @discardableResult
    public func setFlutterActionHandler(_ handler: @escaping AiAppBridgeFlutterActionHandler) -> String {
        captureQueue.sync {
            let token = UUID().uuidString
            flutterActionHandler = handler
            flutterHandlerToken = token
            flutterSnapshot = [:]
            return token
        }
    }

    public func clearFlutterActionHandler(token: String) {
        captureQueue.sync {
            guard flutterHandlerToken == token else { return }
            flutterActionHandler = nil
            flutterHandlerToken = nil
            flutterSnapshot = [:]
        }
    }

    public func checkFlutterAction(_ body: String) -> String {
        guard let value = Self.parseJson(body) as? [String: Any], Set(value.keys) == ["actionId", "runtimeEpoch"],
              let id = IOSManagedExecution.text(value["actionId"]),
              let epoch = IOSManagedExecution.text(value["runtimeEpoch"]) else {
            return Self.jsonString(IOSManagedExecution.failure("invalid_flutter_execution_identity"))
        }
        return serverQueue.sync {
            Self.jsonString(managedExecution.permission(kind: "flutter", actionId: id, epoch: epoch))
        }
    }

    public func updateFlutterSnapshot(_ snapshotJson: String) {
        let data = Data(snapshotJson.utf8)
        do {
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                captureQueue.sync {
                    flutterSnapshot = ["ok": false, "error": "invalid_flutter_snapshot",
                                       "reason": "Expected a JSON object", "utf8Bytes": data.count,
                                       "updatedAtMs": Self.nowMs()]
                }
                return
            }
            captureQueue.sync { flutterSnapshot = object }
        } catch {
            captureQueue.sync {
                flutterSnapshot = [
                    "ok": false,
                    "error": "invalid_flutter_snapshot",
                    "reason": String(describing: error),
                    "utf8Bytes": data.count,
                    "updatedAtMs": Self.nowMs()
                ]
            }
        }
    }

    // Flutter's method channel forwards the original capture payload, including
    // actionId, through the same sanitizer and persistent receipt path as HTTP.
    public func recordFlutterCapture(method: String, payloadJson: String,
                                     completion: @escaping ([String: Any]) -> Void) {
        guard let payload = Self.parseJson(payloadJson) as? [String: Any] else {
            completion(["ok": false, "error": "invalid_capture_json"]); return
        }
        switch method {
        case "recordLog": recordLogPayload(payload, source: "flutter-sdk", completion: completion)
        case "recordNetwork": recordNetworkPayload(payload, source: "flutter-sdk", completion: completion)
        case "recordState": recordStatePayload(payload, source: "flutter-sdk", completion: completion)
        case "recordEvent": recordEventPayload(payload, source: "flutter-sdk", completion: completion)
        default: completion(["ok": false, "error": "unknown_capture_method"])
        }
    }

    public func recordLog(level: String = "info", tag: String, message: String, data: Any? = nil) {
        var payload: [String: Any] = [
            "level": level.isEmpty ? "info" : level,
            "tag": tag,
            "message": message
        ]
        if let data {
            payload["data"] = data
        }
        recordLogPayload(payload, source: "sdk")
    }

    public func recordNetwork(
        source: String = "sdk",
        method: String,
        url: String,
        statusCode: Int = -1,
        durationMs: Int64 = -1,
        requestHeaders: Any? = nil,
        responseHeaders: Any? = nil,
        requestBody: String? = nil,
        responseBody: String? = nil,
        error: String? = nil
    ) {
        var payload: [String: Any] = [
            "method": method.isEmpty ? "GET" : method,
            "url": url,
            "statusCode": statusCode,
            "durationMs": durationMs
        ]
        if let requestHeaders { payload["requestHeaders"] = requestHeaders }
        if let responseHeaders { payload["responseHeaders"] = responseHeaders }
        if let requestBody { payload["requestBody"] = requestBody }
        if let responseBody { payload["responseBody"] = responseBody }
        if let error, !error.isEmpty { payload["error"] = error }
        recordNetworkPayload(payload, source: source.isEmpty ? "sdk" : source)
    }

    public func recordState(namespace: String = "app", key: String, value: Any?) {
        recordStatePayload([
            "namespace": namespace.isEmpty ? "app" : namespace,
            "key": key,
            "value": value ?? NSNull()
        ], source: "sdk")
    }

    public func recordEvent(category: String = "app", name: String, data: Any? = nil) {
        var payload: [String: Any] = [
            "category": category.isEmpty ? "app" : category,
            "name": name
        ]
        if let data {
            payload["data"] = data
        }
        recordEventPayload(payload, source: "sdk")
    }

    private func startServerIfNeeded() {
        if started {
            return
        }
        started = true
        writePortState(ok: false, port: 0, error: "starting")
        do {
            try startListener()
        } catch {
            writePortState(ok: false, port: 0, error: String(describing: error))
            started = false
        }
    }

    private func startListener() throws {
        let parameters = NWParameters.tcp
        let listener = try NWListener(using: parameters, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self, let listener, self.listener === listener else { return }
            switch state {
            case .ready:
                guard let port = listener.port?.rawValue, port != 0 else {
                    self.writePortState(ok: false, port: 0, error: "listener_port_unavailable")
                    listener.cancel()
                    self.listener = nil
                    self.started = false
                    return
                }
                self.activePort = port
                self.writePortState(ok: true, port: port, error: nil)
            case .waiting(let error):
                self.activePort = 0
                self.writePortState(ok: false, port: 0, error: String(describing: error))
            case .failed(let error):
                self.activePort = 0
                self.writePortState(ok: false, port: 0, error: String(describing: error))
                listener.cancel()
                self.listener = nil
                self.started = false
            case .cancelled:
                self.activePort = 0
                self.writePortState(ok: false, port: 0, error: "listener_cancelled")
                self.listener = nil
                self.started = false
            default:
                break
            }
        }
        self.listener = listener
        listener.start(queue: serverQueue)
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: serverQueue)
        readRequest(connection: connection, buffer: Data())
    }

    private func readRequest(connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                self.writeJson(connection: connection, status: 500, body: self.errorBody(error: String(describing: error)))
                return
            }
            var nextBuffer = buffer
            if let data {
                nextBuffer.append(data)
            }
            do {
                if let request = try IOSHttpRequest.parse(nextBuffer) {
                    self.route(request: request) { status, body in
                        self.writeJson(connection: connection, status: status, body: body)
                    }
                    return
                }
            } catch {
                self.writeJson(connection: connection, status: 400, body: self.errorBody(error: "bad_request"))
                return
            }
            if isComplete {
                self.writeJson(connection: connection, status: 400, body: self.errorBody(error: "bad_request"))
                return
            }
            self.readRequest(connection: connection, buffer: nextBuffer)
        }
    }

    private var runtimeIdentity: IOSRuntimeIdentity {
        IOSRuntimeIdentity(bundleId: Bundle.main.bundleIdentifier ?? "", runtimeEpoch: runtimeEpoch,
                           processId: ProcessInfo.processInfo.processIdentifier, port: activePort)
    }

    private func route(request: IOSHttpRequest, completion: @escaping (Int, [String: Any]) -> Void) {
        if IOSRuntimeIdentity.requiresBinding(method: request.method, path: request.path),
           let error = runtimeIdentity.admissionError(headers: request.headers, descriptorReady: runtimeDescriptorReady) {
            completion(409, ["ok": false, "error": error, "dispatched": false, "ambiguous": false])
            return
        }
        switch (request.method, request.path) {
        case ("GET", "/v1/status"):
            completion(200, buildStatus())
        case ("GET", "/v1/view/tree"):
            runOnMain { completion(200, self.buildViewTree()) }
        case ("GET", "/v1/screenshot"):
            runOnMain { completion(200, self.buildScreenshot()) }
        case ("GET", "/v1/logs"):
            completion(200, liveCapture("logs", query: request.query))
        case ("GET", "/v1/network"):
            completion(200, liveCapture("network", query: request.query))
        case ("GET", "/v1/state"):
            completion(200, liveCapture("state", query: request.query))
        case ("GET", "/v1/events"):
            completion(200, liveCapture("events", query: request.query))
        case ("GET", "/v1/h5/dom"):
            runOnMain { self.h5Bridge.snapshot(windows: Self.appWindows(), webViewId: request.query["webViewId"]) { completion(200, $0) } }
        case ("POST", "/v1/h5/action"):
            dispatchManagedAction(kind: "h5", body: request.body) { completion(200, $0) }
        case ("POST", "/v1/flutter/action"):
            dispatchManagedAction(kind: "flutter", body: request.body) { completion(200, $0) }
        case ("POST", "/v1/h5/cancel"), ("POST", "/v1/flutter/cancel"):
            let kind = request.path == "/v1/h5/cancel" ? "h5" : "flutter"
            guard let identity = Self.parseJson(request.body) as? [String: Any],
                  Set(identity.keys) == ["actionId", "runtimeEpoch"],
                  let id = IOSManagedExecution.text(identity["actionId"]),
                  let epoch = IOSManagedExecution.text(identity["runtimeEpoch"]) else {
                completion(400, IOSManagedExecution.failure("invalid_ios_execution_identity")); return
            }
            managedExecution.cancel(kind: kind, actionId: id, epoch: epoch) { completion(200, $0) }
        case ("GET", "/v1/execution/status"):
            completion(200, managedExecution.status())
        case ("GET", "/v1/execution/result"):
            lookupExecution(query: request.query) { completion(200, $0) }
        case ("POST", "/v1/flutter/snapshot"):
            updateFlutterSnapshot(request.body)
            completion(200, ["ok": true])
        case ("POST", "/v1/logs"):
            postLog(body: request.body) { completion(200, $0) }
        case ("POST", "/v1/network"):
            postNetwork(body: request.body) { completion(200, $0) }
        case ("POST", "/v1/state"):
            postState(body: request.body) { completion(200, $0) }
        case ("POST", "/v1/events"):
            postEvent(body: request.body) { completion(200, $0) }
        case ("POST", "/v1/action/tap"), ("POST", "/v1/action/input-text"):
            completion(200, [
                "ok": false,
                "error": "ios_runtime_action_unsupported",
                "message": "Use the desktop iOS provider with WebDriverAgent for full-control actions."
            ])
        case ("POST", "/v1/app/clear-data"):
            completion(200, clearRuntimeData())
        default:
            completion(404, ["ok": false, "error": "not_found"])
        }
    }

    private func buildStatus() -> [String: Any] {
        let bundle = Bundle.main
        let flutter = captureQueue.sync { flutterSnapshot }
        return [
            "ok": true,
            "debugBridge": [
                "name": "ai_app_bridge",
                "version": bridgeVersion,
                "runtimeEpoch": runtimeEpoch,
                "h5ExecutionSchema": IOSManagedExecution.schema("h5"),
                "h5TargetSchema": IOSH5Bridge.schema,
                "flutterExecutionSchema": IOSManagedExecution.schema("flutter"),
                "platform": "ios",
                "transport": "http",
                "host": "0.0.0.0",
                "port": Int(activePort)
            ],
            "app": [
                "bundleId": bundle.bundleIdentifier ?? "",
                "name": appName.isEmpty ? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "") : appName,
                "versionName": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                "buildNumber": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                "debuggable": Self.isDebugBuild
            ],
            "ios": [
                "systemName": UIDevice.current.systemName,
                "systemVersion": UIDevice.current.systemVersion,
                "model": UIDevice.current.model,
                "name": UIDevice.current.name
            ],
            "activity": [
                "current": String(describing: type(of: Self.keyWindow()?.rootViewController ?? UIViewController()))
            ],
            "capture": captureCounts(),
            "flutter": flutter,
            "updatedAtMs": Self.nowMs()
        ]
    }

    private func buildViewTree() -> [String: Any] {
        guard let window = Self.keyWindow() else {
            return ["ok": false, "error": "no_key_window"]
        }
        var counter = NodeCounter()
        let windows = Self.appWindows().enumerated().map { index, item in
            [
                "index": index,
                "rootClassName": String(describing: type(of: item)),
                "bounds": Self.rectJson(item.bounds),
                "root": viewJson(item, depth: 0, counter: &counter)
            ] as [String: Any]
        }
        return [
            "ok": true,
            "activity": String(describing: type(of: window.rootViewController ?? UIViewController())),
            "root": viewJson(window, depth: 0, counter: &counter),
            "windows": windows,
            "windowCount": windows.count,
            "nodeCount": counter.count,
            "updatedAtMs": Self.nowMs()
        ]
    }

    private func viewJson(
        _ view: UIView,
        depth: Int,
        counter: inout NodeCounter
    ) -> [String: Any] {
        counter.count += 1
        let id = counter.count
        let frameInScreen = view.convert(view.bounds, to: nil)
        let secureInput = (view as? UITextField)?.isSecureTextEntry == true
        var payload: [String: Any] = [
            "id": id,
            "depth": depth,
            "className": NSStringFromClass(type(of: view)),
            "simpleClassName": String(describing: type(of: view)),
            "visible": !view.isHidden && view.alpha > 0.01,
            "enabled": view.isUserInteractionEnabled,
            "alpha": Double(view.alpha),
            "bounds": Self.rectJson(frameInScreen),
            "accessibilityIdentifier": view.accessibilityIdentifier ?? "",
            "contentDescription": view.accessibilityLabel ?? "",
            "text": secureInput ? "" : viewText(view),
            "clickable": view.isUserInteractionEnabled && !view.gestureRecognizers.orEmpty.isEmpty,
            "children": []
        ]
        if let textField = view as? UITextField {
            payload["input"] = [
                "secure": textField.isSecureTextEntry,
                "textLength": textField.text?.count ?? 0,
                "rawTextCaptured": false
            ]
        }
        var children: [[String: Any]] = []
        for child in view.subviews.prefix(250) {
            children.append(viewJson(
                child,
                depth: depth + 1,
                counter: &counter
            ))
        }
        payload["children"] = children
        return payload
    }

    private func viewText(_ view: UIView) -> String {
        if let label = view as? UILabel {
            return label.text ?? ""
        }
        if let button = view as? UIButton {
            return button.title(for: .normal) ?? button.accessibilityLabel ?? ""
        }
        if let textField = view as? UITextField {
            if textField.isSecureTextEntry {
                return ""
            }
            return textField.text ?? textField.placeholder ?? ""
        }
        if let textView = view as? UITextView {
            return textView.text ?? ""
        }
        return view.accessibilityValue ?? ""
    }

    private func buildScreenshot() -> [String: Any] {
        guard let window = Self.keyWindow() else {
            return ["ok": false, "error": "no_key_window"]
        }
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        guard let data = image.pngData() else {
            return ["ok": false, "error": "png_encode_failed"]
        }
        return [
            "ok": true,
            "format": "png",
            "width": Int(image.size.width * image.scale),
            "height": Int(image.size.height * image.scale),
            "scale": image.scale,
            "base64": data.base64EncodedString(),
            "updatedAtMs": Self.nowMs()
        ]
    }

    private func dispatchManagedAction(kind: String, body: String, completion: @escaping ([String: Any]) -> Void) {
        guard let value = Self.parseJson(body) as? [String: Any] else {
            completion(IOSManagedExecution.failure("invalid_ios_execution")); return
        }
        if kind == "h5" {
            guard let payload = value["payload"] as? [String: Any],
                  Set(value.keys) == ["payload", "actionId", "execution"],
                  let action = payload["action"] as? String,
                  ["click", "input", "scroll", "eval"].contains(action),
                  payload["pageRef"] is [String: Any] else {
                completion(IOSManagedExecution.failure("invalid_h5_execution")); return
            }
            let expectedKeys: Set<String> = action == "eval" ? ["action", "pageRef", "script"]
                : action == "input" ? ["action", "pageRef", "element", "text"] : ["action", "pageRef", "element"]
            guard Set(payload.keys) == expectedKeys,
                  (action != "eval" || payload["script"] is String),
                  (action != "input" || payload["text"] is String),
                  (action == "eval" || payload["element"] is [String: Any]) else {
                completion(IOSManagedExecution.failure("invalid_h5_operation")); return
            }
            managedExecution.submit(kind: kind, body: value, task: {
                IOSMainThreadTask { check, complete in
                    self.h5Bridge.execute(windows: Self.appWindows(), payload: payload, check: check, completion: complete)
                }
            }, reply: completion)
        } else {
            guard let handler = captureQueue.sync(execute: { flutterActionHandler }) else {
                completion(IOSManagedExecution.failure("flutter_action_handler_absent")); return
            }
            managedExecution.submit(kind: kind, body: value, task: { IOSFlutterTask(handler: handler, body: value) }, reply: completion)
        }
    }

    private func lookupExecution(query: [String: String], completion: @escaping ([String: Any]) -> Void) {
        guard Set(query.keys).isSubset(of: ["kind", "actionId", "runtimeEpoch", "cursor"]),
              let kind = query["kind"], ["h5", "flutter"].contains(kind),
              let id = IOSManagedExecution.text(query["actionId"]), let epoch = IOSManagedExecution.text(query["runtimeEpoch"]) else {
            completion(IOSManagedExecution.failure("invalid_ios_execution_identity")); return
        }
        executionReceipts.lookup(kind: kind, actionId: id, epoch: epoch, cursor: query["cursor"], reply: completion)
    }

    private func postLog(body: String, completion: @escaping ([String: Any]) -> Void) {
        guard let payload = Self.parseJson(body) as? [String: Any] else {
            completion(["ok": false, "error": "invalid_capture_json"]); return
        }
        recordLogPayload(payload, source: "http", completion: completion)
    }

    private func postNetwork(body: String, completion: @escaping ([String: Any]) -> Void) {
        guard let payload = Self.parseJson(body) as? [String: Any] else {
            completion(["ok": false, "error": "invalid_capture_json"]); return
        }
        recordNetworkPayload(payload, source: "http", completion: completion)
    }

    private func postState(body: String, completion: @escaping ([String: Any]) -> Void) {
        guard let payload = Self.parseJson(body) as? [String: Any] else {
            completion(["ok": false, "error": "invalid_capture_json"]); return
        }
        recordStatePayload(payload, source: "http", completion: completion)
    }

    private func postEvent(body: String, completion: @escaping ([String: Any]) -> Void) {
        guard let payload = Self.parseJson(body) as? [String: Any] else {
            completion(["ok": false, "error": "invalid_capture_json"]); return
        }
        recordEventPayload(payload, source: "http", completion: completion)
    }

    private func recordLogPayload(_ payload: [String: Any], source: String,
                                      completion: (([String: Any]) -> Void)? = nil) {
        let details: [String: Any] = [
            "level": string(payload["level"], fallback: "info"),
            "tag": string(payload["tag"], fallback: ""),
            "message": boundedString(string(payload["message"], fallback: ""), max: 4_000),
            "data": redactJsonValue(payload["data"] ?? NSNull())
        ]
        appendCapture(details, stream: "logs", source: source, actionId: payload["actionId"], completion: completion)
    }

    private func recordNetworkPayload(_ payload: [String: Any], source: String,
                                      completion: (([String: Any]) -> Void)? = nil) {
        var details: [String: Any] = [
            "method": string(payload["method"], fallback: "GET"),
            "url": redactUrl(string(payload["url"], fallback: "")),
            "statusCode": int(payload["statusCode"], fallback: -1),
            "durationMs": int64(payload["durationMs"], fallback: -1),
            "requestBody": redactedBoundedString(payload["requestBody"]),
            "responseBody": redactedBoundedString(payload["responseBody"]),
            "redacted": true
        ]
        if let requestHeaders = payload["requestHeaders"] {
            details["requestHeaders"] = redactJsonValue(requestHeaders)
        }
        if let responseHeaders = payload["responseHeaders"] {
            details["responseHeaders"] = redactJsonValue(responseHeaders)
        }
        if let error = payload["error"] as? String, !error.isEmpty {
            details["error"] = error
        }
        appendCapture(details, stream: "network", source: source, actionId: payload["actionId"], completion: completion)
    }

    private func recordStatePayload(_ payload: [String: Any], source: String,
                                      completion: (([String: Any]) -> Void)? = nil) {
        let namespace = string(payload["namespace"], fallback: "app")
        let key = string(payload["key"], fallback: "")
        let stateKey = "\(namespace):\(key)"
        let details: [String: Any] = [
            "namespace": namespace,
            "key": key,
            "value": redactJsonValue(payload["value"] ?? NSNull()),
            "stateKey": stateKey
        ]
        appendCapture(details, stream: "state", source: source, actionId: payload["actionId"], completion: completion)
    }

    private func recordEventPayload(_ payload: [String: Any], source: String,
                                      completion: (([String: Any]) -> Void)? = nil) {
        let details: [String: Any] = [
            "category": string(payload["category"], fallback: "app"),
            "name": string(payload["name"], fallback: ""),
            "data": redactJsonValue(payload["data"] ?? NSNull())
        ]
        appendCapture(details, stream: "events", source: source, actionId: payload["actionId"], completion: completion)
    }

    private func startAutomaticLogPersist() {
        AutomaticLogCapture.shared.start { [weak self] record in
            self?.persistCapturedLog(record)
        }
    }

    private func persistCapturedLog(_ record: AutomaticLogRecord) {
        var event: [String: Any] = [
            "type": "log", "source": record.source, "level": record.level,
            "tag": record.tag, "message": record.message, "timestampMs": record.timestampMs
        ]
        if let data = record.data { event["data"] = redactJsonValue(data) }
        if record.partition == .deviceLog {
            persistMobileFact(event) { context in
                try SanitizedFactPayload.deviceLog(context: context, record: event)
            }
        } else {
            appendCapture(event, stream: "logs", source: record.source)
        }
    }

    private func appendCapture(_ details: [String: Any], stream: String, source: String,
                               actionId: Any? = nil, completion: (([String: Any]) -> Void)? = nil) {
        if let actionId, !(actionId is NSNull),
           !(actionId is String) || (actionId as? String)?.isEmpty == true {
            completion?(["ok": false, "error": "invalid_action_id"]); return
        }
        captureQueue.sync {
            var event = captureEvent(source: source).merging(details) { _, new in new }
            if let actionId = actionId as? String { event["actionId"] = actionId }
            CaptureAppend.appendSanitized(store: captureStore, event: event, stream: stream,
                targetKey: Bundle.main.bundleIdentifier ?? "unknown", runtimeEpoch: runtimeEpoch) { [self] receipt in
                guard let completion else { return }
                let response = CaptureAppend.response(receipt: receipt, event: event)
                serverQueue.async { completion(response) }
            }
        }
    }

    private func persistMobileFact(
        _ event: [String: Any],
        factory: (MobileFactEnvelopeContext) throws -> SanitizedFactPayload
    ) {
        guard let fact = try? factory(mobileFactContext(event: event)) else { return }
        IOSObservationFactStoreRegistry.enqueue(fact)
    }

    private func mobileFactContext(event: [String: Any]? = nil) -> MobileFactEnvelopeContext {
        let bundleId = Bundle.main.bundleIdentifier ?? "unknown"
        let device = UIDevice.current
        let rawIdentity = device.identifierForVendor?.uuidString
            ?? "\(device.systemName):\(device.model)"
        let nowMs = Self.nowMs()
        let occurredAtMs = (event?["timestampMs"] as? NSNumber)?.int64Value ?? nowMs
        let actionId = event?["actionId"] as? String
        return .init(
            platform: "ios",
            packageName: nil,
            bundleId: bundleId,
            model: device.model,
            deviceIdentity: SanitizedFactPayload.stableDeviceIdentity(
                platform: "ios",
                appIdentifier: bundleId,
                rawIdentity: rawIdentity
            ),
            runtimeEpoch: runtimeEpoch,
            actionId: actionId,
            occurredAtMs: occurredAtMs,
            observedAtMs: nowMs
        )
    }

    private func captureEvent(source: String) -> [String: Any] {
        captureSequence += 1
        return [
            "id": captureSequence,
            "source": source,
            "timestampMs": Self.nowMs()
        ]
    }

    private func captureCounts() -> [String: Any] {
        captureQueue.sync {
            let status = captureStore.status()
            let streams = status.streams
            return [
                "logs": streams["logs"]!.count,
                "network": streams["network"]!.count,
                "state": streams["state"]!.count,
                "events": streams["events"]!.count,
                "persistent": status.persistent,
                "pendingRecords": status.pendingRecords,
                "pendingBytes": status.pendingBytes,
                "reason": status.reason as Any? ?? NSNull(),
                "countsScope": "bounded-accepted-since-attachment"
            ]
        }
    }

    private func liveCapture(_ stream: String, query: [String: String]) -> [String: Any] {
        CaptureHttpView.fromHttp(store: captureStore, stream: stream, http: query, nowMs: Self.nowMs())
    }

    private func clearRuntimeData() -> [String: Any] {
        let receipt = captureStore.clear()
        guard receipt.ok else {
            return ["ok": false, "action": "clear-app-data", "cleared": [],
                    "error": receipt.reason ?? "capture_clear_failed"]
        }
        writePortState(ok: true, port: activePort, error: nil)
        return [
            "ok": true,
            "action": "clear-app-data",
            "cleared": ["runtime-captures"],
            "failures": [],
            "updatedAtMs": Self.nowMs()
        ]
    }

    private func writeJson(connection: NWConnection, status: Int, body: [String: Any]) {
        var responseBody = body
        responseBody["runtimeBinding"] = runtimeIdentity.json
        let payload = Self.jsonData(responseBody)
        let statusText = status == 200 ? "OK" : "Error"
        var response = Data("HTTP/1.1 \(status) \(statusText)\r\n".utf8)
        response.append(Data("Content-Type: application/json; charset=utf-8\r\n".utf8))
        response.append(Data("Content-Length: \(payload.count)\r\n".utf8))
        response.append(Data("Connection: close\r\n\r\n".utf8))
        response.append(payload)
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func errorBody(error: String) -> [String: Any] {
        ["ok": false, "error": error]
    }

    private func writePortState(ok: Bool, port: UInt16, error: String?) {
        runtimeDescriptorReady = false
        guard let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("ai_app_bridge_port.json") else { return }
        do {
            let identity = IOSRuntimeIdentity(bundleId: Bundle.main.bundleIdentifier ?? "", runtimeEpoch: runtimeEpoch,
                                              processId: ProcessInfo.processInfo.processIdentifier, port: port)
            try identity.publish(to: url, ready: ok, sdkVersion: bridgeVersion, error: error)
            runtimeDescriptorReady = ok
        } catch {
            NSLog("AiAppBridge runtime descriptor publication failed: %@", String(describing: error))
        }
    }

    private func runOnMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.async(execute: body)
        }
    }

    private static var isDebugBuild: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    private static func appWindows() -> [UIWindow] {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
    }

    private static func keyWindow() -> UIWindow? {
        appWindows().first(where: { $0.isKeyWindow }) ?? appWindows().first
    }

    private static func rectJson(_ rect: CGRect) -> [String: Any] {
        [
            "left": Double(rect.minX),
            "top": Double(rect.minY),
            "right": Double(rect.maxX),
            "bottom": Double(rect.maxY),
            "width": Double(rect.width),
            "height": Double(rect.height)
        ]
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    private static func parseJson(_ value: String) -> Any? {
        guard let data = value.data(using: .utf8), !data.isEmpty else {
            return nil
        }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    private static func jsonString(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else {
            return #"{"ok":false,"error":"invalid_ios_execution_json"}"#
        }
        return text
    }

    private static func jsonData(_ value: [String: Any]) -> Data {
        let normalized = normalizeJsonValue(value)
        return (try? JSONSerialization.data(withJSONObject: normalized, options: [])) ?? Data("{}".utf8)
    }

    private static func normalizeJsonValue(_ value: Any) -> Any {
        switch value {
        case let dictionary as [String: Any]:
            var output: [String: Any] = [:]
            for (key, item) in dictionary {
                output[key] = normalizeJsonValue(item)
            }
            return output
        case let array as [Any]:
            return array.map { normalizeJsonValue($0) }
        case Optional<Any>.none:
            return NSNull()
        default:
            if JSONSerialization.isValidJSONObject(["value": value]) {
                return value
            }
            return String(describing: value)
        }
    }

    private static func decodeJavaScriptValue(_ value: Any?) -> Any {
        guard let value else { return NSNull() }
        if let string = value as? String {
            if let decoded = parseJson(string) {
                return normalizeJsonValue(decoded)
            }
            return string
        }
        return normalizeJsonValue(value)
    }

    private func boundedString(_ value: String, max: Int) -> String {
        if value.count <= max {
            return value
        }
        return String(value.prefix(max))
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

    private func redactedBoundedString(_ value: Any?) -> Any {
        guard let value else { return NSNull() }
        let raw = boundedString(string(value, fallback: ""), max: maxCapturedBodyChars)
        if raw.isEmpty { return "" }
        if let parsed = Self.parseJson(raw) {
            return redactJsonValue(parsed)
        }
        return redactFormPayload(raw)
    }

    private func redactJsonValue(_ value: Any) -> Any {
        switch value {
        case let dictionary as [String: Any]:
            var output: [String: Any] = [:]
            for (key, item) in dictionary {
                output[key] = isSensitiveKey(key) ? redactedValue : redactJsonValue(item)
            }
            return output
        case let array as [Any]:
            return array.map { redactJsonValue($0) }
        default:
            return Self.normalizeJsonValue(value)
        }
    }

    private func redactUrl(_ raw: String) -> String {
        guard var components = URLComponents(string: raw), let items = components.queryItems else {
            return raw
        }
        components.queryItems = items.map { item in
            URLQueryItem(name: item.name, value: isSensitiveKey(item.name) ? redactedValue : item.value)
        }
        return components.string ?? raw
    }

    private func redactFormPayload(_ raw: String) -> String {
        raw.split(separator: "&").map { part in
            let pieces = part.split(separator: "=", maxSplits: 1).map(String.init)
            let key = pieces.first ?? ""
            if isSensitiveKey(key) {
                return "\(key)=\(redactedValue)"
            }
            return String(part)
        }.joined(separator: "&")
    }

    private func isSensitiveKey(_ key: String) -> Bool {
        let normalized = key.lowercased().replacingOccurrences(
            of: "[^a-z0-9]",
            with: "",
            options: .regularExpression
        )
        return normalized == "authorization"
            || normalized == "proxyauthorization"
            || normalized == "password"
            || normalized == "passwd"
            || normalized == "pwd"
            || normalized == "passcode"
            || normalized.hasSuffix("password")
            || normalized == "token"
            || normalized.hasSuffix("token")
    }


}

private struct NodeCounter {
    var count = 0
}

private extension Optional where Wrapped == [UIGestureRecognizer] {
    var orEmpty: [UIGestureRecognizer] {
        self ?? []
    }
}
#endif
