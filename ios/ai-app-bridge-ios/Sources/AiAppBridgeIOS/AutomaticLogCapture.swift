#if canImport(UIKit)
import AiAppBridgeFactStoreC
import Foundation
import UIKit
import WebKit

final class AutomaticLogCapture {
    static let shared = AutomaticLogCapture()

    private var persist: ((AutomaticLogRecord) -> Void)?
    private var timer: Timer?
    private var expiry: DispatchWorkItem?
    private var observationDeadline: TimeInterval = 0
    private var draining = false
    private var observationGeneration = 0
    private let observedWebViews = NSHashTable<WKWebView>.weakObjects()
    private var started = false

    private init() {}

    func start(persist: @escaping (AutomaticLogRecord) -> Void) {
        if started {
            self.persist = persist
            return
        }
        started = true
        self.persist = persist
        NSLogSinkBox.persist = { [weak self] message in
            self?.persist?(
                AutomaticLogRecord(
                    source: "nslog",
                    level: "info",
                    tag: "NSLog",
                    message: message,
                    data: nil,
                    partition: .appLog,
                    timestampMs: Int64(Date().timeIntervalSince1970 * 1000)
                )
            )
        }
        aab_nslog_hook_start(nslogCSink)
    }

    func observeWebViews(durationMs: Int) {
        precondition(Thread.isMainThread)
        precondition((1...5000).contains(durationMs))
        stopObservingWebViews()
        observationDeadline = ProcessInfo.processInfo.systemUptime + Double(durationMs) / 1000
        let stop = DispatchWorkItem { [weak self] in self?.stopObservingWebViews() }
        expiry = stop
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(durationMs), execute: stop)
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.drainWebViews()
        }
        if let timer {
            RunLoop.main.add(timer, forMode: .common)
        }
        drainWebViews()
    }

    func stopObservingWebViews() {
        timer?.invalidate(); timer = nil
        expiry?.cancel(); expiry = nil
        observationDeadline = 0
        observationGeneration += 1
        draining = false
        for webView in observedWebViews.allObjects { webView.evaluateJavaScript(H5ConsoleScripts.uninstall) }
        observedWebViews.removeAllObjects()
    }

    private func drainWebViews() {
        guard timer != nil else { return }
        guard ProcessInfo.processInfo.systemUptime < observationDeadline else {
            stopObservingWebViews(); return
        }
        guard UIApplication.shared.applicationState == .active, !draining else { return }
        let webViews = allWebViews()
        guard !webViews.isEmpty else { return }
        draining = true
        let generation = observationGeneration
        var remaining = webViews.count
        for webView in webViews {
            observedWebViews.add(webView)
            webView.evaluateJavaScript(H5ConsoleScripts.install) { [weak self] _, _ in
                guard let self else { return }
                guard self.timer != nil, generation == self.observationGeneration else { return }
                webView.evaluateJavaScript(H5ConsoleScripts.drain) { value, _ in
                    guard self.timer != nil, generation == self.observationGeneration else { return }
                    self.persistConsole(value)
                    remaining -= 1
                    if remaining == 0 { self.draining = false }
                }
            }
        }
    }

    private func persistConsole(_ value: Any?) {
        for line in H5ConsoleDrainParser.parse(value) {
            persist?(
                AutomaticLogRecord(
                    source: "console",
                    level: line.method == "log" ? "info" : line.method,
                    tag: "console",
                    message: line.message,
                    data: ["method": line.method, "atMs": line.atMs],
                    partition: .appLog,
                    timestampMs: line.atMs > 0 ? line.atMs : Int64(Date().timeIntervalSince1970 * 1000)
                )
            )
        }
    }

    private func allWebViews() -> [WKWebView] {
        var views: [WKWebView] = []
        for window in UIApplication.shared.windows {
            collectWebViews(in: window, into: &views)
        }
        return views
    }

    private func collectWebViews(in view: UIView, into views: inout [WKWebView]) {
        if let webView = view as? WKWebView {
            views.append(webView)
            return
        }
        for child in view.subviews {
            collectWebViews(in: child, into: &views)
        }
    }
}

private enum NSLogSinkBox {
    static var persist: ((String) -> Void)?
}

private let nslogCSink: aab_nslog_sink = { pointer in
    guard let pointer else { return }
    NSLogSinkBox.persist?(String(cString: pointer))
}
#endif
