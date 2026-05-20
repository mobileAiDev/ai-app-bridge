# Test Plan

## Static Checks

```bash
node -c desktop/ai-app-bridge-cli/bin/ai-app-bridge.js
node -c desktop/ai-app-bridge-cli/bin/mcp-server.js
cd desktop/ai-app-bridge-cli && npm test
node bin/ai-app-bridge.js --help
```

## Android Sample Smoke

Build and install the sample app, then run:

```bash
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js smoke --package-name io.github.mobileaidev.aiappbridge.sample
```

The smoke covers status, Android tree, UIAutomator tree, screenshot, native tap, native WebView DOM operations, logs, network, state, events, permission state, Flutter snapshot availability when a Flutter host is present, and OkHttp auto capture when the plugin is enabled.
It also attaches to the sample WebView through DevTools/CDP and verifies H5
network and console capture.

## External App Validation

For unattended compatibility runs, validate at least:

```bash
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js status --package-name <package>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js tree --package-name <package>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js screenshot --package-name <package> --out-file <file>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js keyboard-state --package-name <package>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js install-apk --package-name <package> --apk-path <apk>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js webview-pages --package-name <package>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js webview-network --package-name <package> --duration-ms 3000
```

Large Gradle apps should run under an external watchdog that records the last
output timestamp, build process state, and APK artifact presence before killing
a stale run.

On ROMs with managed installers, `install-apk` should be exercised on both a
fresh package install and a reinstall. The expected result should include
`installMode=new_install` or `installMode=reinstall`, any installer button taps,
and a final installed package state.
