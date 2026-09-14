'use strict';

const { sdkCommands: iosSdkCommands } = require('./ios-runtime-binding');

const { CommandError } = require('./command-errors');
const { validateValue } = require('./shared-kernel/argument-schema');
const { executionCommandSchema, nativeGestureSchema, nativeSelector, flutterSelector } = require('./shared-kernel/execution-contracts');
const { flutterActionSchema, webCommandSchema } = require('./shared-kernel/provider-command-contracts');

const commandDefinitions = [
  { command: 'runtime', domain: 'execution', summary: 'Inspect, start or orderly stop the shared local execution runtime. CLI exit and MCP disconnect leave operations running; stop cancels and drains them.', targetKind: 'host-runtime', options: ['operation'] },
  { command: 'device-ownership', domain: 'execution', summary: 'Read ownership, reconcile original completion, explicitly cancel a retained install by actionId, or read a retained UIA receipt by serial/runtimeEpoch/actionId. Installation cancellation abandons its original PM session; it does not roll back an installed APK.', targetKind: 'android-device', options: ['operation', 'serial', 'timeoutMs', 'runtimeEpoch', 'actionId'] },
  { command: 'uia-runtime', domain: 'advanced', summary: 'Read, start or orderly stop the Android API 25+ UIA node runtime. Start checks the phone process lock; unacknowledged original receipts are retained.', targetKind: 'android-device', options: ['operation', 'serial', 'adb', 'timeoutMs'] },
  { command: 'status', domain: 'core', summary: 'Read bridge status, app/device metadata, capture counts, and Flutter summary.', targetApp: true, options: ['packageName', 'port', 'serial', 'full'] },
  { command: 'tree', domain: 'core', summary: 'Read Android View tree from the in-app bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'compact', 'textFilter', 'resourceIdFilter', 'classFilter', 'visibleOnly', 'maxNodes', 'maxDepth'] },
  { command: 'uia-tree', domain: 'core', summary: 'Read UIAutomator XML for the current foreground window.', options: ['serial', 'compact', 'textFilter', 'resourceIdFilter', 'classFilter', 'visibleOnly', 'maxNodes', 'maxDepth'] },
  { command: 'screenshot', domain: 'core', summary: 'Capture a screenshot, with foreground package verification when packageName is supplied.', options: ['serial', 'packageName', 'outFile', 'artifactDir'] },
  { command: 'logs', domain: 'core', summary: 'Read in-app log records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'network', domain: 'core', summary: 'Read in-app network records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'compact', 'urlFilter', 'method', 'statusCode', 'noBodies', 'bodyMaxBytes', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'state', domain: 'core', summary: 'Read in-app state records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'events', domain: 'core', summary: 'Read in-app event records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'sinceId', 'sinceMs', 'limit', 'includeActions'] },
  { command: 'logcat', domain: 'diagnostics', summary: 'Read Android logcat with optional app pid, tag, level, and grep filters.', options: ['serial', 'packageName', 'pid', 'appPid', 'tag', 'level', 'grep', 'lines', 'since', 'follow', 'durationSec', 'clear'] },
  { command: 'install-apk', domain: 'app', summary: 'Start a supervised Intent installation. Use intent observe/decide for actual system UI; completion binds the original phone job/session and independently verifies installed APK bytes. Requires Android SDK aapt/apksigner.', options: ['serial', 'packageName', 'apkPath', 'allowDowngrade', 'timeoutMs', 'adb', 'adbTimeoutMs', 'aaptPath', 'apksignerPath', 'recordingDir'] },
  { command: 'clear-app-data', domain: 'app', summary: 'Clear app data once through explicit method: pm-clear (default) or runtime. No fallback on failure.', targetApp: true, options: ['serial', 'packageName', 'method'] },
  { command: 'freeze-app', domain: 'app', summary: 'Stop target App processes with SIGSTOP, including the SDK socket. Capture first; thaw before SDK reads or actions.', targetApp: true, options: ['serial', 'packageName', 'pid'] },
  { command: 'thaw-app', domain: 'app', summary: 'Resume target app processes with SIGCONT before reads, waits, captures, actions, or final handoff.', targetApp: true, options: ['serial', 'packageName', 'pid'] },
  { command: 'launch-app', domain: 'app', summary: 'Launch the target package LAUNCHER Activity and report launcher candidates.', targetApp: true, options: ['serial', 'packageName', 'activity', 'component', 'action', 'category', 'data', 'extra', 'clearTask'] },
  { command: 'launch-activity', domain: 'app', summary: 'Launch an explicit Android Activity component with optional string extras.', targetApp: true, options: ['serial', 'packageName', 'activity', 'component', 'action', 'category', 'data', 'extra'] },
  { command: 'permission-state', domain: 'app', summary: 'Read live PackageManager runtime permission state for an explicit package and Android user.', targetApp: true, options: ['serial', 'packageName', 'permission', 'userId', 'adb', 'adbTimeoutMs', 'timeoutMs'] },
  { command: 'permission-grant', domain: 'app', summary: 'Grant a runtime permission as a fixture and verify the resulting PackageManager state.', targetApp: true, options: ['serial', 'packageName', 'permission', 'userId', 'adb', 'adbTimeoutMs', 'timeoutMs'] },
  { command: 'permission-revoke', domain: 'app', summary: 'Revoke a runtime permission as a fixture and verify the resulting PackageManager state.', targetApp: true, options: ['serial', 'packageName', 'permission', 'userId', 'adb', 'adbTimeoutMs', 'timeoutMs'] },
  { command: 'permission-dialog', domain: 'app', summary: 'Start an Intent for an already visible runtime permission request. Agent selects observed UI; PackageManager state and Activity closure verify allow, allow-once, deny or dismiss. Cancel stops the operation without closing the dialog.', targetApp: true, options: ['serial', 'packageName', 'permission', 'outcome', 'userId', 'timeoutMs', 'adb', 'adbTimeoutMs', 'recordingDir'] },
  { command: 'appops-set', domain: 'app', summary: 'Set an Android app-op mode.', targetApp: true, options: ['serial', 'packageName', 'op', 'mode'] },
  { command: 'tap', domain: 'action', summary: 'Tap physical coordinates. App scope uses the SDK; device scope uses ADB. An explicit package must match the foreground in either scope.', options: ['serial', 'tapX', 'tapY', 'scope'] },
  { command: 'tap-text', domain: 'action', summary: 'Observe then tap one exact text match. provider:auto selects Native, Flutter, then UIAutomator before one dispatch; an explicit provider pins Script replay.', targetApp: true, options: ['serial', 'packageName', 'targetText', 'provider'] },
  { command: 'tap-uia-text', domain: 'action', summary: 'Revalidate one exact UIAutomator text match and foreground before device input.', options: ['serial', 'targetText', 'exact'] },
  { command: 'tap-uia', domain: 'action', summary: 'Tap one UIAutomator node by an exact semantic selector or an observed targetRef. Revalidate the original node and foreground before dispatch.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetRef'] },
  { command: 'tap-native', domain: 'action', summary: 'Tap one exact Native selector, optionally scoped to an observed row. Revalidate the View and foreground, then send a bound SDK action. Shared by CLI, MCP and Script.', targetApp: true, options: ['serial', 'packageName', 'selector'] },
  { command: 'wait-text', domain: 'action', summary: 'Wait for exact visible labels from one fresh foreground provider. Pure absence requires an explicit provider. Uses milliseconds.', targetApp: true, options: ['serial', 'packageName', 'targetText', 'provider', 'timeoutMs', 'intervalMs', 'requireText', 'absentText', 'requireActivity'] },
  { command: 'input-text', domain: 'action', summary: 'Replace native Android text, including empty or Unicode text. An exact selector binds the original editor; coordinates or the SDK focused-editor contract are separate targeting modes.', targetApp: true, options: ['serial', 'packageName', 'text', 'selector', 'tapX', 'tapY', 'hideKeyboard'] },
  { command: 'keyboard-state', domain: 'action', summary: 'Read Android soft keyboard visibility.', options: ['serial'] },
  { command: 'hide-keyboard', domain: 'action', summary: 'Hide the Android soft keyboard.', options: ['serial', 'force', 'intervalMs'] },
  { command: 'swipe', domain: 'action', summary: 'Swipe device coordinates through ADB.', options: ['serial', 'startX', 'startY', 'endX', 'endY', 'durationMs'] },
  { command: 'native-gesture', domain: 'action', summary: 'Long-press, swipe, or scroll an exact Native selector through the SDK, with a bound target and cancellable touch stream.', targetApp: true, options: ['serial', 'packageName', 'payload'] },
  { command: 'keyevent', domain: 'action', summary: 'Send an Android keyevent through ADB.', options: ['serial', 'keyCode'] },
  { command: 'flutter-tree', domain: 'flutter', summary: 'Read the latest Flutter layout snapshot.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'flutter-nodes', domain: 'flutter', summary: 'Read Flutter operable nodes.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'flutter-action', domain: 'flutter', summary: 'Dispatch an explicit typed Flutter SDK action object. SDK actions remain expert primitives; use Intent for observed decisions.', targetApp: true, options: ['serial', 'packageName', 'payload'] },
  { command: 'tap-flutter', domain: 'flutter', summary: 'Tap a bound Flutter selector, or explicit logical coordinates. Supply selector or tapX/tapY; logical coordinates must not be multiplied by devicePixelRatio.', targetApp: true, options: ['serial', 'packageName', 'selector', 'tapX', 'tapY'] },
  { command: 'tap-flutter-text', domain: 'flutter', summary: 'Revalidate one exact Flutter label in the foreground activity, then tap in logical coordinates.', targetApp: true, options: ['serial', 'packageName', 'targetText'] },
  { command: 'input-flutter-text', domain: 'flutter', summary: 'Type into one bound EditableText selected by selector, coordinates, or the focused/unique editor. Revalidate the original editor and focus after frames; never redirect input.', targetApp: true, options: ['serial', 'packageName', 'text', 'selector', 'tapX', 'tapY', 'hideKeyboard'] },
  { command: 'scroll-flutter', domain: 'flutter', summary: 'Scroll a bound Flutter container by delta or until exact unique text is visible. Supply selector when several containers exist.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'delta', 'maxSwipes'] },
  { command: 'h5-dom', domain: 'webview', summary: 'Observe one visible Android WebView with stable page and element identities; ambiguity returns candidates.', targetApp: true, options: ['serial', 'packageName', 'port', 'webViewId'] },
  { command: 'h5-eval', domain: 'webview', summary: 'Execute synchronous expert JavaScript in the explicitly observed Android H5 page.', targetApp: true, options: ['serial', 'packageName', 'script', 'expectedPage'] },
  { command: 'h5-click', domain: 'webview', summary: 'Click a uniquely observed H5 element after document, geometry and native occlusion checks.', targetApp: true, options: ['serial', 'packageName', 'webViewId', 'selector', 'expectedTarget'] },
  { command: 'h5-input', domain: 'webview', summary: 'Replace H5 editor text, including empty text, with the original page and element binding.', targetApp: true, options: ['serial', 'packageName', 'webViewId', 'selector', 'text', 'expectedTarget'] },
  { command: 'h5-wait', domain: 'webview', summary: 'Observe until an exact H5 selector matches in the same WebView. Performs no JavaScript mutation.', targetApp: true, options: ['serial', 'packageName', 'webViewId', 'selector', 'timeoutMs', 'intervalMs'] },
  { command: 'h5-scroll', domain: 'webview', summary: 'Scroll an observed element into view, or scroll the bound page by explicit CSS pixel deltas.', targetApp: true, options: ['serial', 'packageName', 'webViewId', 'selector', 'expectedTarget', 'expectedPage', 'deltaX', 'deltaY'] },
  { command: 'flutter-h5-dom', domain: 'webview', summary: 'Observe one visible Flutter H5 adapter with stable registration, document and element identities; multiple visible adapters require adapterId.', targetApp: true, options: ['serial', 'packageName', 'port', 'adapterId'] },
  { command: 'flutter-h5-eval', domain: 'webview', summary: 'Execute synchronous expert JavaScript in an explicitly observed Flutter H5 adapter document.', targetApp: true, options: ['serial', 'packageName', 'script', 'expectedPage'] },
  { command: 'flutter-h5-click', domain: 'webview', summary: 'Click one exact Flutter H5 element with adapter, document, geometry and DOM occlusion checks.', targetApp: true, options: ['serial', 'packageName', 'adapterId', 'selector', 'expectedTarget'] },
  { command: 'flutter-h5-input', domain: 'webview', summary: 'Replace text in one bound Flutter H5 editor; revalidate the original element after focus callbacks.', targetApp: true, options: ['serial', 'packageName', 'adapterId', 'selector', 'text', 'expectedTarget'] },
  { command: 'flutter-h5-wait', domain: 'webview', summary: 'Observe an exact selector in the same Flutter H5 adapter document; never switch pages or execute an eval mutation.', targetApp: true, options: ['serial', 'packageName', 'adapterId', 'selector', 'timeoutMs', 'intervalMs'] },
  { command: 'flutter-h5-scroll', domain: 'webview', summary: 'Scroll a bound Flutter H5 element into view or scroll its page by explicit CSS deltas.', targetApp: true, options: ['serial', 'packageName', 'adapterId', 'selector', 'expectedTarget', 'expectedPage', 'deltaX', 'deltaY'] },
  { command: 'webview-pages', domain: 'webview', summary: 'List attachable Android WebView DevTools/CDP pages.', targetApp: true, options: ['serial', 'packageName', 'webviewPort', 'socketName', 'targetId', 'pageUrlFilter', 'keepForward'] },
  { command: 'webview-network', domain: 'webview', summary: 'Capture WebView Network events through CDP.', targetApp: true, options: ['serial', 'packageName', 'webviewPort', 'socketName', 'targetId', 'pageUrlFilter', 'urlFilter', 'durationMs', 'script', 'includeResponseBody', 'bodyMaxBytes', 'maxEvents'] },
  { command: 'webview-console', domain: 'webview', summary: 'Capture WebView console/log events through CDP.', targetApp: true, options: ['serial', 'packageName', 'webviewPort', 'socketName', 'targetId', 'pageUrlFilter', 'durationMs', 'script', 'maxEvents'] },
  { command: 'ios-doctor', domain: 'ios', summary: 'Check Xcode, connected iPhone, AiAppBridgeIOS runtime, and WebDriverAgent readiness.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl', 'wdaUrl', 'wdaRunnerBundleId'] },
  { command: 'ios-setup', domain: 'ios', summary: 'Verify iOS setup; can install/launch the app and start the prepared bound WDA runtime when signing inputs are supplied.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'appPath', 'iosHost', 'iosPort', 'runtimeUrl', 'wdaUrl', 'wdaRunnerBundleId', 'wdaTestBundleId', 'teamId', 'startWda'] },
  { command: 'ios-devices', domain: 'ios', summary: 'List iOS devices known to xcrun devicectl.', targetKind: 'ios-device', options: ['deviceId'] },
  { command: 'ios-install-app', domain: 'ios', summary: 'Install an iOS .app bundle through devicectl.', targetKind: 'ios-app', options: ['deviceId', 'appPath'] },
  { command: 'ios-launch-app', domain: 'ios', summary: 'Launch an iOS app by bundle identifier through devicectl.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'terminateExisting'] },
  { command: 'ios-execution', domain: 'ios', summary: 'Read SDK or WDA execution/physical ownership, cancel an original action, read its durable completion, or reconcile unknown ownership without replay.', targetKind: 'ios-app', options: ['operation', 'deviceId', 'bundleId', 'kind', 'actionId', 'runtimeEpoch', 'runtimeUrl', 'iosHost', 'iosPort', 'wdaRunnerBundleId', 'wdaUrl', 'devicectl', 'timeoutMs', 'setupResultPath'] },
  { command: 'ios-status', domain: 'ios', summary: 'Read AiAppBridgeIOS runtime status.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl'] },
  { command: 'ios-tree', domain: 'ios', summary: 'Read UIKit tree from the AiAppBridgeIOS runtime.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl'] },
  { command: 'ios-logs', domain: 'ios', summary: 'Read in-app iOS log records.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'ios-network', domain: 'ios', summary: 'Read in-app iOS network records.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'ios-state', domain: 'ios', summary: 'Read in-app iOS state records. More than 200 keys use a byte-bounded keyed LRU; the normal range stays equivalent.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'ios-events', domain: 'ios', summary: 'Read in-app iOS event records.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl', 'sinceId', 'sinceMs', 'limit', 'includeActions'] },
  { command: 'ios-h5-dom', domain: 'ios', summary: 'Read a unique visible WKWebView and its bound document/element identities. Select webViewId explicitly when multiple views are visible.', targetKind: 'ios-app', options: ['webViewId'] },
  { command: 'ios-h5-eval', domain: 'ios', summary: 'Execute expert JavaScript in an explicitly observed WKWebView document, with original execution receipts.', targetKind: 'ios-app', options: ['expectedPage', 'script'] },
  { command: 'ios-h5-click', domain: 'ios', summary: 'Click one exact DOM element in a bound visible WKWebView document.', targetKind: 'ios-app', options: ['webViewId', 'selector', 'expectedTarget'] },
  { command: 'ios-h5-input', domain: 'ios', summary: 'Replace one exact DOM editor value in a bound WKWebView document.', targetKind: 'ios-app', options: ['webViewId', 'selector', 'expectedTarget', 'text'] },
  { command: 'ios-h5-scroll', domain: 'ios', summary: 'Scroll an observed DOM element into view in the same bound WKWebView document.', targetKind: 'ios-app', options: ['webViewId', 'selector', 'expectedTarget'] },
  { command: 'ios-flutter-tree', domain: 'ios', summary: 'Read Flutter iOS layout snapshot from the runtime.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl'] },
  { command: 'ios-flutter-nodes', domain: 'ios', summary: 'Read Flutter iOS operable nodes from the runtime.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl'] },
  { command: 'ios-flutter-action', domain: 'ios', summary: 'Dispatch a Flutter iOS action through the runtime.', targetKind: 'ios-app', options: ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl', 'payload'] },
  { command: 'ios-tap-flutter', domain: 'ios', summary: 'Tap one exact Flutter iOS node using a live Element reference.', targetKind: 'ios-app', options: ['selector'] },
  { command: 'ios-input-flutter-text', domain: 'ios', summary: 'Replace text in one exact Flutter iOS editor.', targetKind: 'ios-app', options: ['selector', 'text'] },
  { command: 'ios-scroll-flutter', domain: 'ios', summary: 'Scroll one exact Flutter iOS container by a logical-pixel delta.', targetKind: 'ios-app', options: ['selector', 'delta'] },
  { command: 'ios-flutter-back', domain: 'ios', summary: 'Ask the bound Flutter iOS navigator to go back once.', targetKind: 'ios-app', options: [] },
  { command: 'ios-flutter-hide-keyboard', domain: 'ios', summary: 'Unfocus the bound Flutter iOS app and request keyboard dismissal. Reobserve viewport.viewInsets to verify dismissal.', targetKind: 'ios-app', options: [] },
  { command: 'ios-screenshot', domain: 'ios', summary: 'Capture an iOS device screenshot through devicectl.', targetKind: 'ios-device', options: ['deviceId', 'outFile', 'artifactDir', 'displayUniqueId'] },
  { command: 'ios-wda-status', domain: 'ios', summary: 'Check the WDA instance bound to the selected device Runner container.', targetKind: 'ios-device', options: ['deviceId', 'wdaRunnerBundleId', 'wdaUrl'] },
  { command: 'ios-wda-session', domain: 'ios', summary: 'Explicitly create, inspect, or close a WDA session attached to an already foreground App; never launch an App or replace another session.', targetKind: 'ios-app', options: ['operation', 'deviceId', 'wdaRunnerBundleId', 'wdaUrl', 'bundleId', 'wdaSessionId'] },
  { command: 'ios-uia-tree', domain: 'ios', summary: 'Read the bound App session XCUITest tree.', targetKind: 'ios-app', options: ['bundleId', 'wdaUrl', 'wdaSessionId'] },
  { command: 'ios-tap', domain: 'ios', summary: 'Tap coordinates in the bound foreground App session.', targetKind: 'ios-app', options: ['bundleId', 'wdaUrl', 'wdaSessionId', 'tapX', 'tapY'] },
  { command: 'ios-tap-native', domain: 'ios', summary: 'Tap one visible native iOS control by exact accessibilityId, label or observed elementId, bound to its WDA session and element identity.', targetKind: 'ios-app', options: ['selector', 'expectedTarget'] },
  { command: 'ios-input-native-text', domain: 'ios', summary: 'Replace text in one exact native iOS editor with live identity and focus checks.', targetKind: 'ios-app', options: ['selector', 'text', 'expectedTarget'] },
  { command: 'ios-input', domain: 'ios', summary: 'Type into exactly one explicit WDA element or unique accessibility ID in the bound App session.', targetKind: 'ios-app', options: ['bundleId', 'wdaUrl', 'wdaSessionId', 'text', 'accessibilityId', 'elementId', 'clearFirst'] },
  { command: 'ios-swipe', domain: 'ios', summary: 'Swipe coordinates in the bound foreground App session.', targetKind: 'ios-app', options: ['bundleId', 'wdaUrl', 'wdaSessionId', 'startX', 'startY', 'endX', 'endY', 'durationMs'] },
  { command: 'ios-set-orientation', domain: 'ios', summary: 'Rotate the device for a requested App interface orientation in the bound foreground session. The original XCTest completion reports the observed interface direction; reobserve the UI before interacting.', targetKind: 'ios-app', options: ['orientation', 'expectedSession'] },
  { command: 'web-provider-status', domain: 'web', summary: 'Read desktop Web Bridge provider status.', options: [] },
  { command: 'web-session-start', domain: 'web', summary: 'Start the desktop Web Bridge WebSocket session server.', options: ['host', 'webPort', 'path', 'token'] },
  { command: 'web-session-stop', domain: 'web', summary: 'Close this Host Web server and its sockets; unresolved actions retain ownership.', options: [] },
  { command: 'web-execution', domain: 'web', summary: 'Read, cancel or recover the original Web action using committed completion facts.', targetKind: 'web-target', options: ['operation', 'sessionId', 'runtimeEpoch', 'targetId', 'actionId', 'timeoutMs'] },
  { command: 'web-connect-info', domain: 'web', summary: 'Read the Web Bridge endpoint and token for SDK clients.', options: [] },
  { command: 'web-sessions', domain: 'web', summary: 'List connected Web Bridge SDK sessions.', options: [] },
  { command: 'web-status', domain: 'web', summary: 'Read status and capture counts for a Web Bridge session.', targetKind: 'web-target', options: ['sessionId'] },
  { command: 'web-dom', domain: 'web', summary: 'Read the current bound document DOM, or explicit committed DOM history.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'selector', 'maxControls', 'timeoutMs', 'history', 'cursor', 'throughCursor', 'sinceMs', 'limit'] },
  { command: 'web-logs', domain: 'web', summary: 'Read committed Web log windows or explicit history.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'view', 'factCursor', 'afterActionId', 'history', 'cursor', 'throughCursor', 'sinceMs', 'limit'] },
  { command: 'web-network', domain: 'web', summary: 'Read committed Web network windows or explicit history.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'view', 'factCursor', 'afterActionId', 'history', 'cursor', 'throughCursor', 'sinceMs', 'limit'] },
  { command: 'web-state', domain: 'web', summary: 'Read committed Web state windows or explicit history.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'view', 'factCursor', 'afterActionId', 'history', 'cursor', 'throughCursor', 'sinceMs', 'limit'] },
  { command: 'web-events', domain: 'web', summary: 'Read committed Web event windows or explicit history.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'view', 'factCursor', 'afterActionId', 'history', 'cursor', 'throughCursor', 'sinceMs', 'limit'] },
  { command: 'web-command', domain: 'web', summary: 'Run a typed built-in Web SDK command, or action with an explicit registered App action name and JSON arguments.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'name', 'arguments', 'timeoutMs'] },
  { command: 'web-click', domain: 'web', summary: 'Click one visible DOM element, optionally bound to its observed page and element identity.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'selector', 'expectedTarget', 'timeoutMs'] },
  { command: 'web-input', domain: 'web', summary: 'Replace text in a form input or contenteditable editor through browser input events.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'selector', 'expectedTarget', 'value', 'timeoutMs'] },
  { command: 'web-key', domain: 'web', summary: 'Dispatch one Enter or Escape keydown event to one observed DOM control.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'selector', 'expectedTarget', 'key', 'timeoutMs'] },
  { command: 'web-wait', domain: 'web', summary: 'Wait for text or selector through the Web Bridge SDK command path.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'selector', 'targetText', 'timeoutMs'] },
  { command: 'web-scroll', domain: 'web', summary: 'Bring one DOM element into view or scroll an element or window by explicit deltas.', targetKind: 'web-target', options: ['sessionId', 'runtimeEpoch', 'targetId', 'mode', 'selector', 'expectedTarget', 'deltaX', 'deltaY', 'timeoutMs'] },
  { command: 'forward', domain: 'advanced', summary: 'Create the ADB port forward for the bridge.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'remove-forward', domain: 'advanced', summary: 'Remove the ADB port forward for the bridge.', options: ['serial', 'port'] },
];

const isolatedCommandDefinitions = [
  {
    command: 'script',
    domain: 'execution',
    summary: 'Run a trusted-local-code JavaScript or Python Script. Operations: start, status, wait, result, pause, resume, decide, cancel, runtime-status. Commands and assertions return results for Script code to handle; uncaught errors fail execution. Script source is not an OS sandbox.',
    options: ['operation', 'waitMs', 'afterSequence', 'recordingDir'],
    runtime: 'trusted-local-code',
  },
  {
    command: 'intent',
    domain: 'execution',
    summary: 'Run an Intent: start, status, observe, decide, pause, resume, cancel, or intervene. The total deadline includes observation and decision waits. Cancel drains owned work before persisting the terminal outcome; status recovers durable outcomes after restart without replay. target.foregroundPackages explicitly enables Android foreground provider routing.',
    options: ['operation', 'recordingDir'],
  },
  {
    command: 'evidence',
    domain: 'evidence',
    summary: 'Export retained Host evidence for one operation; includeRecordedPayloads adds files captured with start.recordingDir. Verify archives offline against their frozen manifest SHA-256 without opening FactStore or contacting devices.',
    options: ['operation', 'namespace', 'operationId', 'outputDir', 'includeRecordedPayloads', 'archiveDir', 'manifestSha256'],
  },
];

const mutationCommands = new Set([
  'install-apk', 'clear-app-data', 'freeze-app', 'thaw-app', 'launch-app',
  'launch-activity', 'permission-grant',
  'permission-revoke', 'permission-dialog', 'appops-set',
  'tap', 'tap-text', 'tap-uia-text', 'tap-uia', 'tap-native', 'input-text', 'hide-keyboard', 'swipe', 'native-gesture', 'keyevent',
  'flutter-action', 'tap-flutter', 'tap-flutter-text', 'input-flutter-text', 'scroll-flutter',
  'h5-eval', 'h5-click', 'h5-input', 'h5-scroll',
  'flutter-h5-eval', 'flutter-h5-click', 'flutter-h5-input', 'flutter-h5-scroll',
  'ios-setup', 'ios-install-app', 'ios-launch-app', 'ios-h5-eval', 'ios-h5-click', 'ios-h5-input', 'ios-h5-scroll', 'ios-flutter-action',
  'ios-tap', 'ios-input', 'ios-swipe', 'ios-set-orientation',
  'ios-tap-native', 'ios-input-native-text',
  'ios-tap-flutter', 'ios-input-flutter-text', 'ios-scroll-flutter', 'ios-flutter-back', 'ios-flutter-hide-keyboard',
  'web-session-start', 'web-session-stop', 'web-command', 'web-click', 'web-input', 'web-key', 'web-scroll', 'web-wait',
]);
const historyCommands = new Set([
  'tree', 'uia-tree', 'flutter-tree', 'flutter-nodes', 'screenshot', 'h5-dom', 'logcat',
  'logs', 'network', 'state', 'events', 'ios-tree', 'ios-uia-tree', 'ios-screenshot',
  'ios-h5-dom', 'ios-flutter-tree', 'ios-flutter-nodes', 'ios-logs', 'ios-network',
  'ios-state', 'ios-events', 'web-dom', 'web-logs', 'web-network', 'web-state', 'web-events',
]);
const captureCommands = new Set(['logs', 'network', 'state', 'events', 'ios-logs', 'ios-network', 'ios-state', 'ios-events']);
const androidCommon = ['adb', 'adbTimeoutMs', 'serial', 'packageName', 'port', 'timeoutMs'];
const iosCommon = ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl', 'wdaUrl', 'wdaSessionId', 'devicectl', 'xcodebuild', 'timeoutMs'];
const executionOptions = ['requestId', 'feedback'];
const requiredOptions = {
  tap: ['tapX', 'tapY'], 'tap-flutter': ['packageName'],
  'tap-text': ['targetText'], 'tap-uia-text': ['targetText'], 'tap-uia': ['packageName'], 'tap-native': ['packageName', 'selector'], 'tap-flutter-text': ['targetText'],
  'wait-text': [], 'input-text': ['text'], 'input-flutter-text': ['text'],
  swipe: ['startX', 'startY', 'endX', 'endY'],
  'native-gesture': ['packageName', 'payload'],
  'install-apk': ['apkPath'], 'clear-app-data': ['packageName'],
  'freeze-app': ['packageName'], 'thaw-app': ['packageName'],
  'permission-state': ['serial', 'packageName', 'permission'], 'permission-grant': ['packageName', 'permission'],
  'permission-revoke': ['packageName', 'permission'], 'permission-dialog': ['packageName', 'permission', 'outcome'], 'appops-set': ['packageName', 'op', 'mode'],
  'h5-eval': ['script', 'expectedPage'], 'h5-click': ['selector'], 'h5-wait': ['selector'], 'flutter-h5-eval': ['script', 'expectedPage'], 'ios-h5-eval': ['script', 'expectedPage'], 'ios-h5-click': ['selector'], 'ios-h5-input': ['selector', 'text'], 'ios-h5-scroll': ['selector'],
  'h5-input': ['selector', 'text'], 'flutter-h5-input': ['selector', 'text'], 'flutter-h5-click': ['selector'], 'flutter-h5-wait': ['selector'],
  'flutter-action': ['payload'], 'ios-flutter-action': ['payload'],
  'ios-install-app': ['appPath'], 'ios-launch-app': ['bundleId'],
  'ios-tap': ['tapX', 'tapY'], 'ios-input': ['text'],
  'ios-tap-native': ['selector'], 'ios-input-native-text': ['selector', 'text'],
  'ios-swipe': ['startX', 'startY', 'endX', 'endY'],
  'ios-set-orientation': ['orientation'],
  'ios-tap-flutter': ['selector'], 'ios-input-flutter-text': ['selector', 'text'], 'ios-scroll-flutter': ['selector', 'delta'],
  'web-command': ['name'], 'web-input': ['selector', 'value'],
};
const optionTypes = {};
function define(names, schema) {
  for (const name of names.split(' ')) optionTypes[name] = schema;
}
define('wdaRunnerBundleId wdaTestBundleId', { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9_.-]+$' });
define('adapterId webViewId', { type: 'string', minLength: 1 });
define('expectedPage', require('./shared-kernel/ios-h5-target').pageSchema);
define('expectedTarget', require('./shared-kernel/ios-h5-target').expectedTargetSchema);
define('expectedSession', require('./shared-kernel/ios-native-target').expectedSessionSchema);
define('orientation', require('./shared-kernel/ios-native-target').orientationSchema);
define('selector', { type: 'string', minLength: 1 });
define('spec', { type: 'object', additionalProperties: true });
define('targetRef', require('./shared-kernel/uia-protocol').targetRefSchema);
define('adb serial packageName artifactDir deviceId bundleId iosHost runtimeUrl wdaUrl wdaSessionId devicectl xcodebuild host path token setupResultPath appPath apkPath activity component action data initialRoute outFile permission op mode targetText requireText absentText requireActivity resourceId textFilter resourceIdFilter classFilter urlFilter method pageUrlFilter socketName targetId sessionId accessibilityId elementId wdaProjectPath wdaBundleId teamId displayUniqueId tag level grep since factCursor cursor runtimeEpoch afterActionId mobileFactId targetKey requestId deviceLogScope logcatFormat format agentModule pythonPath goal intent operationId recordingDir namespace outputDir archiveDir manifestSha256 name reason provider adapter', { type: 'string', minLength: 1 });
define('text value script payload', { type: 'string' });
define('aaptPath apksignerPath', { type: 'string', minLength: 1 });
define('full compact visibleOnly clear follow appPid force hideKeyboard noAutoHideKeyboard allowDowngrade clearTask exact skipFlutterLaunch includeResponseBody keepForward noBodies startWda terminateExisting clearFirst refresh includeActions history includeRecordedPayloads grepCaseSensitive includeCatalog', { type: 'boolean' });
define('tapX tapY startX startY endX endY', { type: 'number', minimum: 0, maximum: 2147483647, description: 'Finite non-negative coordinate. Space is specified by the command.' });
define('delta deltaX deltaY', { type: 'number', minimum: -2147483647, maximum: 2147483647 });
define('port iosPort webviewPort webPort', { type: 'integer', minimum: 1, maximum: 65535 });
define('webPort', { type: 'integer', minimum: 0, maximum: 65535, description: '0 asks the OS to assign an available local port.' });
define('adbTimeoutMs httpTimeoutMs timeoutMs installTimeoutMs installerTimeoutMs intervalMs durationMs', { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Milliseconds.' });
define('waitMs', { type: 'integer', minimum: 0, maximum: 60000, description: 'Milliseconds; 0 polls immediately.' });
define('timeoutSec durationSec', { type: 'number', exclusiveMinimum: 0, maximum: 2147483, description: 'Seconds. Retained explicit legacy unit.' });
define('sinceId sinceMs afterSequence revision', { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
define('limit eventLimit pid lines attempts maxSwipes', { type: 'integer', minimum: 1, maximum: 2147483647 });
define('maxNodes maxDepth maxEvents bodyMaxBytes', { type: 'integer', minimum: 0, maximum: 2147483647 });
define('keyCode', { type: 'integer', minimum: 0, maximum: 2147483647, default: 4 });
define('statusCode', { type: 'integer', minimum: 100, maximum: 599 });
define('category extra deviceLogBuffers', { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 } }] });
define('arguments target budget require decision', { type: 'object', additionalProperties: true });
define('feedback', { enum: ['auto', 'off', 'full'], description: 'auto/off/full.' });
define('view', { enum: ['legacy-live', 'decision-window', 'connected-history'] });
define('userId', { type: 'integer', minimum: 0, maximum: 2147483647, description: 'Defaults to the actual current Android user, frozen before mutation.' });
define('outcome', { enum: ['allow', 'allow-once', 'deny', 'dismiss'] });
define('operation', { type: 'string', minLength: 1 });
define('scope', { enum: ['app', 'device'], description: 'Defaults to app with packageName, otherwise device. App scope requires the SDK and does not fall back to ADB.' });
define('deviceLogScope', { enum: ['device'] });
define('history', { type: 'boolean', description: 'Mobile streams read the phone FactStore while connected; disconnected targets never use Host-copied payload. UI/Web history reads retained Host facts.' });

const extraOptions = {
  logcat: ['deviceLogScope', 'deviceLogBuffers', 'cursor', 'format', 'grepCaseSensitive'],
};
const commandByName = new Map(commandDefinitions.map(d => [d.command, d]));
const isolatedByName = new Map(isolatedCommandDefinitions.map(d => [d.command, d]));

function isMutationCommand(command, args = {}) {
  if (command === 'web-command' && args.name === 'domSnapshot') return false;
  return mutationCommands.has(command) || (command === 'logcat' && args.clear === true)
    || (command === 'device-ownership' && args.operation === 'cancel-install')
    || (command === 'ios-wda-session' && args.operation !== 'status')
    || (command === 'uia-runtime' && args.operation !== 'status')
    || ((command === 'webview-network' || command === 'webview-console') && args.script !== undefined);
}

function isAndroidMutation(command, args = {}) {
  return isMutationCommand(command, args) && !['runtime', 'device-ownership'].includes(command)
    && !command.startsWith('ios-') && !command.startsWith('web-');
}

function executionTimeoutMs(command, args = {}) {
  if (args.timeoutMs !== undefined) return args.timeoutMs;
  if (iosSdkCommands.has(command) || command === 'ios-execution' || require('./ios-wda-port').commands.has(command)) return 30000;
  if (command === 'ios-setup') return 300000;
  if (command === 'ios-install-app') return 120000;
  if (command.startsWith('web-')) return 5000;
  if (command.startsWith('ios-')) return undefined;
  return command === 'logcat' && args.follow === true ? (args.durationSec ?? 5) * 1000 + 1000 : 30000;
}

// These are execution capabilities, independent of MCP/CLI transport. Script
// permissions gate Bridge calls; trusted local code is not a process sandbox.
const scriptPermissions = Object.freeze({
  'app.read': ['status', 'tree', 'uia-tree', 'screenshot', 'flutter-tree', 'flutter-nodes', 'h5-dom', 'flutter-h5-dom', 'keyboard-state', 'permission-state',
    'ios-status', 'ios-tree', 'ios-uia-tree', 'ios-screenshot', 'ios-flutter-tree', 'ios-flutter-nodes', 'ios-h5-dom', 'ios-wda-status', 'web-status', 'web-dom'],
  'capture.read': ['logs', 'network', 'state', 'events', 'logcat', 'webview-console', 'webview-network', 'ios-logs', 'ios-network', 'ios-state', 'ios-events', 'web-logs', 'web-network', 'web-state', 'web-events'],
  'app.interact': ['launch-app', 'launch-activity', 'tap', 'tap-text', 'tap-uia-text', 'tap-uia', 'tap-native', 'input-text', 'swipe', 'native-gesture', 'keyevent', 'wait-text', 'hide-keyboard', 'tap-flutter', 'tap-flutter-text', 'input-flutter-text', 'scroll-flutter', 'h5-click', 'h5-input', 'h5-wait', 'h5-scroll', 'flutter-h5-click', 'flutter-h5-input', 'flutter-h5-wait', 'flutter-h5-scroll',
    'ios-h5-click', 'ios-h5-input', 'ios-h5-scroll', 'ios-launch-app', 'ios-wda-session', 'ios-tap', 'ios-input', 'ios-swipe', 'ios-set-orientation', 'ios-tap-native', 'ios-input-native-text', 'ios-tap-flutter', 'ios-input-flutter-text', 'ios-scroll-flutter', 'ios-flutter-back', 'ios-flutter-hide-keyboard', 'web-click', 'web-input', 'web-key', 'web-scroll', 'web-wait'],
  'app.lifecycle': ['clear-app-data'],
  'app.permissions': ['permission-grant', 'permission-revoke', 'appops-set'],
});
const scriptPermissionByCommand = new Map(Object.entries(scriptPermissions).flatMap(([permission, commands]) => commands.map(command => [command, permission])));
const workflowCommands = new Set(['install-apk', 'permission-dialog']);
const permissionCommands = new Set(['permission-state', 'permission-grant', 'permission-revoke']);
const expertCommands = new Set(['uia-runtime', 'freeze-app', 'thaw-app', 'flutter-action', 'h5-eval', 'flutter-h5-eval', 'ios-h5-eval', 'ios-flutter-action', 'ios-setup', 'web-command', 'forward', 'remove-forward', 'webview-pages', 'appops-set', 'permission-grant', 'permission-revoke']);
const deviceCommands = new Set(['uia-tree', 'screenshot', 'tap', 'tap-uia-text', 'keyboard-state', 'hide-keyboard', 'swipe', 'keyevent', 'logcat', 'permission-dialog', 'install-apk', 'remove-forward']);
function commandContract(command) {
  const definition = commandByName.get(command) || isolatedByName.get(command);
  if (!definition) throw new CommandError('unknown_command', `Unknown command: ${command}`, { field: 'command' });
  const isolated = isolatedByName.has(command);
  const platform = command === 'runtime' ? 'host' : isolated ? (command === 'evidence' ? 'host' : 'multi')
    : definition.domain === 'ios' ? 'ios' : definition.domain === 'web' ? 'web' : 'android';
  const role = command === 'runtime' || command === 'intent' || command === 'script' || workflowCommands.has(command) ? 'execution'
    : command === 'evidence' ? 'evidence' : expertCommands.has(command) ? 'expert' : 'capability';
  const permission = scriptPermissionByCommand.get(command) || null;
  return {
    role, platform,
    targetKind: definition.targetKind || (isolated ? command === 'evidence' ? 'operation' : 'platform-target'
      : definition.targetApp ? 'android-app' : deviceCommands.has(command) ? 'android-device' : 'host'),
    entrypoints: { mcp: true, cli: true, script: permission !== null },
    script: { supported: permission !== null, permission },
    ...(command === 'intent' ? { executablePlatforms: ['android', 'ios', 'web'],
      providersByPlatform: { android: ['native', 'uia', 'flutter', 'h5'], ios: ['native', 'h5', 'flutter'], web: ['h5'] } } : {}),
    execution: { kind: role === 'execution' ? 'operation' : isMutationCommand(command) ? 'mutation' : 'query',
      mutation: isMutationCommand(command),
      conditionalMutation: command === 'uia-runtime' ? 'operation != status' : command === 'logcat' ? 'clear=true' : ['webview-network', 'webview-console'].includes(command) ? 'script is supplied' : null,
      arbitration: command === 'script' || command === 'intent' ? 'target-platform-physical-device'
        : isAndroidMutation(command) ? 'cross-process-physical-android-device'
        : platform === 'ios' && isMutationCommand(command) ? 'cross-process-physical-ios-device'
        : command === 'device-ownership' ? 'exclusive-device-reconciliation' : null },
  };
}

function commandSchema(command) {
  const definition = commandByName.get(command) || isolatedByName.get(command);
  if (!definition) throw new CommandError('unknown_command', `Unknown command: ${command}`, { field: 'command' });
  if (command === 'runtime') return { type: 'object', additionalProperties: false, required: ['operation'],
    properties: { operation: { enum: ['start', 'status', 'stop'] } } };
  if (definition.domain === 'web') return require('./web/command-schema').webSchema(command);
  if (command === 'device-ownership') return { type: 'object', additionalProperties: false,
    properties: { operation: { enum: ['status', 'reconcile', 'receipt', 'cancel-install'] }, serial: { type: 'string', minLength: 1 },
      runtimeEpoch: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      actionId: { type: 'string', minLength: 1, maxLength: 1024 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } },
    required: ['operation', 'serial'], oneOf: [
      { properties: { operation: { enum: ['status', 'reconcile'] }, runtimeEpoch: false, actionId: false } },
      { properties: { operation: { const: 'receipt' }, timeoutMs: false }, required: ['runtimeEpoch', 'actionId'] },
      { properties: { operation: { const: 'cancel-install' }, runtimeEpoch: false }, required: ['actionId'] },
    ] };
  if (require('./ios-wda-port').commands.has(command)) {
    const names = ['deviceId', 'wdaRunnerBundleId', 'wdaUrl', 'devicectl', 'timeoutMs', ...executionOptions];
    if (command !== 'ios-wda-status') names.push('bundleId', 'wdaSessionId');
    const properties = Object.fromEntries(names.map(name => [name, optionTypes[name]]));
    const required = ['deviceId', 'wdaRunnerBundleId'];
    if (command === 'ios-wda-session') {
      properties.operation = { enum: ['status', 'create', 'close'] };
      return { type: 'object', additionalProperties: false, properties, required: [...required, 'operation'], oneOf: [
        { properties: { operation: { const: 'status' }, bundleId: false, wdaSessionId: false } },
        { properties: { operation: { const: 'create' }, wdaSessionId: false }, required: ['bundleId'] },
        { properties: { operation: { const: 'close' } }, required: ['bundleId', 'wdaSessionId'] },
      ] };
    }
    if (command !== 'ios-wda-status') required.push('bundleId', 'wdaSessionId');
    for (const name of definition.options.filter(name => !['bundleId','wdaUrl','wdaSessionId'].includes(name))) properties[name] = optionTypes[name];
    required.push(...(requiredOptions[command] || []));
    const schema = { type: 'object', additionalProperties: false, properties, required: [...new Set(required)] };
    if (command === 'ios-tap-native' || command === 'ios-input-native-text') {
      const native = require('./shared-kernel/ios-native-target');
      properties.selector = native.selectorSchema;
      properties.expectedTarget = native.expectedTargetSchema;
      if (command === 'ios-input-native-text') properties.text = { type: 'string', maxLength: 16384 };
    }
    if (command === 'ios-input') {
      schema.properties.text = { type: 'string', maxLength: 16384 };
      schema.oneOf = [
        { required: ['elementId'], properties: { accessibilityId: false } },
        { required: ['accessibilityId'], properties: { elementId: false } },
      ];
    }
    return schema;
  }
  if (command === 'ios-execution') return { type: 'object', additionalProperties: false,
    properties: { operation: { enum: ['status', 'result', 'cancel', 'reconcile'] },
      deviceId: optionTypes.deviceId, bundleId: optionTypes.bundleId, kind: { enum: ['h5', 'flutter', 'wda'] },
      actionId: { type: 'string', minLength: 1, maxLength: 256 }, runtimeEpoch: optionTypes.runtimeEpoch,
      wdaRunnerBundleId: optionTypes.wdaRunnerBundleId, wdaUrl: optionTypes.wdaUrl,
      runtimeUrl: optionTypes.runtimeUrl, iosHost: optionTypes.iosHost, iosPort: optionTypes.iosPort,
      devicectl: optionTypes.devicectl, timeoutMs: optionTypes.timeoutMs, setupResultPath: optionTypes.setupResultPath },
    required: ['operation', 'deviceId'], oneOf: [
      { properties: { kind: { enum: ['h5', 'flutter'] }, wdaRunnerBundleId: false, wdaUrl: false },
        anyOf: [
          { properties: { operation: { const: 'status' }, kind: false, actionId: false, runtimeEpoch: false, setupResultPath: false } },
          { properties: { operation: { const: 'reconcile' }, kind: false, actionId: false, runtimeEpoch: false } },
          { properties: { operation: { enum: ['result', 'cancel'] }, setupResultPath: false }, required: ['bundleId', 'kind', 'actionId', 'runtimeEpoch'] },
        ] },
      { properties: { kind: { const: 'wda' }, bundleId: false, runtimeUrl: false, iosHost: false, iosPort: false, setupResultPath: false },
        required: ['kind', 'wdaRunnerBundleId'], anyOf: [
          { properties: { operation: { enum: ['status', 'reconcile'] }, actionId: false, runtimeEpoch: false } },
          { properties: { operation: { enum: ['result', 'cancel'] } }, required: ['actionId', 'runtimeEpoch'] },
        ] },
    ] };
  if (command === 'uia-runtime') return { type: 'object', additionalProperties: false,
    properties: { operation: { enum: ['status', 'start', 'stop'] }, serial: { type: 'string', minLength: 1 },
      adb: { type: 'string', minLength: 1 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } }, required: ['operation', 'serial'] };
  if (isolatedByName.has(command)) return executionCommandSchema(command, Object.keys(scriptPermissions));
  const common = isolatedByName.has(command) || workflowCommands.has(command) || permissionCommands.has(command) ? [] : definition.domain === 'ios' ? iosCommon
    : definition.domain === 'web' ? [] : androidCommon;
  const names = new Set([...definition.options, ...common, ...(isolatedByName.has(command) || workflowCommands.has(command) ? [] : executionOptions), ...(extraOptions[command] || [])]);
  if (historyCommands.has(command)) ['history', 'factCursor', 'cursor'].forEach(n => names.add(n));
  if (captureCommands.has(command)) ['view', 'runtimeEpoch', 'afterActionId', 'mobileFactId', 'targetKey', 'timeoutMs'].forEach(n => names.add(n));
  const properties = {};
  for (const name of names) {
    if (!optionTypes[name]) throw new Error(`Missing command option schema: ${command}.${name}`);
    properties[name] = optionTypes[name];
  }
  if (['ios-h5-click', 'ios-h5-input', 'ios-h5-scroll'].includes(command)) {
    const h5 = require('./shared-kernel/ios-h5-target');
    properties.selector = h5.selectorSchema;
    properties.expectedTarget = h5.expectedTargetSchema;
    if (command === 'ios-h5-input') properties.text = { type: 'string', maxLength: 16384 };
  }
  if (['h5-click', 'h5-input', 'h5-scroll', 'h5-wait', 'h5-eval'].includes(command)) {
    const h5 = require('./shared-kernel/android-h5-target');
    if (properties.selector) properties.selector = h5.selectorSchema;
    if (properties.expectedTarget) properties.expectedTarget = h5.expectedTargetSchema;
    if (properties.expectedPage) properties.expectedPage = h5.pageSchema;
    if (command === 'h5-input') properties.text = { type: 'string', maxLength: 16384 };
  }
  if (['flutter-h5-click', 'flutter-h5-input', 'flutter-h5-scroll', 'flutter-h5-wait', 'flutter-h5-eval'].includes(command)) {
    const h5 = require('./shared-kernel/flutter-h5-target');
    if (properties.selector) properties.selector = h5.selectorSchema;
    if (properties.expectedTarget) properties.expectedTarget = h5.expectedTargetSchema;
    if (properties.expectedPage) properties.expectedPage = h5.pageSchema;
    if (command === 'flutter-h5-input') properties.text = { type: 'string', maxLength: 16384 };
  }
  if (command === 'tap-text') properties.provider = { enum: ['auto', 'native', 'flutter', 'uia'], default: 'auto' };
  if (command === 'tap-uia-text') properties.exact = { type: 'boolean', enum: [true], default: true };
  if (command === 'tap-uia') properties.selector = require('./shared-kernel/uia-target').selectorSchema;
  if (command === 'tap-native' || command === 'input-text') properties.selector = nativeSelector;
  if (command === 'input-text') properties.text = { type: 'string', maxLength: 16384 };
  if (command === 'clear-app-data') properties.method = { enum: ['pm-clear', 'runtime'], default: 'pm-clear' };
  if (command === 'tree' || command === 'uia-tree') {
    properties.maxDepth = { type: 'integer', minimum: 0, maximum: 200 };
    properties.maxNodes = { type: 'integer', minimum: 1, maximum: 1000 };
  }
  if (command === 'flutter-action' || command === 'ios-flutter-action') properties.payload = flutterActionSchema();
  if (command === 'native-gesture') properties.payload = nativeGestureSchema();
  if (['tap-flutter', 'input-flutter-text', 'scroll-flutter', 'ios-tap-flutter', 'ios-input-flutter-text', 'ios-scroll-flutter'].includes(command)) properties.selector = flutterSelector;
  if (command === 'web-command') {
    const { name, arguments: args, ...common } = properties;
    return webCommandSchema(common);
  }
  const required = [...(requiredOptions[command] || [])];
  if (iosSdkCommands.has(command)) required.push('deviceId', 'bundleId');
  if (properties.port) properties.port.description = 'Host TCP forwarding port. The Android SDK endpoint is discovered from packageName.';
  if (command === 'remove-forward') required.push('serial', 'port');
  if (definition.targetApp && !required.includes('packageName')) required.push('packageName');
  if (isAndroidMutation(command)) required.push('serial');
  if (definition.targetKind === 'web-target') required.push('sessionId');
  if (command === 'wait-text') {
    properties.provider = { type: 'string', enum: ['auto', 'native', 'flutter', 'uia'], default: 'auto' };
    properties.timeoutMs = { ...properties.timeoutMs, default: 10000 };
    for (const name of ['requireText', 'absentText']) properties[name] = { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1 } };
  }
  const schema = { type: 'object', additionalProperties: false, properties, required };
  if (command === 'tap-uia') schema.oneOf = [
    { required: ['selector'], properties: { targetRef: false } },
    { required: ['targetRef'], properties: { selector: false } },
  ];
  if (command === 'h5-scroll' || command === 'flutter-h5-scroll') schema.oneOf = [
    { required: ['selector'], properties: { expectedPage: false, deltaX: false, deltaY: false } },
    { required: ['deltaX', 'deltaY'], properties: { selector: false, expectedTarget: false },
      not: { properties: { deltaX: { const: 0 }, deltaY: { const: 0 } } } },
  ];
  if (command === 'tap-flutter') schema.oneOf = [
    { required: ['selector'], not: { anyOf: [{ required: ['tapX'] }, { required: ['tapY'] }] } },
    { required: ['tapX', 'tapY'], not: { required: ['selector'] } },
  ];
  if (command === 'input-flutter-text' || command === 'input-text') schema.allOf = [
    { not: { required: ['selector'], anyOf: [{ required: ['tapX'] }, { required: ['tapY'] }] } },
  ];
  return schema;
}

function invalid(field, message, details) {
  return new CommandError('invalid_argument', message, { field, details });
}

function validateCommandArguments(command, args = {}) {
  const schema = commandSchema(command);
  validateValue(args, schema);
  const normalized = { ...args };
  const definition = commandByName.get(command);
  if (command === 'wait-text') require('./shared-kernel/text-wait').validateTextConditions(normalized);
  if (command === 'tap' && normalized.scope === 'app' && !normalized.packageName) throw new CommandError('target_required', 'App-scoped tap requires packageName.', { field: 'packageName' });
  if (['input-text', 'input-flutter-text', 'ios-input'].includes(command)
    && Object.hasOwn(normalized, 'tapX') !== Object.hasOwn(normalized, 'tapY')) {
    throw invalid('tapX', 'tapX and tapY must be supplied together, or both omitted.');
  }
  if (['web-wait'].includes(command)
    && Boolean(normalized.selector) === Boolean(normalized.targetText)) {
    throw invalid('selector', 'Supply exactly one of selector or targetText.');
  }
  if (isMutationCommand(command, normalized) && normalized.history === true) throw invalid('history', 'A mutation cannot be requested as a history read.');
  if (isAndroidMutation(command, normalized) && !normalized.serial) throw new CommandError('missing_argument', `${command}: serial is required for device mutation.`, { field: 'serial' });
  return normalized;
}

// CLI parsing is the only place that converts a textual number/boolean. MCP
// and programmatic calls always validate the original JSON types.
function parseCliOptions(command, options) {
  const schema = commandSchema(command);
  const parsed = { ...options };
  for (const [name, value] of Object.entries(options)) {
    const property = schema.properties[name];
    if (!property || typeof value !== 'string') continue;
    if (property.type === 'array' && ['category', 'extra'].includes(name)) {
      parsed[name] = [value];
    } else if (jsonCliValue(property)) {
      try { parsed[name] = JSON.parse(value); }
      catch { throw invalid(name, `${name} must be valid JSON matching its input schema.`); }
    } else if (property.type === 'integer' || property.type === 'number') {
      if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) throw invalid(name, `${name} must be a number.`);
      parsed[name] = Number(value);
    } else if (property.type === 'boolean' && (value === 'true' || value === 'false')) {
      parsed[name] = value === 'true';
    }
  }
  return parsed;
}

function jsonCliValue(schema) {
  return ['object', 'array'].includes(schema.type) || schema.contentMediaType === 'application/json'
    || [...(schema.anyOf || []), ...(schema.oneOf || [])].some(jsonCliValue);
}

module.exports = { commandDefinitions, isolatedCommandDefinitions, commandByName, isolatedByName,
  commandSchema, commandContract, scriptPermissions, scriptPermissionByCommand, validateCommandArguments, parseCliOptions, isMutationCommand, isAndroidMutation, executionTimeoutMs };
