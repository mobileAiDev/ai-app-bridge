#if DEBUG && canImport(UIKit)
import Foundation
import UIKit

final class AiAppBridgeUiObserver: NSObject {
    typealias EventSink = (_ category: String, _ name: String, _ data: [String: Any]) -> Void

    private let maxFramesPerSecond = 10
    private let maxSampledNodes = 240
    private let maxChangedComponents = 12
    private let eventSink: EventSink
    private let onStop: () -> Void
    private var stateMachine = UiObservationStateMachine()
    private var displayLink: CADisplayLink?
    private var notificationTokens: [NSObjectProtocol] = []
    private var lastEmittedSnapshot: UiObservationSnapshot?
    private var lastInputEventUptimeMs: Int64 = 0
    private var lastSampleUptimeMs: Int64 = 0
    private var nextSampleUptimeMs: Int64 = 0
    private var expiry: DispatchWorkItem?
    private var leaseId: String?
    private var deadlineMs: Int64 = 0
    private(set) var sampleCount = 0
    private var maxSampleDurationMs: Int64 = 0
    private(set) var isStarted = false

    init(onStop: @escaping () -> Void = {}, eventSink: @escaping EventSink) {
        self.onStop = onStop
        self.eventSink = eventSink
        super.init()
    }

    static func sanitizedInputEvent(view: UIView, timestampMs: Int64) -> [String: Any] {
        UiObservedNode.inputEventSummary(view: view, timestampMs: timestampMs)
    }

