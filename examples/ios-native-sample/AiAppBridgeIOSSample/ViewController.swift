import AiAppBridgeIOS
import UIKit
import WebKit

final class ViewController: UIViewController, UITextFieldDelegate {
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let textField = UITextField()
    private let actionButton = UIButton(type: .system)
    private let webView = WKWebView(frame: .zero)
    private var tapCount = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        configureViews()
        loadWebContent()
        recordReady()
    }

    private func configureViews() {
        titleLabel.text = "AI App Bridge iOS Sample"
        titleLabel.font = .preferredFont(forTextStyle: .title2)
        titleLabel.accessibilityIdentifier = "sample_title"

        statusLabel.text = "Ready"
        statusLabel.font = .preferredFont(forTextStyle: .body)
        statusLabel.accessibilityIdentifier = "sample_status"

        textField.placeholder = "Type here"
        textField.borderStyle = .roundedRect
        textField.returnKeyType = .done
        textField.delegate = self
        textField.accessibilityIdentifier = "sample_text_field"
        textField.addTarget(self, action: #selector(textChanged), for: .editingChanged)

        actionButton.setTitle("Tap sample action", for: .normal)
        actionButton.accessibilityIdentifier = "sample_action_button"
        actionButton.addTarget(self, action: #selector(buttonTapped), for: .touchUpInside)

        webView.accessibilityIdentifier = "sample_web_view"

        let stack = UIStackView(arrangedSubviews: [
            titleLabel,
            statusLabel,
            textField,
            actionButton,
            webView,
        ])
        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            webView.heightAnchor.constraint(equalTo: view.safeAreaLayoutGuide.heightAnchor, multiplier: 0.45),
        ])
    }

    private func loadWebContent() {
        let html = """
        <!doctype html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>
              body { font: -apple-system-body; margin: 20px; }
              button, input { font: inherit; padding: 8px; margin-top: 8px; }
            </style>
          </head>
          <body>
            <h1>WKWebView Ready</h1>
            <p id="message">DOM evidence is available.</p>
            <input id="web-input" value="web text" />
            <button id="web-button" onclick="document.getElementById('message').textContent='Web button tapped'">Web action</button>
          </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: URL(string: "https://ai-app-bridge.local/ios-sample"))
    }

    private func recordReady() {
        AiAppBridge.shared.recordEvent(category: "ui", name: "screen_ready", data: ["screen": "home"])
        AiAppBridge.shared.recordNetwork(
            source: "ios-sample",
            method: "GET",
            url: "https://example.test/sample",
            statusCode: 200,
            durationMs: 12,
            responseBody: #"{"ok":true}"#
        )
    }

    @objc private func buttonTapped() {
        tapCount += 1
        statusLabel.text = "Tapped \(tapCount)"
        AiAppBridge.shared.recordLog(level: "info", tag: "Sample", message: "button tapped", data: ["count": tapCount])
        AiAppBridge.shared.recordState(namespace: "sample", key: "tapCount", value: tapCount)
        AiAppBridge.shared.recordEvent(category: "ui", name: "button_tapped", data: ["count": tapCount])
    }

    @objc private func textChanged() {
        AiAppBridge.shared.recordState(namespace: "sample", key: "text", value: textField.text ?? "")
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }
}
