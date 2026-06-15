# Cross-Platform Bridge Design

## Purpose

AI App Bridge should evolve from an Android/Flutter-specific bridge into a
compatibility-first runtime evidence platform. The core product loop stays the
same across every target:

```text
observe -> act -> collect evidence -> verify -> iterate
```

The platform-specific pieces should become providers behind one shared agent
contract. Android and Flutter remain first-class targets and their existing
behavior is the compatibility baseline.

## Compatibility Contract

Existing Android, Flutter, desktop CLI, and MCP behavior must not regress while
the architecture is generalized.

- Existing CLI command names, arguments, default output shapes, and error
  semantics remain stable.
- Existing compact MCP flow stays stable: `capabilities` lists command domains
  and `run` executes one command or a serial `batch`.
- Android app-specific commands continue to use `packageName` or explicit
  `port`; new non-Android targets must not weaken those checks.
- Android runtime, Android Gradle plugin, and Flutter plugin dependencies do
  not need to change for the first architecture phase.
- New targets use `sessionId`, `targetId`, or provider-specific IDs instead of
  overloading Android `packageName`.
- Provider work must be additive until a full compatibility pass proves the
  refactor is safe.

Current public MCP domains are the stable discovery entry point:

```text
core: status/tree/uia-tree/screenshot/logs/network/state/events
app: install/clear-data/launch/freeze/thaw/permissions/appops
action: tap/input/swipe/keyevent/wait/keyboard
flutter: widget tree/nodes/action/tap/input/scroll
webview: Android H5, Flutter H5, WebView CDP pages/network/console
ios: devices/setup/runtime evidence/WDA actions/WKWebView/Flutter iOS
web: session/dom/logs/network/state/events/command/click/input/wait/scroll
diagnostics: logcat/smoke
advanced: batch/port-forward
```

## Layers

```text
Agent / MCP client
  |
Desktop CLI / MCP server
  |
Provider router
  |-- android provider      existing ADB + in-app HTTP bridge
  |-- flutter provider      existing Android bridge + Flutter action/snapshot
  |-- web provider          browser SDK session + optional CDP/Playwright
  |-- miniprogram provider  JS SDK session + DevTools/ADB reverse helpers
  |-- ios provider          Swift SDK + XCUITest/WebDriverAgent/Safari tools
  `-- desktop provider      app SDK + OS accessibility/CDP where available
```

The provider router is the seam for new platforms. It should not force platform
details into the shared command model.

The first desktop implementation can keep Android commands on the current
short-lived CLI execution path. Providers that require live sessions, such as
web and mini program SDK connections, should run inside the MCP/desktop process
or a managed session server. Do not force session-based targets into the
existing Android spawn-and-exit command path.

## Shared Target Model

Every target exposes a compact status object and a capability map:

```json
{
  "targetType": "android|flutter|web|miniprogram|ios|desktop",
  "targetId": "provider-owned-id",
  "sessionId": "optional-live-session-id",
  "capabilities": {
    "tree": true,
    "dom": true,
    "screenshot": false,
    "logs": true,
    "network": true,
    "state": true,
    "events": true,
    "command": true,
    "assert": true
  }
}
```

Provider commands may expose different capabilities, but common evidence should
use the same names and cursor behavior whenever possible.

Target validation should be provider-aware:

- Android app commands require `packageName` or explicit `port`.
- Web commands require `sessionId` or an unambiguous `targetId`.
- Mini program commands require `sessionId` or a provider-owned project/runtime
  target.
- Commands with multiple live candidates must return an ambiguity error and the
  candidate list instead of guessing.

## Evidence Model

The current Android/Flutter capture model is the canonical baseline:

- `logs`
- `network`
- `state`
- `events`
- `tree` / `dom` / `a11y`
- `screenshot`
- `status`
- `commandResult`

Capture streams keep incremental cursors:

- `sinceId`
- `sinceMs`
- `limit`

Sensitive payload redaction remains mandatory for network and state records.

## Provider Phases

### Phase 0: Document And Verify

- Write the cross-platform architecture and web bridge plan.
- Add a compatibility gate to the test plan.
- Run desktop CLI/MCP, Android runtime/plugin, and Flutter checks.
- Do not change Android/Flutter runtime code in this phase.

### Phase 1: Desktop Provider Router

- Keep current Android commands and MCP behavior working exactly as they do now.
- Add provider metadata and target-type aware validation in desktop code, for
  example `targetKind: "android-app" | "web-target" | "none"`.
- Keep legacy command names as stable aliases.
- Introduce provider-owned command groups only after tests lock down current
  behavior.

### Phase 2: Web Bridge

- Add a web SDK and a desktop-side web session provider.
- Use WebSocket as the primary transport and HTTP polling as a fallback.
- Reuse `logs`, `network`, `state`, `events`, `dom`, `command`, and `batch`
  evidence semantics.
- Publish only after local package checks, dry-run packaging, and explicit
  release approval.

### Phase 3: Mini Program Bridge

- Add a mini program JS SDK that connects to the agent session server.
- Prefer ADB reverse for Android true-device debug sessions.
- Use DevTools automation and device UI automation as optional outer layers.

### Phase 4: iOS And Desktop

- iOS: Swift SDK for app-level evidence, plus XCUITest/WebDriverAgent for
  system/UI surfaces.
- Desktop: Electron/CEF through web/CDP first; native desktop through SDK and
  OS accessibility APIs.

## Compatibility Gate

Any provider-router refactor must pass at least:

```bash
cd desktop/ai-app-bridge-cli && npm run check
./gradlew :ai-app-bridge-android:build :ai-app-bridge-gradle-plugin:build :ai-app-bridge-gradle-plugin:test
cd flutter/ai_app_bridge_flutter && flutter analyze --no-pub
```

When a device is available, also run the Android sample smoke from
`docs/TEST_PLAN.md`.

## Release And Secret Handling

- npm credentials must be passed through environment variables or local npm
  auth only.
- Credentials must never be written into repository files, shell history,
  generated logs, or progress docs.
- Run package validation and `npm publish --dry-run` before any real publish.
- Publishing requires an explicit final confirmation after the package shape is
  stable and compatibility checks pass.

## Decision

Generalization is feasible and should be additive. The first invariant is that
Android, Flutter, CLI, and MCP stay stable. New platform work should enter
through provider-specific sessions and shared evidence schemas, not by changing
the existing Android runtime contract.
