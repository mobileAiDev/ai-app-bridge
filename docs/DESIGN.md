# Design

AI App Bridge gives desktop agents a repeatable app loop across Android,
iOS, Flutter, WebView/H5/CDP, WKWebView, and desktop Web Bridge targets:

1. Observe structured app state.
2. Act on Android, Flutter, or H5 surfaces.
3. Read logs, network, state, events, view trees, widget trees, and DOM.
4. Decide the next action.

## Boundaries

- Android runtime SDK: local HTTP bridge, Android View tree, native WebView DOM, `MobileCaptureStore` for logs/network/state/events, public record APIs, foreground Activity tracking.
- Android Gradle plugin: debug-only instrumentation such as OkHttp auto capture.
- Flutter plugin: WidgetInspector snapshots, runtime actions, Flutter log/network/state/event forwarding, Flutter H5 adapter registry.
- iOS runtime SDK: UIKit tree, WKWebView DOM/eval, screenshot, `MobileCaptureStore` for logs/network/state/events, and Flutter iOS evidence forwarding.
- Desktop Web SDK/provider: browser-page DOM/log/network/state/event evidence and explicit app commands through Web Bridge sessions.
- Desktop CLI/MCP: ADB, UIAutomator, screenshots, device input, devicectl, WebDriverAgent/XCUITest, Web Bridge session hosting, port forwarding, and MCP command wrapping.
- Isolated MCP `script` and `intent` runtimes: Script executes trusted-local-code JavaScript or Python (`permissions` gate Bridge calls only; not an OS sandbox). Intent records observation, decision, action, and evidence refs. Host live paths read phone `logs` / `network` / `state` / `events` from `MobileCaptureStore` and do not copy those payloads. MCP `history:true` on those streams reads the phone FactStore while connected; disconnect returns `target_disconnected` and does not fall back to a Host-copied payload. iOS `state` over 200 keys uses a byte-bounded keyed LRU.

The core runtime must not depend on a business network stack or business page code.

## Agent choice and evidence

Bridge supplies capabilities, facts, receipts and recovery. The agent selects the
strategy, target, retry and business verdict. Environmental mismatch is information;
unknown execution is an outcome of that action, not a permanent device policy.
The active OS owner, actual unavailable transport, malformed requests and failed
durable writes still matter mechanically and must be reported precisely.

- Selection ambiguity returns concrete candidates and valid next-call examples.
  An exact Agree button differs from prose containing Agree. Several real buttons
  require a selected reference; the tool does not guess the first one.
- Observations return useful partial data with coverage. Identity and current
  operability are checked separately from changing labels, layout and focus.
- Recovery preserves original records and offers public controls. Starting new
  work never rewrites old unknown work as success. Cancellation and reset do not
  undo already dispatched effects; live owners remain discoverable.
- Script defaults expose supported commands; caller-supplied permissions and
  Intent allowlists narrow scope when wanted. Trusted local code remains such.
- ADB argv is a common expert entry for install, transfer and diagnosis. Receipts
  describe the process; the agent verifies the device result.
- Output uses progressive disclosure: small results directly, large results as
  an indexed sample plus retained source; path/slice and programmable extraction
  read the same source. Missing sample entries are never a coverage claim.

See [the whole-project audit](AGENT_CHOICE_AUDIT_2026-10-12.md),
[historical evidence](HISTORICAL_USAGE_AUDIT_2026-10-12.md), and
[primary-source reference design](AGENT_TOOLING_REFERENCE_DESIGN_2026-10-12.md)
for implementation scope, remaining proposals and validation boundaries.
