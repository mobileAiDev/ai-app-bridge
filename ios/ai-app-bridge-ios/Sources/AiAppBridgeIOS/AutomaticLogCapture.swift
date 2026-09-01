#if canImport(UIKit)
import AiAppBridgeFactStoreC
import Foundation
import UIKit
import WebKit

final class AutomaticLogCapture {
    static let shared = AutomaticLogCapture()

    private var persist: ((AutomaticLogRecord) -> Void)?
    private var timer: Timer?
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
        DispatchQueue.main.async { [weak self] in
            self?.startH5Timer()
        }
    }

    private func startH5Timer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.drainWebViews()
        }
        if let timer {
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    private func drainWebViews() {
        for webView in allWebViews() {
            webView.evaluateJavaScript(H5ConsoleScripts.install) { [weak self] _, _ in
                webView.evaluateJavaScript(H5ConsoleScripts.drain) { value, _ in
                    self?.persistConsole(value)
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
    NSLogSinkBox.persist?(String(cString: pointer))
}
#endif
