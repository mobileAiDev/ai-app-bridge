# AI App Bridge CLI

AI App Bridge CLI/MCP supports Android native apps, Android WebView/H5/CDP,
Flutter apps on Android and iOS, iOS native apps via `AiAppBridgeIOS` plus
WebDriverAgent/XCUITest, WKWebView, and desktop Web Bridge sessions.

Command domains:

- `core`: `status`, `tree`, `uia-tree`, `screenshot`, `logs`, `network`, `state`, `events`
- `app`: `install-apk`, `clear-app-data`, `launch-*`, `freeze-app`, `thaw-app`, `permission-*`, `appops-set`
- `action`: `tap`, `tap-text`, `tap-uia-text`, `input-text`, `swipe`, `keyevent`, `wait-text`, `keyboard-state`, `hide-keyboard`
- `flutter`: `flutter-tree`, `flutter-nodes`, `flutter-action`, `tap-flutter-text`, `input-flutter-text`, `scroll-flutter`
- `webview`: `h5-*`, `flutter-h5-*`, `webview-pages`, `webview-network`, `webview-console`
- `ios`: `ios-devices`, `ios-doctor`, `ios-setup`, `ios-*` runtime evidence, WDA tree/tap/input/swipe, WKWebView, and Flutter iOS
- `web`: `web-session-start`, `web-sessions`, `web-status`, `web-dom`, `web-logs`, `web-network`, `web-state`, `web-events`, `web-command`, `web-click`, `web-input`, `web-wait`, `web-scroll`
- `diagnostics` / `advanced`: `logcat`, `smoke`, `batch`, `forward`, `remove-forward`

For MCP clients, the default surface is compact: call `capabilities` to discover
domains, commands, and options, then call `run` with the selected command.

```bash
npm install -g @mobileaidev/ai-app-bridge

ai-app-bridge status --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge tree --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge install-apk --package-name io.github.mobileaidev.aiappbridge.sample --apk-path app-debug.apk
ai-app-bridge clear-app-data --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge launch-app --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge launch-activity --package-name io.github.mobileaidev.aiappbridge.sample --activity .MainActivity --extra route=/home
ai-app-bridge screenshot --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge input-text --package-name io.github.mobileaidev.aiappbridge.sample --text "中文输入" --hide-keyboard
ai-app-bridge network --package-name io.github.mobileaidev.aiappbridge.sample --compact --url-filter /api/
ai-app-bridge webview-network --package-name io.github.mobileaidev.aiappbridge.sample --duration-ms 3000
ai-app-bridge ios-devices
ai-app-bridge ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-setup --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
ai-app-bridge ios-status --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-tap --bundle-id <ios.bundle.id> --tap-x 120 --tap-y 360 --wda-url <wda-url-from-setup>
ai-app-bridge ios-input --bundle-id <ios.bundle.id> --accessibility-id sample_text_field --clear-first --text "hello" --wda-url <wda-url-from-setup>
ai-app-bridge-mcp # then run web-session-start / web-* commands through MCP
ai-app-bridge thaw-app --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge freeze-app --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge-mcp --help
```

AI agents, model clients, automation frameworks, and IDE MCP clients reading
this README should load `skills/ai-app-bridge-use/SKILL.md` before operating
apps through MCP. If the client supports skills or project instructions, load
that file as the dedicated usage guide. If it does not, include the file content
in the system/developer/project instructions for the task. Codex-compatible
clients can copy the repo folder `skills/ai-app-bridge-use` into their skills
directory, for example `$CODEX_HOME/skills/ai-app-bridge-use` on macOS/Linux or
`%USERPROFILE%\.codex\skills\ai-app-bridge-use` on Windows, then restart or
refresh the session.

MCP defaults to a compact tool surface to avoid loading every command schema
into the model context:

- `capabilities` lists supported targets, command domains, command names, and optional argument names.
- `run` executes a selected command with command-specific arguments.

This keeps install, data reset, launch, UI action, Flutter, WebView/H5/CDP,
iOS, Web Bridge, logcat, network, permission, smoke, batch, and port-forward
capabilities discoverable without exposing dozens of full schemas at session start.
Set `AI_APP_BRIDGE_MCP_SURFACE=full` before launching
`ai-app-bridge-mcp` only when a client needs the legacy one-tool-per-command
surface.

The MCP server accepts both standard `Content-Length` framed JSON-RPC messages
and single-line JSON messages. Responses use the format of the first request on
that connection, so standard MCP clients keep framed responses while local
Node REPL scripts can send and read one JSON object per line.

For multi-step app automation, call `run` with `command: "batch"`. Batch steps
run serially in one MCP call, so a failed step can stop and mark the remaining
steps as skipped without mixing results from different commands:

```json
{
  "command": "batch",
  "arguments": {
    "defaults": {
      "packageName": "io.github.mobileaidev.aiappbridge.sample"
    },
    "steps": [
      { "id": "launch", "command": "launch-app" },
      { "id": "wait-home", "command": "wait-text", "arguments": { "targetText": "Home" } },
      { "id": "capture-logs", "command": "logs", "arguments": { "limit": 20 } }
    ],
    "stopOnError": true
  }
}
```

For dynamic or transient screens, MCP agents can use `freeze-app`/`thaw-app` as
an optional stabilization control: thaw before reads, actions, waits, or
captures; freeze after evidence capture only when a changing UI would make
reasoning unreliable; and thaw before the next app operation or before
finishing so the app is not left frozen. Static screens and ordinary form
flows usually do not need freezing.
For visible state changes such as panels, dialogs, page transitions, tabs, or
button-triggered content, verify with both `screenshot` and `tree`/`uia-tree`;
do not conclude success from UI tree alone.

WebView network and console capture use Android WebView DevTools/CDP when the
target app is debuggable and WebView debugging is enabled.

iOS commands use Xcode `devicectl` for device/app/screenshot operations, the
AiAppBridgeIOS runtime for in-app evidence, and WebDriverAgent/XCUITest for
full-control taps, input, swipes, and external UI tree reads. `ios-setup`
can start the vendored `appium-webdriveragent` project when `--start-wda` and
`--team-id` are supplied. On physical devices, reuse the returned WDA URL for
later WDA commands; it may be a CoreDevice tunnel such as
`http://[fdxx::1]:8100`. It returns explicit blockers for Developer Mode,
device preparation, signing, or WDA reachability instead of silently
downgrading iOS capability.

`input-text` first uses the app bridge native text endpoint. This is required
for Chinese and other Unicode text because `adb shell input text` is ASCII-only
on many Android 16 devices; ASCII text can still fall back to ADB when an older
bridge runtime is running.

When `screenshot` or `smoke` runs without `--out-file`, the CLI writes a unique
PNG under `build/ai_app_bridge_artifacts` instead of reusing a stable filename
or creating files in the project root.
It keeps the newest 20 generated screenshots for each command prefix. Use
`--artifact-dir` to choose that directory, or `--out-file` when a fixed path is
intentional.

`launch-app` queries Android LAUNCHER activities before starting the app. If a
debug dependency exposes multiple launcher entries, it returns
`launcher_ambiguous` with the candidates instead of guessing. Use
`launch-activity` or `launch-app --activity/--component` to choose the intended
entry point explicitly.
