# AI App Bridge CLI

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
ai-app-bridge thaw-app --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge freeze-app --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge-mcp
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

- `capabilities` lists the bridge domains and command names.
- `run` executes a selected command with command-specific arguments.

This keeps install, data reset, launch, UI, Flutter, WebView, logcat, network,
and permission capabilities discoverable without exposing dozens of full schemas
at session start. Set `AI_APP_BRIDGE_MCP_SURFACE=full` before launching
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

For dynamic screens, MCP agents should follow the `ai-app-bridge-use` cadence:
thaw immediately before reading app content or performing an app action, freeze
immediately after evidence or action results are captured, keep the app frozen
while reasoning/planning, and thaw once more before finishing the overall task.
For visible state changes such as panels, dialogs, page transitions, tabs, or
button-triggered content, verify with both `screenshot` and `tree`/`uia-tree`;
do not conclude success from UI tree alone.

WebView network and console capture use Android WebView DevTools/CDP when the
target app is debuggable and WebView debugging is enabled.

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