    func control(_ request: [String: Any]) -> [String: Any] {
        precondition(Thread.isMainThread)
        if isStarted && Self.uptimeMs() >= deadlineMs { stop() }
        let operation = request["operation"] as? String
        let keys: Set<String>
        switch operation {
        case "start": keys = ["operation", "durationMs"]
        case "stop": keys = ["operation", "leaseId"]
        case "status": keys = ["operation"]
        default: return ["ok": false, "error": "invalid_ui_observation_operation"]
        }
        guard Set(request.keys) == keys else { return ["ok": false, "error": "invalid_ui_observation_request"] }
        if operation == "start" {
            guard let number = request["durationMs"] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue == Double(number.int64Value), (100...5000).contains(number.int64Value) else {
                return ["ok": false, "error": "invalid_ui_observation_duration"]
            }
            guard !isStarted else { return ["ok": false, "error": "ui_observation_busy"] }
            leaseId = UUID().uuidString
            deadlineMs = Self.uptimeMs() + number.int64Value
            sampleCount = 0
            maxSampleDurationMs = 0
            start()
            let work = DispatchWorkItem { [weak self] in self?.stop() }
            expiry = work
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(max(0, deadlineMs - Self.uptimeMs()))), execute: work)
        } else if operation == "stop" {
            guard let id = request["leaseId"] as? String, id == leaseId else { return ["ok": false, "error": "ui_observation_lease_mismatch"] }
            stop()
        }
        return status
    }

    var status: [String: Any] {
        if isStarted && Self.uptimeMs() >= deadlineMs { stop() }
        return ["ok": true, "schemaVersion": "aab.ui-observation/v1", "mode": "on-demand",
         "active": isStarted, "leaseId": leaseId as Any? ?? NSNull(),
         "remainingMs": isStarted ? max(0, deadlineMs - Self.uptimeMs()) : 0,
         "maxDurationMs": 5000, "sampleCount": sampleCount, "maxSampleDurationMs": maxSampleDurationMs]
    }

    private func start() {
        precondition(Thread.isMainThread, "AiAppBridgeUiObserver must start on the main thread")
        guard !isStarted else { return }
        isStarted = true
        stateMachine = UiObservationStateMachine()
        lastEmittedSnapshot = nil
        lastInputEventUptimeMs = 0
        lastSampleUptimeMs = 0
        nextSampleUptimeMs = 0
        installNotifications()

        let link = CADisplayLink(target: self, selector: #selector(displayLinkDidFire))
        link.preferredFramesPerSecond = maxFramesPerSecond
        link.add(to: .main, forMode: .common)
        displayLink = link

        eventSink("ui", "ui.observer.started", [
            "maxFramesPerSecond": maxFramesPerSecond,
            "maxSampledNodes": maxSampledNodes,
            "maxChangedComponents": maxChangedComponents,
            "fullTreePerFrame": false,
            "screenshotsPerFrame": false,
            "timestampMs": Self.nowMs()
        ])
        sampleUi(force: true)
    }

    func stop() {
        precondition(Thread.isMainThread, "AiAppBridgeUiObserver must stop on the main thread")
        guard isStarted else { return }
        isStarted = false
        expiry?.cancel()
        expiry = nil
        leaseId = nil
        deadlineMs = 0
        displayLink?.invalidate()
        displayLink = nil
        let center = NotificationCenter.default
        notificationTokens.forEach(center.removeObserver)
        notificationTokens.removeAll()
        lastEmittedSnapshot = nil
        lastInputEventUptimeMs = 0
        lastSampleUptimeMs = 0
        onStop()
    }

    deinit {
        displayLink?.invalidate()
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
    }

    @objc private func displayLinkDidFire() {
        sampleUi()
    }

    private func sampleUi(force: Bool = false) {
        guard isStarted else { return }
        let observedAtMs = Self.nowMs()
        let uptimeMs = Self.uptimeMs()
        guard uptimeMs < deadlineMs else { stop(); return }
        guard UIApplication.shared.applicationState == .active else { return }
        guard force || uptimeMs >= nextSampleUptimeMs else { return }
        lastSampleUptimeMs = uptimeMs
        // UIKit reads remain on main; expensive host views reduce our sample rate.
        defer {
            let elapsed = Self.uptimeMs() - uptimeMs
            maxSampleDurationMs = max(maxSampleDurationMs, elapsed)
            nextSampleUptimeMs = Self.uptimeMs() + max(100, elapsed * 9)
        }
        let snapshot = UiObservationSnapshot.capture(maxNodes: maxSampledNodes)
        sampleCount += 1
        guard let emission = stateMachine.observe(
            fingerprint: snapshot.fingerprint,
            atMs: observedAtMs,
            hasActiveAnimations: snapshot.hasActiveAnimations
        ) else {
            return
        }

        var data = snapshot.summary
        data["fingerprint"] = emission.fingerprint
        data["previousFingerprint"] = emission.previousFingerprint ?? NSNull()
        data["observedAtMs"] = emission.observedAtMs
        data["coalescedSamples"] = emission.coalescedSamples
        data["activeAnimations"] = emission.hasActiveAnimations

        if emission.kind == .changed {
            let changes = snapshot.changedComponents(
                comparedTo: lastEmittedSnapshot,
                limit: maxChangedComponents
            )
            data["changedComponents"] = changes.items
            data["changedComponentCount"] = changes.total
            data["changedComponentsTruncated"] = changes.total > changes.items.count
            data["semanticChanged"] = changes.channels.semanticChanged
            data["renderChanged"] = changes.channels.renderChanged
            data["renderOnly"] = changes.channels.renderChanged && !changes.channels.semanticChanged
            lastEmittedSnapshot = snapshot
            eventSink("ui", "ui.changed", data)
        } else {
            data["stableForMs"] = emission.stableForMs
            eventSink("ui", "ui.stable", data)
        }
    }

    private func installNotifications() {
        let center = NotificationCenter.default
        let lifecycle: [(Notification.Name, String)] = [
            (UIApplication.didBecomeActiveNotification, "didBecomeActive"),
            (UIApplication.willResignActiveNotification, "willResignActive"),
            (UIApplication.didEnterBackgroundNotification, "didEnterBackground"),
            (UIApplication.willEnterForegroundNotification, "willEnterForeground")
        ]
        for (name, phase) in lifecycle {
            notificationTokens.append(center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.recordLifecycle(phase: phase)
            })
        }

        let inputChanges: [Notification.Name] = [
            UITextField.textDidChangeNotification,
            UITextView.textDidChangeNotification
        ]
        for name in inputChanges {
            notificationTokens.append(center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                self?.recordInputChange(notification.object as? UIView)
            })
        }

        let focusChanges: [(Notification.Name, Bool)] = [
            (UITextField.textDidBeginEditingNotification, true),
            (UITextField.textDidEndEditingNotification, false),
            (UITextView.textDidBeginEditingNotification, true),
            (UITextView.textDidEndEditingNotification, false)
        ]
        for (name, focused) in focusChanges {
            notificationTokens.append(center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                self?.recordFocusChange(notification.object as? UIView, focused: focused)
            })
        }
    }

    private func recordLifecycle(phase: String) {
        if phase == "didEnterBackground" { stop() }
        eventSink("lifecycle", "lifecycle.\(phase)", [
            "phase": phase,
            "applicationState": Self.applicationStateName,
            "timestampMs": Self.nowMs()
        ])
    }

    private func recordInputChange(_ view: UIView?) {
        guard let view else { return }
        let nowMs = Self.nowMs()
        let uptimeMs = Self.uptimeMs()
        guard uptimeMs - lastInputEventUptimeMs >= 100 else { return }
        lastInputEventUptimeMs = uptimeMs
        eventSink("interaction", "ui.input.changed", Self.sanitizedInputEvent(view: view, timestampMs: nowMs))
    }

    private func recordFocusChange(_ view: UIView?, focused: Bool) {
        guard let view else { return }
        var data = Self.sanitizedInputEvent(view: view, timestampMs: Self.nowMs())
        data["focused"] = focused
        eventSink("interaction", "ui.focus.changed", data)
    }

    private static var applicationStateName: String {
        switch UIApplication.shared.applicationState {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown"
        }
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }

    private static func uptimeMs() -> Int64 {
        Int64(ProcessInfo.processInfo.systemUptime * 1_000)
    }
}

