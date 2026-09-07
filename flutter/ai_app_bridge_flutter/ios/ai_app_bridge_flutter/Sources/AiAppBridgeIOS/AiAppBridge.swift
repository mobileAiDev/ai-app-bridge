import Foundation
#if canImport(UIKit)
import Network
import UIKit
import WebKit

public typealias AiAppBridgeFlutterActionHandler = (String) -> String

public final class AiAppBridge {
    public static let shared = AiAppBridge()

    private let defaultPort: UInt16 = 18080
    private let maxPortAttempts: UInt16 = 50
    private let bridgeVersion = "0.2.11"
    private let runtimeEpoch = UUID().uuidString
    private let captureQueue = DispatchQueue(label: "io.github.mobileaidev.aiappbridge.ios.capture")
    private let serverQueue = DispatchQueue(label: "io.github.mobileaidev.aiappbridge.ios.server")
    private let maxCapturedBodyChars = 20_000
    private let redactedValue = "[redacted]"

    private let observationFactStoreLifecycle = ObservationFactStoreLifecycle()
    private var listener: NWListener?
    private var activePort: UInt16 = 18080
    private var started = false
    private var appName = ""
    private var flutterSnapshot: [String: Any] = [:]
    private var flutterActionHandler: AiAppBridgeFlutterActionHandler?
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
                _ = self.recordEventPayload([
                    "category": category,
                    "name": name,
                    "data": data
                ], source: "ios-ui-observer")
            }
        }
        uiObserver?.start()
    }
    #endif

    public func setFlutterActionHandler(_ handler: AiAppBridgeFlutterActionHandler?) {
        captureQueue.sync {
            flutterActionHandler = handler
        }
    }

    public func updateFlutterSnapshot(_ snapshotJson: String) {
        guard let object = Self.parseJson(snapshotJson) as? [String: Any] else {
            captureQueue.sync {
                flutterSnapshot = [
                    "ok": false,
                    "error": "invalid_flutter_snapshot",
                    "updatedAtMs": Self.nowMs()
                ]
            }
            return
        }
        captureQueue.sync {
            flutterSnapshot = object
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
        _ = recordLogPayload(payload, source: "sdk")
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
        _ = recordNetworkPayload(payload, source: source.isEmpty ? "sdk" : source)
    }

    public func recordState(namespace: String = "app", key: String, value: Any?) {
        _ = recordStatePayload([
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
        _ = recordEventPayload(payload, source: "sdk")
    }

    private func startServerIfNeeded() {
        if started {
            return
        }
        started = true
        writePortState(ok: false, port: defaultPort, error: "starting")

        var lastError: Error?
        for candidate in defaultPort...(defaultPort + maxPortAttempts) {
            do {
                try startListener(port: candidate)
                return
            } catch {
                lastError = error
            }
        }
        writePortState(
            ok: false,
            port: defaultPort,
            error: String(describing: lastError ?? AiAppBridgeError.noAvailablePort)
        )
        started = false
    }

    private func startListener(port: UInt16) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.activePort = port
                self?.writePortState(ok: true, port: port, error: nil)
            case .failed(let error):
                self?.writePortState(ok: false, port: port, error: String(describing: error))
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
            if let request = HttpRequest.parse(nextBuffer) {
                self.route(request: request) { status, body in
                    self.writeJson(connection: connection, status: status, body: body)
                }
                return
            }
            if isComplete {
                self.writeJson(connection: connection, status: 400, body: self.errorBody(error: "bad_request"))
                return
            }
            self.readRequest(connection: connection, buffer: nextBuffer)
        }
    }

    private func route(request: HttpRequest, completion: @escaping (Int, [String: Any]) -> Void) {
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
            runOnMain { self.buildH5Dom(completion: { completion(200, $0) }) }
        case ("POST", "/v1/h5/eval"):
            runOnMain { self.executeH5Script(body: request.body, completion: { completion(200, $0) }) }
        case ("POST", "/v1/flutter/action"):
            completion(200, dispatchFlutterAction(body: request.body))
        case ("POST", "/v1/flutter/snapshot"):
            updateFlutterSnapshot(request.body)
            completion(200, ["ok": true])
        case ("POST", "/v1/logs"):
            completion(200, postLog(body: request.body))
        case ("POST", "/v1/network"):
            completion(200, postNetwork(body: request.body))
        case ("POST", "/v1/state"):
            completion(200, postState(body: request.body))
        case ("POST", "/v1/events"):
            completion(200, postEvent(body: request.body))
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

    private func buildH5Dom(completion: @escaping ([String: Any]) -> Void) {
        guard let webView = findWebView() else {
            completion(["ok": false, "error": "no_webview"])
            return
        }
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        webView.evaluateJavaScript(Self.h5DomSnapshotScript) { value, error in
            if let error {
                completion(["ok": false, "error": String(describing: error)])
                return
            }
            let dom = Self.decodeJavaScriptValue(value)
            completion([
                "ok": true,
                "webView": [
                    "className": NSStringFromClass(type(of: webView)),
                    "url": webView.url?.absoluteString ?? "",
                    "title": webView.title ?? ""
                ],
                "dom": dom,
                "updatedAtMs": Self.nowMs()
            ])
        }
    }

    private func executeH5Script(body: String, completion: @escaping ([String: Any]) -> Void) {
        guard let webView = findWebView() else {
            completion(["ok": false, "error": "no_webview"])
            return
        }
        let payload = Self.parseJson(body) as? [String: Any]
        guard let script = payload?["script"] as? String, !script.isEmpty else {
            completion(["ok": false, "error": "script_required"])
            return
        }
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        webView.evaluateJavaScript(script) { value, error in
            if let error {
                completion(["ok": false, "error": String(describing: error)])
                return
            }
            completion([
                "ok": true,
                "result": Self.decodeJavaScriptValue(value),
                "updatedAtMs": Self.nowMs()
            ])
        }
    }

    private func findWebView() -> WKWebView? {
        guard let window = Self.keyWindow() else {
            return nil
        }
        return findWebView(in: window)
    }

    private func findWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView {
            return webView
        }
        for child in view.subviews {
            if let found = findWebView(in: child) {
                return found
            }
        }
        return nil
    }

    private func dispatchFlutterAction(body: String) -> [String: Any] {
        let handler = captureQueue.sync { flutterActionHandler }
        guard let handler else {
            return ["ok": false, "error": "flutter_action_handler_absent"]
        }
        let response = handler(body)
        if let json = Self.parseJson(response) as? [String: Any] {
            return json
        }
        return ["ok": true, "value": response]
    }

    private func postLog(body: String) -> [String: Any] {
        recordLogPayload(Self.parseJson(body) as? [String: Any] ?? [:], source: "http")
    }

    private func postNetwork(body: String) -> [String: Any] {
        recordNetworkPayload(Self.parseJson(body) as? [String: Any] ?? [:], source: "http")
    }

    private func postState(body: String) -> [String: Any] {
        recordStatePayload(Self.parseJson(body) as? [String: Any] ?? [:], source: "http")
    }

    private func postEvent(body: String) -> [String: Any] {
        recordEventPayload(Self.parseJson(body) as? [String: Any] ?? [:], source: "http")
    }

    private func recordLogPayload(_ payload: [String: Any], source: String) -> [String: Any] {
        let details: [String: Any] = [
            "level": string(payload["level"], fallback: "info"),
            "tag": string(payload["tag"], fallback: ""),
            "message": boundedString(string(payload["message"], fallback: ""), max: 4_000),
            "data": payload["data"] ?? NSNull()
        ]
        let event = captureQueue.sync {
            let event = captureEvent(source: source).merging(details) { _, new in new }
            CaptureAppend.appendSanitized(
                store: captureStore,
                event: event,
                stream: "logs",
                targetKey: Bundle.main.bundleIdentifier ?? "unknown",
                runtimeEpoch: runtimeEpoch
            )
            return event
        }
        persistMobileFact(event) { context in
            try SanitizedFactPayload.log(context: context, record: event)
        }
        return ["ok": true, "record": event]
    }

    private func recordNetworkPayload(_ payload: [String: Any], source: String) -> [String: Any] {
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
        let event = captureQueue.sync {
            let event = captureEvent(source: source).merging(details) { _, new in new }
            CaptureAppend.appendSanitized(
                store: captureStore,
                event: event,
                stream: "network",
                targetKey: Bundle.main.bundleIdentifier ?? "unknown",
                runtimeEpoch: runtimeEpoch
            )
            return event
        }
        persistMobileFact(event) { context in
            try SanitizedFactPayload.network(context: context, record: event)
        }
        return ["ok": true, "record": event]
    }

    private func recordStatePayload(_ payload: [String: Any], source: String) -> [String: Any] {
        let namespace = string(payload["namespace"], fallback: "app")
        let key = string(payload["key"], fallback: "")
        let stateKey = "\(namespace):\(key)"
        let details: [String: Any] = [
            "namespace": namespace,
            "key": key,
            "value": redactJsonValue(payload["value"] ?? NSNull()),
            "stateKey": stateKey
        ]
        let event = captureQueue.sync {
            let event = captureEvent(source: source).merging(details) { _, new in new }
            CaptureAppend.appendSanitized(
                store: captureStore,
                event: event,
                stream: "state",
                targetKey: Bundle.main.bundleIdentifier ?? "unknown",
                runtimeEpoch: runtimeEpoch
            )
            return event
        }
        persistMobileFact(event) { context in
            try SanitizedFactPayload.state(context: context, record: event)
        }
        return ["ok": true, "record": event]
    }

    private func recordEventPayload(_ payload: [String: Any], source: String) -> [String: Any] {
        let details: [String: Any] = [
            "category": string(payload["category"], fallback: "app"),
            "name": string(payload["name"], fallback: ""),
            "data": redactJsonValue(payload["data"] ?? NSNull())
        ]
        let event = captureQueue.sync {
            let event = captureEvent(source: source).merging(details) { _, new in new }
            CaptureAppend.appendSanitized(
                store: captureStore,
                event: event,
                stream: "events",
                targetKey: Bundle.main.bundleIdentifier ?? "unknown",
                runtimeEpoch: runtimeEpoch
            )
            return event
        }
        persistMobileFact(event) { context in
            try SanitizedFactPayload.event(context: context, record: event)
        }
        return ["ok": true, "record": event]
    }

    private func startAutomaticLogPersist() {
        AutomaticLogCapture.shared.start { [weak self] record in
            self?.persistCapturedLog(record)
        }
    }

    private func persistCapturedLog(_ record: AutomaticLogRecord) {
        var event: [String: Any] = [
            "type": "log",
            "source": record.source,
            "level": record.level,
            "tag": record.tag,
            "message": record.message,
            "timestampMs": record.timestampMs
        ]
        if let data = record.data {
            event["data"] = data
        }
        persistMobileFact(event) { context in
            if record.partition == .deviceLog {
                return try SanitizedFactPayload.deviceLog(context: context, record: event)
            }
            return try SanitizedFactPayload.log(context: context, record: event)
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
            let streams = captureStore.status().streams
            return [
                "logs": streams["logs"]!.count,
                "network": streams["network"]!.count,
                "state": streams["state"]!.count,
                "events": streams["events"]!.count
            ]
        }
    }

    private func liveCapture(_ stream: String, query: [String: String]) -> [String: Any] {
        captureQueue.sync {
            LegacyLiveView.fromHttp(store: captureStore, stream: stream, http: query, nowMs: Self.nowMs())
        }
    }

    private func clearRuntimeData() -> [String: Any] {
        captureQueue.sync {
            _ = captureStore.clear()
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
        let payload = Self.jsonData(body)
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
        let payload: [String: Any] = [
            "ok": ok,
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "port": Int(port),
            "version": bridgeVersion,
            "updatedAtMs": Self.nowMs(),
            "error": error ?? NSNull()
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            return
        }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("ai_app_bridge_port.json")
        guard let url else { return }
        try? data.write(to: url)
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

    private static let h5DomSnapshotScript = """
    (function() {
      function text(value) { return value == null ? '' : String(value); }
      function cut(value, max) {
        var raw = text(value);
        return raw.length > max ? raw.slice(0, max) : raw;
      }
      function bounds(element) {
        var rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      }
      function sensitive(element) {
        var probe = [element.type, element.id, element.name, element.autocomplete].join(' ').toLowerCase();
        return /password|passwd|pwd|passcode/.test(probe);
      }
      var selector = 'a,button,input,textarea,select,[role],[onclick],[aria-label]';
      var controls = Array.prototype.slice.call(document.querySelectorAll(selector), 0, 200).map(function(element, index) {
        return {
          index: index,
          tag: text(element.tagName).toLowerCase(),
          id: text(element.id),
          name: text(element.getAttribute('name')),
          type: text(element.getAttribute('type')),
          role: text(element.getAttribute('role')),
          ariaLabel: text(element.getAttribute('aria-label')),
          placeholder: text(element.getAttribute('placeholder')),
          text: sensitive(element)
            ? ''
            : cut(element.innerText || element.value || element.title || element.getAttribute('aria-label'), 300),
          href: cut(element.href, 500),
          disabled: !!element.disabled,
          bounds: bounds(element)
        };
      });
      return JSON.stringify({
        ok: true,
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        bodyText: cut(document.body && document.body.innerText, 20000),
        controls: controls,
        controlCount: controls.length,
        updatedAtMs: Date.now()
      });
    })()
    """
}

private enum AiAppBridgeError: Error {
    case noAvailablePort
}

private struct HttpRequest {
    let method: String
    let path: String
    let query: [String: String]
    let body: String

    static func parse(_ data: Data) -> HttpRequest? {
        guard let separator = data.range(of: Data("\r\n\r\n".utf8)) else {
            return nil
        }
        let headerData = data[..<separator.lowerBound]
        guard let header = String(data: headerData, encoding: .utf8) else {
            return nil
        }
        let lines = header.components(separatedBy: "\r\n")
        let first = lines.first?.split(separator: " ").map(String.init) ?? []
        guard first.count >= 2 else {
            return nil
        }
        let contentLength = lines.first {
            $0.lowercased().hasPrefix("content-length:")
        }?.split(separator: ":", maxSplits: 1).last.flatMap {
            Int($0.trimmingCharacters(in: .whitespaces))
        } ?? 0
        let bodyStart = separator.upperBound
        guard data.count >= bodyStart + contentLength else {
            return nil
        }
        let target = first[1]
        let parts = target.split(separator: "?", maxSplits: 1).map(String.init)
        let bodyData = data[bodyStart..<(bodyStart + contentLength)]
        return HttpRequest(
            method: first[0],
            path: parts.first ?? "/",
            query: parts.count > 1 ? parseQuery(parts[1]) : [:],
            body: String(data: bodyData, encoding: .utf8) ?? ""
        )
    }

    private static func parseQuery(_ raw: String) -> [String: String] {
        var result: [String: String] = [:]
        for item in raw.split(separator: "&") {
            let parts = item.split(separator: "=", maxSplits: 1).map(String.init)
            let key = parts.first?.removingPercentEncoding ?? ""
            let value = parts.count > 1 ? (parts[1].removingPercentEncoding ?? parts[1]) : ""
            if !key.isEmpty {
                result[key] = value
            }
        }
        return result
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
