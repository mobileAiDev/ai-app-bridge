# Test Plan

## Compatibility Gate

Cross-platform provider work is allowed only when existing Android, Flutter,
desktop CLI, and MCP behavior stays compatible. Before merging provider-router,
web, mini program, iOS, or desktop-target changes, run the smallest available
gate that covers the current code path:

```bash
cd desktop/ai-app-bridge-cli && npm run check
cd web/ai-app-bridge-web && npm test && npm run build
./gradlew :ai-app-bridge-android:build :ai-app-bridge-gradle-plugin:build :ai-app-bridge-gradle-plugin:test
cd ios/ai-app-bridge-ios && swift package dump-package && xcodebuild -scheme AiAppBridgeIOS -destination 'generic/platform=iOS' -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
cd flutter/ai_app_bridge_flutter && flutter analyze --no-pub
```

When a device is available, also run the Android sample validation below. Existing
Android/MCP commands must keep their current names, arguments, and output/error
shapes unless a migration note and compatibility alias are provided.

## Static Checks

```bash
node -c desktop/ai-app-bridge-cli/bin/ai-app-bridge.js
node -c desktop/ai-app-bridge-cli/bin/mcp-server.js
node -c desktop/ai-app-bridge-cli/bin/ios-provider.js
cd desktop/ai-app-bridge-cli && npm test
node bin/ai-app-bridge.js --help
```

## Android Sample Validation

The former `smoke` command no longer exists; a client that still lists `smoke`
or `batch` is showing a stale tool cache. Build and install the sample app,
open its native test Activity, then run the UI → state → network loop through
a real MCP client and JS Script (see
`desktop/ai-app-bridge-cli/scripts/validation/android-sample-capture-loop.md`
for its preconditions and assertions):

```bash
node desktop/ai-app-bridge-cli/scripts/validation/android-sample-capture-loop.js --serial <serial> --out <new-output-dir>
```

The loop covers status, tree, `tap-text`, state, network, screenshot and OkHttp
auto capture when the plugin is enabled. Cover the remaining read paths with the
individual commands; each returns one line of compact JSON with the business
value in `value`:

```bash
CLI="node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js"
PKG=io.github.mobileaidev.aiappbridge.sample
$CLI uia-tree --serial <serial> --package-name $PKG
$CLI h5-dom --serial <serial> --package-name $PKG
$CLI webview-pages --serial <serial> --package-name $PKG
$CLI logs --serial <serial> --package-name $PKG --limit 20
$CLI events --serial <serial> --package-name $PKG --limit 20
$CLI permission-state --serial <serial> --package-name $PKG --permission android.permission.CAMERA
$CLI flutter-tree --serial <serial> --package-name $PKG
```

Without a Flutter host the SDK answers `flutter-tree` with
`ok:false, error:flutter_action_handler_absent` (exit code 1); a Flutter host is
required for a positive result. `webview-pages` lists the DevTools/CDP pages of
the sample WebView; `webview-network`/`webview-console` then capture H5 network
and console records through the selected page.

## iOS Full-Control Smoke

Prerequisites:

- Xcode is installed and `xcodebuild -version` works.
- The iPhone is trusted, unlocked, and has Developer Mode enabled.
- `xcrun devicectl list devices --json-output <file>` reports `developerModeStatus: enabled` and developer disk image services available.
- A debug iOS app includes `AiAppBridgeIOS` and calls `AiAppBridge.shared.start(...)`.
- WebDriverAgentRunner can be signed and started by `ios-setup --start-wda --team-id <APPLE_TEAM_ID>`, or is already reachable through an explicit `--wda-url`.

Run:

```bash
cd desktop/ai-app-bridge-cli && npm run check
cd ../..
cd ios/ai-app-bridge-ios && swift package dump-package
xcodebuild -scheme AiAppBridgeIOS -destination 'generic/platform=iOS' -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
cd ../..
cd examples/ios-native-sample
xcodebuild -project AiAppBridgeIOSSample.xcodeproj -scheme AiAppBridgeIOSSample -configuration Debug -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
cd ../..

node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-devices
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-setup --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-install-app --device-id <device-or-udid> --app-path <DerivedData>/Build/Products/Debug-iphoneos/AiAppBridgeIOSSample.app
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-launch-app --device-id <device-or-udid> --bundle-id io.github.mobileaidev.aiappbridge.iossample
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-status --device-id <device-or-udid> --bundle-id <ios.bundle.id>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-tree --device-id <device-or-udid> --bundle-id <ios.bundle.id>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-h5-dom --device-id <device-or-udid> --bundle-id <ios.bundle.id>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-uia-tree --bundle-id <ios.bundle.id> --wda-url <wda-url-from-setup>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-tap --bundle-id <ios.bundle.id> --tap-x 120 --tap-y 360 --wda-url <wda-url-from-setup>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-input --bundle-id <ios.bundle.id> --accessibility-id <field-accessibility-id> --clear-first --text "hello" --wda-url <wda-url-from-setup>
node desktop/ai-app-bridge-cli/bin/ai-app-bridge.js ios-swipe --bundle-id <ios.bundle.id> --start-x 160 --start-y 620 --end-x 160 --end-y 220 --duration-ms 500 --wda-url <wda-url-from-setup>
```

If any prerequisite requires a user action, such as enabling Developer Mode, trusting the Mac, unlocking the device, adding an Apple account/team in Xcode, or accepting a signing/device prompt, stop and record the blocker. Do not skip WDA or fall back to a reduced iOS mode for full-control validation.

The included native sample app is only a validation host. It should be built
and installed to prove the Swift runtime works in a real iPhone app before
publishing the Swift package.

## Web Bridge MVP Smoke

Run the SDK/package checks:

```bash
cd web/ai-app-bridge-web && npm test && npm run build
cd desktop/ai-app-bridge-cli && npm run check
```

For an end-to-end web session, start a local desktop Web provider, open a
browser page that calls `createAiAppBridge({ endpoint, token, appName })`,
then verify the provider can read `web-status`, `web-dom`, `web-logs`,
`web-network`, `web-state`, and `web-events`, can run a registered action
through `web-command`, and can exercise DOM helpers through `web-click`,
`web-input`, `web-wait`, or `web-scroll` where the page fixture exposes stable
selectors.

To verify the published npm packages rather than local source:

```bash
npm install -g @mobileaidev/ai-app-bridge@latest
cd web/remote-smoke && npm install && npm run check
```

Then start `ai-app-bridge-mcp`, run `web-session-start`, open
`web/remote-smoke/index.html` with the returned endpoint/token, and verify
`web-dom`, `web-logs`, `web-network`, `web-state`, `web-events`, and
`web-command`.

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