private struct UiObservationSnapshot {
    let fingerprint: String
    let semanticFingerprint: String
    let renderFingerprint: String
    let nodes: [String: UiObservedNode]
    let summary: [String: Any]
    let hasActiveAnimations: Bool

    static func capture(maxNodes: Int) -> UiObservationSnapshot {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { scene in scene.windows.map { (scene, $0) } }
            .sorted { lhs, rhs in
                if lhs.1.windowLevel == rhs.1.windowLevel {
                    return lhs.1.isKeyWindow && !rhs.1.isKeyWindow
                }
                return lhs.1.windowLevel.rawValue < rhs.1.windowLevel.rawValue
            }

        var semanticFingerprint = StableUiFingerprint()
        var renderFingerprint = StableUiFingerprint()
        var nodes: [String: UiObservedNode] = [:]
        var windowSummaries: [[String: Any]] = []
        var focusedView: [String: Any]?
        var animatedNodeCount = 0
        var animationCount = 0
        var truncated = false

        for (windowIndex, item) in windows.enumerated() {
            let (scene, window) = item
            let path = "w\(windowIndex)"
            let presented = presentedControllers(from: window.rootViewController)
            let isDialog = presented.contains { $0["dialog"] as? Bool == true }
                || window.windowLevel > .normal
            let windowSummary: [String: Any] = [
                "index": windowIndex,
                "sceneId": scene.session.persistentIdentifier,
                "className": NSStringFromClass(type(of: window)),
                "isKeyWindow": window.isKeyWindow,
                "windowLevel": Double(window.windowLevel.rawValue),
                "bounds": UiObservedNode.rectJson(window.convert(window.bounds, to: nil)),
                "visible": !window.isHidden && window.alpha > 0.01,
                "alpha": UiObservedNode.quantized(Double(window.alpha)),
                "transform": UiObservedNode.affineJson(window.transform),
                "rootController": window.rootViewController.map { NSStringFromClass(type(of: $0)) } ?? "",
                "presentedControllers": presented,
                "dialog": isDialog
            ]
            windowSummaries.append(windowSummary)
            semanticFingerprint.update("window|\(path)|\(Self.canonicalWindowSemanticSignature(windowSummary))")
            renderFingerprint.update("window|\(path)|\(Self.canonicalWindowRenderSignature(windowSummary))")

            scan(
                view: window,
                path: path,
                inheritedVisible: true,
                maxNodes: maxNodes,
                nodes: &nodes,
                focusedView: &focusedView,
                animatedNodeCount: &animatedNodeCount,
                animationCount: &animationCount,
                truncated: &truncated,
                semanticFingerprint: &semanticFingerprint,
                renderFingerprint: &renderFingerprint
            )
            if nodes.count >= maxNodes {
                truncated = true
                break
            }
        }

        let dialogCount = windowSummaries.filter { $0["dialog"] as? Bool == true }.count
        let summary: [String: Any] = [
            "platform": "ios",
            "windows": windowSummaries,
            "windowCount": windowSummaries.count,
            "dialogCount": dialogCount,
            "focusedView": focusedView ?? NSNull(),
            "sampledNodeCount": nodes.count,
            "sampleTruncated": truncated,
            "animatedNodeCount": animatedNodeCount,
            "animationCount": animationCount,
            "fullTreeSerialized": false,
            "screenshotCaptured": false
        ]
        var combinedFingerprint = StableUiFingerprint()
        combinedFingerprint.update(semanticFingerprint.digest)
        combinedFingerprint.update(renderFingerprint.digest)
        return UiObservationSnapshot(
            fingerprint: combinedFingerprint.digest,
            semanticFingerprint: semanticFingerprint.digest,
            renderFingerprint: renderFingerprint.digest,
            nodes: nodes,
            summary: summary,
            hasActiveAnimations: animationCount > 0
        )
    }

