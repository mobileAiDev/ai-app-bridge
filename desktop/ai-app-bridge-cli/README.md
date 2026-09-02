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

## Persistent facts and action feedback

The MCP process keeps one in-process connection path per target, serializes
mutations for the same target, and continuously collects incremental
`logs`/`network`/`state`/`events` facts after an explicit target is used. Android
App logs come from that App's in-process `logs` stream by default; the collector
does not attribute device-wide logcat to the App. Device logs are enabled only
with the additive `deviceLogScope: "device"` option and are stored as an
explicit device target. One bounded stream is then reused per explicit serial.
The default buffers are `main`, `system`, and `crash`; sensitive `radio`,
`security`, and `kernel` buffers still require explicit `deviceLogBuffers`.
The observer keeps at most 32 targets and retires a target after 30 minutes
without an explicit operation. Its limit, expirations, evictions, failures, and
dropped-log counters are visible in `_feedback.observer`.

Facts are stored once in an authoritative segmented mmap store. A bounded
SQLite WAL index is only a rebuildable query projection; it is not a second
fact-payload store. Legacy history, Script evidence, and Intent evidence use
the same process-level FactStore with isolated adapters and namespaces. The MCP
default `auto` profile selects 1 GB when total disk capacity is at least 32 GiB and at
least 8 GiB is available, 512 MB when total disk capacity is at least 16 GiB and at
least 4 GiB is available, 256 MB when total capacity is at least 4 GiB and at
least 2 GiB is available, and 64 MB otherwise. Explicitly select a profile with
`AI_APP_BRIDGE_FACT_CACHE_PROFILE=1gb`, `512mb`, `256mb`, or `64mb`. Override
the store directory with `AI_APP_BRIDGE_FACT_STORE_DIR`. The legacy
`AI_APP_BRIDGE_FACT_CACHE_PATH` setting remains accepted and places the new
`fact-store-v1` directory beside that path. `AI_APP_BRIDGE_FACT_CACHE=off`
continues to disable Legacy fact recording without weakening Script/Intent
evidence gates. The default macOS path is
`~/Library/Caches/ai-app-bridge/fact-store-v1`.

Partitions have independent shares of the mmap budget: network 25%, UI 18%,
App logs 10%, device logs 7%, state/events 10%, actions 13%, notes 5%, and index
metadata 2%; 10% remains reserved for manifests and recovery. The SQLite
projection has a separate bounded budget and cannot evict mmap facts. The
feedback reports the selected profile, disk selection inputs, mmap usage, and
projection health. The npm package bundles the native source and builds its
Node-API binding during installation. If the native store or query projection
cannot initialize, existing foreground commands still run and report degraded
history; Script/Intent fail their own evidence gate. The server never silently
claims an in-memory buffer is persistent.

Existing SQLite fact-cache files are left intact and are not silently imported;
opaque `fc1` cursors cannot be reused as segmented-store `fs1` cursors.

The automatic collector persists network metadata and redacted headers. It
stores raw body byte counts plus omission flags, not request or response body
content. An explicit live `network` read keeps its existing behavior. Each fact
also carries a canonical target key, App identity, runtime epoch, global
sequence, timestamps, and an action id when correlation is available.

Existing evidence commands read the persisted timeline without adding a new
top-level command. Pass `history: true`, then reuse the returned opaque
`factCursor` for the next page. `events`/`ios-events`/`web-events` additionally
accept `includeActions: true` to return correlated execution records:

```json
{
  "command": "events",
  "packageName": "io.github.mobileaidev.aiappbridge.sample",
  "history": true,
  "includeActions": true,
  "arguments": { "limit": 100 }
}
```

Every normal object result keeps its legacy fields and adds `_feedback` unless
`feedback: "off"` is requested. The default `auto` mode does not add post-action
UI polling, trees, or screenshots. `feedback: "full"` waits briefly for a correlated UI event; when no
change is observed, it returns an inconclusive result plus current tree and
screenshot references instead of claiming success. Observer health, runtime
epoch, dropped-log counters, and persisted fact references are reported in the
same feedback object.

For a coordinate tap on the foreground Android App, `auto`/`full` feedback uses
one App-local bridge request and reports the actual hit View, bounds, window,
and touch handling result. System UI and non-target foreground taps keep the
single-ADB path and report that App-local component feedback is unavailable.
The request id is carried into synchronous runtime log/network/state/event
records. Later asynchronous records are correlated by the bounded action
timeline instead of being presented as an exact runtime binding.

Generated Android and iOS screenshot artifacts share the same automatic
lifecycle: at most 20 files per screenshot prefix, no older than 24 hours, and
at most 64 MB total. An explicitly supplied `outFile` is user-owned and is not
automatically removed. Screenshot bytes remain files and are never copied into
the fact database.

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
PNG under a git-ignored project artifact directory. Gradle, Android, and Flutter
projects normally use `build/ai_app_bridge_artifacts`; Node projects can use
`node_modules/.cache/ai_app_bridge_artifacts`; Swift projects can use
`.build/ai_app_bridge_artifacts`. If the current git worktree has no ignored
artifact candidate, generated defaults go under `.git/ai_app_bridge_artifacts`
so they cannot dirty the repository root. It keeps the newest 20 generated
screenshots for each command prefix. Use `--artifact-dir` to choose an ignored
directory, or `--out-file` when a fixed path is intentional.

`launch-app` queries Android LAUNCHER activities before starting the app. If a
debug dependency exposes multiple launcher entries, it returns
`launcher_ambiguous` with the candidates instead of guessing. Use
`launch-activity` or `launch-app --activity/--component` to choose the intended
entry point explicitly.
