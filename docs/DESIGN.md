# Design

AI App Bridge gives desktop agents a repeatable app loop across Android,
iOS, Flutter, WebView/H5/CDP, WKWebView, and desktop Web Bridge targets:

1. Observe structured app state.
2. Act on Android, Flutter, or H5 surfaces.
3. Read logs, network, state, events, view trees, widget trees, and DOM.
4. Decide the next action.

## Boundaries

- Android runtime SDK: local HTTP bridge, Android View tree, native WebView DOM, capture buffers, public record APIs, foreground Activity tracking.
- Android Gradle plugin: debug-only instrumentation such as OkHttp auto capture.
- Flutter plugin: WidgetInspector snapshots, runtime actions, Flutter log/network/state/event forwarding, Flutter H5 adapter registry.
- iOS runtime SDK: UIKit tree, WKWebView DOM/eval, screenshot, log/network/state/event buffers, and Flutter iOS evidence forwarding.
- Desktop Web SDK/provider: browser-page DOM/log/network/state/event evidence and whitelisted commands through Web Bridge sessions.
- Desktop CLI/MCP: ADB, UIAutomator, screenshots, device input, devicectl, WebDriverAgent/XCUITest, Web Bridge session hosting, port forwarding, and MCP command wrapping.

The core runtime must not depend on a business network stack or business page code.

## First Follow-Up

The Android, Flutter, iOS, WebView/H5, and Web Bridge surfaces can support an
AI loop by polling or session capture. The continuing infrastructure direction
is to keep a small MCP capability index visible while command-specific schemas
stay discoverable through `capabilities`.