    func changedComponents(
        comparedTo previous: UiObservationSnapshot?,
        limit: Int
    ) -> (items: [[String: Any]], total: Int, channels: UiChangeChannels) {
        guard let previous else {
            return (
                [],
                0,
                UiChangeChannels(
                    semanticChanged: true,
                    renderChanged: hasActiveAnimations
                )
            )
        }
        let channels = UiChangeChannels.between(
            previousSemantic: previous.semanticFingerprint,
            currentSemantic: semanticFingerprint,
            previousRender: previous.renderFingerprint,
            currentRender: renderFingerprint,
            hasActiveAnimations: hasActiveAnimations
        )
        let paths = Set(nodes.keys).union(previous.nodes.keys).sorted()
        var total = 0
        var items: [[String: Any]] = []
        for path in paths {
            let currentNode = nodes[path]
            let previousNode = previous.nodes[path]
            guard currentNode?.signature != previousNode?.signature else { continue }
            total += 1
            guard items.count < limit else { continue }
            if let currentNode {
                items.append(currentNode.eventSummary(change: previousNode == nil ? "appeared" : "changed"))
            } else if let previousNode {
                items.append(previousNode.eventSummary(change: "disappeared"))
            }
        }
        return (items, total, channels)
    }

    private static func scan(
        view: UIView,
        path: String,
        inheritedVisible: Bool,
        maxNodes: Int,
        nodes: inout [String: UiObservedNode],
        focusedView: inout [String: Any]?,
        animatedNodeCount: inout Int,
        animationCount: inout Int,
        truncated: inout Bool,
        semanticFingerprint: inout StableUiFingerprint,
        renderFingerprint: inout StableUiFingerprint
    ) {
        guard nodes.count < maxNodes else {
            truncated = true
            return
        }
        let node = UiObservedNode.capture(view: view, path: path, inheritedVisible: inheritedVisible)
        nodes[path] = node
        semanticFingerprint.update(node.semanticSignature)
        renderFingerprint.update(node.renderSignature)
        if node.animationCount > 0 {
            animatedNodeCount += 1
            animationCount += node.animationCount
        }
        if view.isFirstResponder, focusedView == nil {
            focusedView = node.focusSummary
        }
        guard node.visible else { return }

        for (index, child) in view.subviews.enumerated() {
            guard nodes.count < maxNodes else {
                truncated = true
                return
            }
            scan(
                view: child,
                path: "\(path).\(index)",
                inheritedVisible: node.visible,
                maxNodes: maxNodes,
                nodes: &nodes,
                focusedView: &focusedView,
                animatedNodeCount: &animatedNodeCount,
                animationCount: &animationCount,
                truncated: &truncated,
                semanticFingerprint: &semanticFingerprint,
                renderFingerprint: &renderFingerprint
            )
        }
    }

    private static func presentedControllers(from root: UIViewController?) -> [[String: Any]] {
        var output: [[String: Any]] = []
        var current = root?.presentedViewController
        while let controller = current, output.count < 8 {
            output.append([
                "className": NSStringFromClass(type(of: controller)),
                "presentationStyle": presentationStyleName(controller.modalPresentationStyle),
                "dialog": controller is UIAlertController || isDialogStyle(controller.modalPresentationStyle)
            ])
            current = controller.presentedViewController
        }
        return output
    }

