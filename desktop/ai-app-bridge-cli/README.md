# AI App Bridge CLI

```bash
npm install -g @lidongping/ai-app-bridge

ai-app-bridge status --package-name io.github.lidongping.aiappbridge.sample
ai-app-bridge tree --package-name io.github.lidongping.aiappbridge.sample
ai-app-bridge install-apk --package-name io.github.lidongping.aiappbridge.sample --apk-path app-debug.apk
ai-app-bridge screenshot --package-name io.github.lidongping.aiappbridge.sample
ai-app-bridge input-text --package-name io.github.lidongping.aiappbridge.sample --text "中文输入" --hide-keyboard
ai-app-bridge network --package-name io.github.lidongping.aiappbridge.sample --compact --url-filter /api/
ai-app-bridge webview-network --package-name io.github.lidongping.aiappbridge.sample --duration-ms 3000
ai-app-bridge-mcp
```

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