    private static func presentationStyleName(_ style: UIModalPresentationStyle) -> String {
        switch style {
        case .fullScreen: return "fullScreen"
        case .pageSheet: return "pageSheet"
        case .formSheet: return "formSheet"
        case .currentContext: return "currentContext"
        case .custom: return "custom"
        case .overFullScreen: return "overFullScreen"
        case .overCurrentContext: return "overCurrentContext"
        case .popover: return "popover"
        case .none: return "none"
        case .automatic: return "automatic"
        case .blurOverFullScreen: return "blurOverFullScreen"
        @unknown default: return "unknown"
        }
    }

    private static func isDialogStyle(_ style: UIModalPresentationStyle) -> Bool {
        switch style {
        case .pageSheet, .formSheet, .popover, .overFullScreen, .overCurrentContext, .blurOverFullScreen:
            return true
        default:
            return false
        }
    }

    private static func canonicalWindowSemanticSignature(_ value: [String: Any]) -> String {
        let presented = (value["presentedControllers"] as? [[String: Any]] ?? []).map {
            "\($0["className"] ?? ""):\($0["presentationStyle"] ?? "")"
        }.joined(separator: ",")
        return [
            String(describing: value["className"] ?? ""),
            String(describing: value["isKeyWindow"] ?? false),
            String(describing: value["visible"] ?? false),
            String(describing: value["rootController"] ?? ""),
            presented
        ].joined(separator: "|")
    }

    private static func canonicalWindowRenderSignature(_ value: [String: Any]) -> String {
        let bounds = value["bounds"] as? [String: Any] ?? [:]
        let boundsSignature = ["left", "top", "right", "bottom", "width", "height"]
            .map { String(describing: bounds[$0] ?? 0) }
            .joined(separator: ",")
        let transformSignature = (value["transform"] as? [Double] ?? [])
            .map { String($0) }
            .joined(separator: ",")
        return [
            String(describing: value["windowLevel"] ?? 0),
            boundsSignature,
            String(describing: value["alpha"] ?? 0),
            transformSignature
        ].joined(separator: "|")
    }
}

private struct UiObservedNode {
    let path: String
    let className: String
    let accessibilityIdentifier: String
    let bounds: CGRect
    let visible: Bool
    let alpha: Double
    let transform: CATransform3D
    let animationCount: Int
    let contentFingerprint: String
    let contentLength: Int
    let input: UiInputMetadata?

    var semanticSignature: String {
        [
            path,
            className,
            accessibilityIdentifier,
            visible ? "1" : "0",
            contentFingerprint,
            String(contentLength),
            input.map { "input:\($0.secure ? 1 : 0):\($0.textLength)" } ?? ""
        ].joined(separator: "|")
    }

    var renderSignature: String {
        [
            path,
            Self.rectSignature(bounds),
            String(Self.quantized(alpha)),
            Self.transformSignature(transform),
            String(animationCount)
        ].joined(separator: "|")
    }

    var signature: String {
        "\(semanticSignature)|\(renderSignature)"
    }

    var focusSummary: [String: Any] {
        var value: [String: Any] = [
            "path": path,
            "className": className,
            "accessibilityIdentifier": accessibilityIdentifier,
            "bounds": Self.rectJson(bounds)
        ]
        if let input {
            value["input"] = input.json
        }
        return value
    }

    static func capture(view: UIView, path: String, inheritedVisible: Bool) -> UiObservedNode {
        let presentation = view.layer.presentation()
        let layer = presentation ?? view.layer
        let screenBounds = layer.convert(layer.bounds, to: nil)
        let alpha = Double(presentation?.opacity ?? Float(view.alpha))
        let visible = inheritedVisible && !view.isHidden && alpha > 0.01
        let input = inputMetadata(view)
        let content = contentMetadata(view, input: input)
        return UiObservedNode(
            path: path,
            className: NSStringFromClass(type(of: view)),
            accessibilityIdentifier: bounded(view.accessibilityIdentifier ?? "", max: 160),
            bounds: screenBounds,
            visible: visible,
            alpha: alpha,
            transform: layer.transform,
            animationCount: activeAnimationCount(layer: view.layer),
            contentFingerprint: content.fingerprint,
            contentLength: content.length,
            input: input
        )
    }

    func eventSummary(change: String) -> [String: Any] {
        var value: [String: Any] = [
            "change": change,
            "path": path,
            "className": className,
            "accessibilityIdentifier": accessibilityIdentifier,
            "bounds": Self.rectJson(bounds),
            "visible": visible,
            "alpha": Self.quantized(alpha),
            "transform": Self.transformJson(transform),
            "animationCount": animationCount,
            "contentLength": contentLength
        ]
        if let input {
            value["input"] = input.json
        }
        return value
    }

    static func inputEventSummary(view: UIView, timestampMs: Int64) -> [String: Any] {
        let input = inputMetadata(view) ?? UiInputMetadata(secure: false, textLength: 0)
        return [
            "className": NSStringFromClass(type(of: view)),
            "accessibilityIdentifier": bounded(view.accessibilityIdentifier ?? "", max: 160),
            "bounds": rectJson(view.convert(view.bounds, to: nil)),
            "input": input.json,
            "rawTextCaptured": false,
            "timestampMs": timestampMs
        ]
    }

    static func rectJson(_ rect: CGRect) -> [String: Any] {
        [
            "left": quantized(Double(rect.minX)),
            "top": quantized(Double(rect.minY)),
            "right": quantized(Double(rect.maxX)),
            "bottom": quantized(Double(rect.maxY)),
            "width": quantized(Double(rect.width)),
            "height": quantized(Double(rect.height))
        ]
    }

    static func affineJson(_ transform: CGAffineTransform) -> [Double] {
        [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].map {
            quantized(Double($0))
        }
    }

    static func quantized(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return (value * 100).rounded() / 100
    }

    private static func transformJson(_ value: CATransform3D) -> [Double] {
        [value.m11, value.m12, value.m21, value.m22, value.m41, value.m42].map {
            quantized(Double($0))
        }
    }

    private static func transformSignature(_ value: CATransform3D) -> String {
        transformJson(value).map { String($0) }.joined(separator: ",")
    }

    private static func rectSignature(_ rect: CGRect) -> String {
        [rect.minX, rect.minY, rect.width, rect.height]
            .map { String(quantized(Double($0))) }
            .joined(separator: ",")
    }

    private static func inputMetadata(_ view: UIView) -> UiInputMetadata? {
        if let field = view as? UITextField {
            return UiInputMetadata(secure: field.isSecureTextEntry, textLength: field.text?.count ?? 0)
        }
        if let textView = view as? UITextView {
            return UiInputMetadata(secure: false, textLength: textView.text?.count ?? 0)
        }
        if let searchBar = view as? UISearchBar {
            return UiInputMetadata(secure: false, textLength: searchBar.text?.count ?? 0)
        }
        return nil
    }

    private static func contentMetadata(
        _ view: UIView,
        input: UiInputMetadata?
    ) -> (fingerprint: String, length: Int) {
        if let input {
            return ("input-\(input.secure ? "secure" : "plain")-\(input.textLength)", input.textLength)
        }
        var values: [String] = []
        if let label = view as? UILabel, let text = label.text { values.append(text) }
        if let button = view as? UIButton, let title = button.title(for: .normal) { values.append(title) }
        if let accessibilityLabel = view.accessibilityLabel { values.append(accessibilityLabel) }
        if let accessibilityValue = view.accessibilityValue { values.append(accessibilityValue) }
        let combined = values.joined(separator: "|")
        guard !combined.isEmpty else { return ("", 0) }
        var fingerprint = StableUiFingerprint()
        fingerprint.update(String(combined.prefix(512)))
        return (fingerprint.digest, combined.count)
    }

    private static func activeAnimationCount(layer: CALayer) -> Int {
        var count = layer.animationKeys()?.count ?? 0
        for child in (layer.sublayers ?? []).prefix(8) {
            count += child.animationKeys()?.count ?? 0
        }
        return count
    }

    private static func bounded(_ value: String, max: Int) -> String {
        value.count <= max ? value : String(value.prefix(max))
    }
}

private struct UiInputMetadata {
    let secure: Bool
    let textLength: Int

    var json: [String: Any] {
        [
            "secure": secure,
            "textLength": max(0, textLength),
            "rawTextCaptured": false
        ]
    }
}

private struct StableUiFingerprint {
    private static let processSalt = UUID().uuidString
    private var value: UInt64 = 14_695_981_039_346_656_037

    init() {
        update(Self.processSalt)
    }

    mutating func update(_ text: String) {
        for byte in text.utf8 {
            value ^= UInt64(byte)
            value = value &* 1_099_511_628_211
        }
        value ^= 0xff
        value = value &* 1_099_511_628_211
    }

    var digest: String {
        String(format: "%016llx", value)
    }
}
#endif
