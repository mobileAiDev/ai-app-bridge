# Known Issues

This file records issues found while using ai-app-bridge as a development loop
for real Android apps. Keep each item evidence-based and include the current
workaround when one exists.

Note: historical dependency examples in this file have been identity-scrubbed
to match the current public repository naming. They are retained as issue
evidence, not as release instructions. Use `README.md` and `docs/INTEGRATION.md`
for current dependency coordinates.

## Current triage snapshot, 2026-05-20

- Standard MCP stdio is working with desktop package `0.2.4`: `initialize`
  negotiated protocol `2025-06-18`, `ping` returned `{}`, `tools/list`
  exposed only `capabilities` and `run`, and `capabilities` advertised 52
  command entries.
- Real-device MCP `tools/call run` validation on OnePlus PKR110 passed core
  launch/status/tree/uia-tree/screenshot/logcat/capture checks for
  `android-architecture-samples`, `AntennaPod`, `Jetchat`, `NewPipe`, and
  `nowinandroid`. Serialized follow-up validation passed `platform_design`
  launch/status/flutter-nodes.
- Post-fix focused retest through global MCP `0.2.3` completed 35 rows. The 34
  positive rows passed. The single `ok=false` row was the expected negative
  check for `com.android.launcher`, which now returns
  `bridge_port_discovery_failed` instead of probing the default port.
- Remaining command retest found one MCP argument-forwarding defect in `0.2.3`;
  it is fixed in desktop MCP `0.2.4`. Local fixed retest passed
  `launch-native-test`, `tap-uia-text`, raw `flutter-action`,
  `input-flutter-text`, `scroll-flutter`, `forward`, `remove-forward`,
  re-forwarded `status`, and `smoke --skip-flutter-launch`.
- First-pass failures for DuckDuckGo and Flutter packages were not accepted as
  confirmed bridge bugs because that broad matrix changed foreground apps and
  stressed ADB while continuing to probe older targets. Re-run failing points
  serially before treating them as product defects.
- `appops-set` failed on PKR110 with Android shell permission
  `MANAGE_APP_OPS_MODES`; this is a platform/device permission limitation, not
  a bridge behavior bug.
- `permission-grant` and `permission-revoke` also failed on PKR110 because the
  Android shell user lacks `GRANT_RUNTIME_PERMISSIONS` and
  `REVOKE_RUNTIME_PERMISSIONS`; `permission-dialog` itself works when a runtime
  permission dialog is visible.
- Confirmed product bugs from this pass are explicit package port discovery
  falling back to the default port, fixed in desktop CLI/MCP `0.2.3`, and MCP
  compact `run` omitting advertised arguments, fixed in desktop MCP `0.2.4`.

## MCP `input_text hideKeyboard=true` can report hidden while IME remains visible

- Status: open
- Found while validating `C:\project\reader` on OnePlus PKR110, Android SDK 36,
  with desktop MCP server `ai-app-bridge` 0.1.25 and Android runtime 0.1.9.
- Evidence: MCP `input_text` successfully set Chinese text into
  `com.example.reader:id/search_et_input`, returned `keyboard.ok=true`,
  `action=hide-keyboard`, `dismissed=false`, and
  `reason=keyboard_not_visible`; the immediately captured screenshot still
  showed the soft keyboard covering the bottom half of the screen.
- Impact: an agent can believe the screen is unobstructed and tap a lower app
  control, while the tap is actually intercepted by the IME. It also makes
  "enter text then tap search" flows brittle when the search action is not in
  the IME.
- Workaround: after native `input_text`, explicitly verify keyboard state or
  tap a top-screen app action that is not covered by the IME. For search fields,
  prefer the visible in-app search button when it remains above the keyboard.
- 2026-05-20 retest: not reproduced on OnePlus PKR110 with the native sample.
  After focusing `ai_app_native_test_input`, `keyboard-state` reported visible;
  `input-text --hide-keyboard` returned `dismissed=true`, and the next
  `keyboard-state` reported hidden. Keep this open for the original Reader/IME
  surface until that exact app path is retested.

## MCP `input_text` can target a stale package unless `packageName` is explicit

- Status: fixed in desktop MCP `0.2.2`
- Found while validating `C:\project\reader` on OnePlus PKR110, Android SDK 36,
  with desktop MCP server `ai-app-bridge` 0.1.25 and Android runtime 0.1.9.
- Evidence: while `com.example.reader` was foreground, MCP `status` and `tree`
  with `packageName=com.example.reader` worked. A subsequent MCP `input_text`
  without an explicit `packageName` attempted `/v1/action/input-text` against
  stale package `io.github.mobileaidev.aiappbridge.sample` on port `18082` and
  returned `bridge_not_ready`. Retrying the same `input_text` with
  `packageName=com.example.reader` succeeded through the native-view bridge and set
  Chinese text into `com.example.reader:id/search_et_input`.
- Impact: multi-app agent sessions can silently route text input to an old
  bridge context even when the current activity belongs to the intended app.
- Workaround: pass `packageName` on every MCP `input_text` call in sessions
  where more than one bridge-enabled app has been launched.
- Fix: MCP `input_text` now requires `packageName` in its tool schema and also
  rejects direct `tools/call` requests that omit it, instead of letting the CLI
  fall back to the sample package default.
- 2026-05-20 hardening: MCP target-app commands now reject calls without
  `packageName` or explicit `port` before spawning the CLI, so compact `run`
  and hidden legacy direct tools cannot route through the CLI sample default.
- Verification: MCP `run status` without `packageName` returned a tool error
  before ADB/HTTP. MCP `run status` with
  `packageName=com.example.android.architecture.blueprints.main` on OnePlus
  PKR110 returned `ok=true`, bridge `0.1.7`, and app package
  `com.example.android.architecture.blueprints.main`.

## Explicit `--package-name` port discovery could fall back to the default port

- Status: fixed in desktop CLI/MCP `0.2.3`
- Found while running the 2026-05-20 standard MCP TestProject matrix on OnePlus
  PKR110.
- Evidence:
  - `status --package-name com.android.launcher` could not read
    `files/ai_app_bridge_port.json` through `run-as`, but still attempted
    `http://127.0.0.1:18080/v1/status` with
    `devicePortSource=default-port`.
  - In a multi-app validation run, that same fallback shape appeared on
    `network`, `state`, and `events` after the target package could not be
    resolved cleanly, which can make an agent query whichever bridged app owns
    the default port.
- Impact: even when an MCP client correctly supplied `packageName`, the desktop
  CLI could still contact the default port after package port discovery failed.
  If another bridged app or sample owned that port, the agent could observe the
  wrong app.
- Fix: when `--package-name` is explicit, port discovery failure is now a hard
  `bridge_port_discovery_failed` result. The historical default-port fallback
  remains only for the CLI's implicit default sample package path or when the
  user explicitly supplies `--port`.
- Verification:
  - Unit test
    `explicit package port discovery failure does not fall back to default
    sample port` passed.
  - Real-device negative check after the fix:
    `status --package-name com.android.launcher` returned
    `bridge_port_discovery_failed` with `devicePortSource=package-port-file`
    and no HTTP request to a discovered app bridge.
  - Real-device positive checks still passed when a TestProject app had a valid
    port file: `Jetchat` reported bridge `0.1.8` on port `18081`, and
    `platform_design` reported bridge `0.1.8` on port `18080` plus Flutter
    operable nodes.
  - Global MCP `0.2.3` focused retest covered `AntennaPod` launch/status/tree/
    uia-tree/wait/tap/input/screenshot/log/logs/network/state/events,
    `platform_design` Flutter tree/nodes/tap/wait/scroll,
    `flutter_inappwebview` Flutter-H5 and WebView DevTools operations,
    DuckDuckGo permission-state, and Jetchat reinstall. All positive rows
    passed; the only `ok=false` result was the expected
    `bridge_port_discovery_failed` negative check.

## Compact MCP `run` did not forward some advertised command options

- Status: fixed in desktop MCP `0.2.4`
- Found while running the 2026-05-20 remaining-command standard MCP matrix on
  OnePlus PKR110.
- Evidence:
  - MCP `tools/call run` with `command=flutter-action` and a `payload` argument
    returned `payload is required`, even though `capabilities` advertised
    `payload`.
  - MCP `scroll-flutter` ignored advertised `maxSwipes`/`delta` arguments.
  - MCP `smoke` advertised `skipFlutterLaunch`, but the compact `run` path did
    not forward it to the CLI.
- Impact: an agent could correctly discover a capability through
  `capabilities`, then fail when invoking it through the compact `run` tool
  because the MCP server silently omitted the option before spawning the CLI.
- Fix: the compact MCP `run` argument builder now forwards advertised advanced
  options including Flutter payload/scroll args, compact tree filters, wait-text
  conditions, and `skipFlutterLaunch`.
- Verification:
  - Unit test
    `MCP run forwards advertised compact options to the CLI argument list`
    passed.
  - Local fixed MCP retest passed raw `flutter-action openHarness`,
    `input-flutter-text`, `scroll-flutter`, `forward`, `remove-forward`,
    re-forwarded `status`, and `smoke --skip-flutter-launch`.
  - Global MCP `0.2.4` retest passed `flutter-action` with payload,
    `input-flutter-text`, `scroll-flutter maxSwipes`, and
    `smoke --skip-flutter-launch`.

## MCP has no generic shell command

- Status: app-data reset fixed in desktop CLI/MCP `0.2.6`; generic shell
  remains intentionally unsupported
- Found while validating `C:\project\reader` on OnePlus PKR110 through the
  standard JSON-RPC `tools/call` path.
- Evidence:
  - `capabilities` advertised app launch/install, UI, logcat, network, state,
    events, permissions, appops, WebView, Flutter, forward, remove-forward, and
    batch commands, but no generic `shell` command.
  - Attempting the local JSON-RPC helper shape
    `node build\tmp\reader-mcp-jsonrpc.mjs shell pm clear com.ldp.reader`
    returned `unknown command: shell`.
  - Earlier versions had no advertised command equivalent to Android app-data
    reset such as `pm clear <package>`.
- Fix: desktop CLI/MCP `0.2.6` adds `clear-app-data`. With Android runtime
  `0.2.1+`, it calls the in-app `/v1/app/clear-data` endpoint so the app clears
  its own SharedPreferences, databases, caches, files, app WebView data, and
  bridge capture buffers without needing `CLEAR_APP_USER_DATA`. Older runtimes
  can still fall back to `adb shell pm clear <package>` where the device allows
  it. The command requires an explicit `packageName` in both CLI and MCP mode so
  it cannot clear the default sample package by accident.
- Boundary: this does not add a generic shell tool. Validation flows that need
  app-data reset should use `clear-app-data`; arbitrary shell remains outside
  the public MCP command surface.

## MCP `logcat --app-pid` returns bare `ok` for empty app-filtered output

- Status: fixed in desktop MCP/CLI `0.2.1`
- Found while validating `C:\project\reader` on OnePlus PKR110, Android SDK 36,
  with desktop MCP server `ai-app-bridge` 0.1.25 and Android runtime 0.1.9.
- Evidence: MCP `logcat` without `appPid` returned normal log lines, proving
  logcat access worked. MCP `logcat` with `appPid=true` and no matching app
  lines returned a text payload containing only `ok`.
- Impact: automation cannot reliably distinguish "command succeeded with an
  empty app-pid log result" from an unstructured success marker unless it has
  extra context.
- Workaround: for crash checks, run a broader `logcat` query with explicit grep
  filters such as `AndroidRuntime` or `FATAL EXCEPTION`, or treat bare `ok`
  from app-pid filtering as an empty-result sentinel until the MCP output shape
  is clarified.
- Fix: CLI `logcat --app-pid` no longer falls back to unfiltered logcat when
  the app PID cannot be resolved, and MCP now returns
  `logcat: no matching lines for current app pid` instead of bare `ok` for an
  empty app-pid result.

## Android 16 ADB text input cannot enter Chinese

- Status: fixed in Android runtime `0.1.9` and desktop CLI `0.1.25`
- Found while operating an Android 16 device from an agent loop.
- Evidence: `adb shell input text` cannot reliably inject Chinese/Unicode text
  on this device, so agents that tried generic ADB text input failed and then
  retried the same path.
- Impact: search boxes and form fields requiring Chinese text could not be
  filled reliably unless the agent used a WebView or Flutter-specific bridge
  action.
- Fix: native Android input now has `/v1/action/input-text`, and CLI/MCP
  `input-text`/`input_text` use the bridge endpoint first. Non-ASCII text no
  longer falls back to ADB when the bridge endpoint is missing or fails.
- Workaround for older app builds: upgrade the target app to
  `ai-app-bridge-android:0.1.9+`, pass `--package-name`, or use
  `input_flutter_text` / `h5-input` / `flutter-h5-input` for Flutter and H5
  fields.

## Default screenshot artifacts could dirty consuming repositories

- Status: fixed in desktop CLI `0.1.23`
- Found while using ai-app-bridge from consuming app repository roots.
- Evidence: after desktop CLI `0.1.22` fixed stale screenshot filenames,
  generated `screenshot` and `smoke` PNGs defaulted to
  `<cwd>/ai_app_bridge_artifacts`. When `<cwd>` was an app repository root, this
  created a new top-level directory that could show up as untracked git noise.
- Impact: bridge-generated evidence files are temporary runtime artifacts, but
  the default path made users clean their repository manually.
- Fix: default generated artifacts now live under
  `<cwd>/build/ai_app_bridge_artifacts`. Explicit `--out-file` and
  `--artifact-dir` behavior is unchanged.
- Verification: desktop CLI `npm run check` passed 29 tests, including coverage
  for the default path and explicit override behavior.

## `wait-text` could match offstage Flutter widget dump text

- Status: fixed in desktop CLI `0.1.20`
- Found while validating:
  `D:\TestProject\flutter-samples\platform_design`
- Evidence:
  - After `tap-text "Sad Word"` opened the song detail page,
    `tap-text "Odd Bell"` correctly failed because `Odd Bell` was not in the
    Android tree, UIAutomator tree, or current Flutter operable tree.
  - The same screen returned `absent_text_present` for
    `wait-text "Sad Word" --absent-text "Odd Bell"` because `wait-text`
    searched the raw Flutter `widgetDump.text`, which still contained offstage
    route/list text.
  - `/v1/status` compact output showed current operable nodes contained
    `Sad Word` and `You might also like:`, while `Odd Bell` was absent.
- Impact: AI loops could reject a correct current-screen state or pass a stale
  target check because `wait-text` treated debug-only Flutter dump text as
  current visible text.
- Fix: `wait-text` no longer searches raw Flutter widget dumps. Its status
  search text is now built from app/activity metadata, current Flutter operable
  nodes, and H5 DOM/control text.
- Verification: desktop CLI `npm run check` passed 26 tests, including a
  regression where `widgetDump.text` contains `Odd Bell` but the current
  operable tree only contains `Sad Word`. On device `b46093e6`,
  `wait-text "Sad Word" --absent-text "Odd Bell" --require-activity
  MainActivity` passed on the detail page, while `tap-text "Odd Bell"` still
  failed.

## `tap-text` could not operate Flutter-only controls

- Status: fixed in desktop CLI `0.1.19`
- Found while validating:
  `D:\TestProject\flutter_inappwebview\flutter_inappwebview_android\example`
- Evidence:
  - `wait-text "Run AI Bridge Probe" --require-text "AI Bridge Probe Banner"`
    passed because the text was present in the Flutter operable snapshot.
  - `tree --compact --text-filter "Run AI"` and
    `uia-tree --compact --text-filter "Run AI"` both returned no nodes.
  - `flutter-tree` showed an operable `Text` node for
    `Run AI Bridge Probe` with tap bounds and viewport
    `devicePixelRatio=3.5`, but `tap-text "Run AI Bridge Probe"` failed with
    `text not found in Android bridge tree or UIAutomator tree`.
- Impact: AI loops using the generic `tap-text` command could verify Flutter
  text with `wait-text` but then fail to operate the same current-screen
  Flutter control unless they knew to call a Flutter-specific action.
- Fix: `tap-text` now falls back to the Flutter operable tree when Android
  bridge tree and UIAutomator do not contain the target. It converts Flutter
  logical bounds to physical ADB coordinates and keeps the keyboard-risk guard
  active for Flutter fallback taps.
- Verification: desktop CLI `npm run check` passed 25 tests, including a
  regression for Flutter operable coordinate conversion. On device
  `b46093e6`, `tap-text "Run AI Bridge Probe"` returned
  `source="flutter-operable-tree"`, tapped physical coordinates `404,812`, and
  `wait-text "Flutter probe run #2" --require-text "phase=h5_loaded"` passed.

## Flutter capture strings with spaces can be truncated through MethodChannel

- Status: fixed in Flutter package `0.1.9`
- Found while validating:
  `D:\TestProject\flutter_inappwebview\flutter_inappwebview_android\example`
- Evidence:
  - The example called `recordState(namespace: "ai_bridge_probe",
    key: "status_text", value: "Flutter probe run #1")`.
  - `/v1/logs` preserved the full log data string
    `Flutter probe run #1`.
  - `/v1/state` returned `ai_bridge_probe.status_text: "Flutter"` when the
    example used published `ai_app_bridge_flutter 0.1.8`.
- Impact: AI loops that rely on Flutter `recordState` could see a false
  current state whenever the value was a plain string containing spaces.
- Cause: the Flutter plugin Android shim passed `payload.opt("value").toString()`
  into Android runtime methods that expect a JSON value string. Android's
  `JSONTokener` accepted only the first token from the unquoted string.
- Fix: the Flutter plugin now serializes MethodChannel capture payload values
  as valid JSON. String values are quoted with `JSONObject.quote`, while
  object, array, number, and boolean values keep their JSON representation.
- Verification: rebuilt and reinstalled the example with local
  `ai_app_bridge_flutter 0.1.9`; after tapping `Run AI Bridge Probe`,
  `/v1/state` returned
  `ai_bridge_probe.status_text: "Flutter probe run #1"`. After publishing,
  the example was switched back to hosted `ai_app_bridge_flutter: ^0.1.9`;
  `flutter pub get`, `flutter analyze --no-pub`,
  `flutter build apk --debug --no-pub`, `install-apk`, and the same state
  assertion all passed.

## CLI status can dump extremely large Flutter widget trees

- Status: fixed in desktop CLI `0.1.18`
- Found while validating: `D:\TestProject\flutter-samples\platform_design`
- Evidence:
  - `status --package-name dev.flutter.platform_design` returned a full
    Flutter `widgetInspector` and `widgetDump.text`.
  - One run produced roughly 2,300 output lines and more than 100k tool tokens
    from a status command.
- Impact: `status` became too noisy for CLI and MCP loops, wasting context and
  hiding the actual app/debug metadata.
- Fix: `status` now compacts Flutter layout by default, keeps bounded operable
  node samples and widget dump length metadata, and exposes the raw response
  only with `--full`.
- Verification: desktop CLI `npm run check` passed 24 tests, including
  `status compacts large Flutter layout dumps by default`; device `status`
  against `platform_design` returned compact Flutter layout metadata without
  the full dump text.

## Flutter runtime can tap stale widgets from a previous route

- Status: fixed in Flutter package `0.1.8`
- Found while validating: `D:\TestProject\flutter-samples\platform_design`
- Evidence:
  - On the song list, `tap-flutter-text "Forest Nose"` opened its detail page.
  - Before the fix, tapping another list item that belonged to the previous
    route could return `ok=true` while the app stayed on the first detail page.
  - The Flutter snapshot still included off-route list text nodes after
    navigation.
- Impact: an AI loop could believe it operated the current screen when it had
  actually matched a stale/off-route Flutter element.
- Fix: Flutter target extraction and runtime actions now require a target to
  have usable bounds, a center inside the viewport, no obvious non-interactive
  ancestors, and hit-test reachability at the tap point.
- Verification: rebuilt and reinstalled `platform_design` with local
  `ai_app_bridge_flutter 0.1.8`. After opening `Script Coin`, the compact
  status contained only current detail targets, and
  `tap-flutter-text "Tool Spot"` returned `text_not_found` instead of a
  false successful tap.

## Android runtime 0.1.4 cannot be consumed by minSdk 21 apps

- Status: fixed and remotely verified for `0.1.5`
- Found while validating: `D:\TestProject\android-architecture-samples`
- Bridge version: `0.1.4`
- Evidence:
  - The app declares `minSdk=21`.
  - `:app:processDebugMainManifest` failed with
    `uses-sdk:minSdkVersion 21 cannot be smaller than version 23 declared in library`.
- Impact: common Android apps that still support API 21 cannot consume the
  released `0.1.4` runtime dependency.
- Fix: lowered Android runtime SDK and Flutter wrapper Android `minSdk` from 23
  to 21.
- Verification: rebuilt and installed `android-architecture-samples` first with
  Maven Local `0.1.5`, then again after removing `mavenLocal()` and forcing
  JitPack remote `0.1.5`; `/v1/status` reported bridge `0.1.5`, and
  `/v1/view/tree` worked.

## Flutter pub package 0.1.4 still requires a manual Android runtime dependency

- Status: fixed and remotely verified in Flutter `0.1.5` plus Android runtime
  `0.1.5`
- Found while validating: `D:\TestProject\flutter-samples\platform_design`
- Bridge version: Flutter `0.1.4`, Android runtime `0.1.4`
- Evidence:
  - Adding only `ai_app_bridge_flutter` did not start an Android bridge server.
  - Adding `debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.1.4")`
    to the host Android app made `/v1/status` and `/v1/view/tree` work.
- Impact: Flutter users must know an Android implementation detail, and the
  README can easily drift from the actual pub package behavior.
- Fix: the Flutter plugin Android module now declares
  `debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.1.5")`.
  Kotlin calls stay reflection-based, so release variants can compile without
  the debug runtime class.
- Verification: `platform_design` removed the host Android app's manual runtime
  dependency and used the local Flutter plugin `0.1.5`; debug runtime classpath
  included `ai-app-bridge-android:0.1.5`, release runtime classpath did not.
  After removing `mavenLocal()`, the app rebuilt against JitPack remote
  Android runtime `0.1.5`, installed, and reported bridge `0.1.5` with Flutter
  widget snapshot and operable node data.
- Verification after pub.dev release: `platform_design` removed the local path
  override and resolved `ai_app_bridge_flutter: ^0.1.5` from pub.dev. The APK
  built, installed, and reported bridge `0.1.5`, Flutter app
  `platform_design`, `operableCount=6`, first widget `MyAdaptingApp`, and
  native child `FlutterView`.

## Flutter initialization before binding prevents snapshot delivery

- Status: documentation fixed for `0.1.5`
- Found while validating: `D:\TestProject\flutter-samples\platform_design`
- Evidence:
  - The native Android bridge server started and `/v1/status` worked.
  - `status.flutter` stayed empty until `WidgetsFlutterBinding.ensureInitialized()`
    was called before `AiAppBridge.instance.initialize(...)`.
- Impact: Flutter apps can appear connected at the native layer while widget
  snapshot data is missing.
- Fix: all Flutter quick-start snippets now call
  `WidgetsFlutterBinding.ensureInitialized()` before bridge initialization.

## Flutter package SDK constraint is narrower than the implementation requires

- Status: fixed and published in Flutter `0.1.5`
- Found while reviewing package metadata during Flutter sample validation
- Bridge version: Flutter `0.1.4`
- Evidence: `pubspec.yaml` required Dart `^3.9.2`, while the integration docs
  describe Flutter 3.10+ / Dart 3.0+ as the intended compatibility floor.
- Impact: Flutter 3.x projects on older stable channels can be rejected by
  `flutter pub get` before any real runtime compatibility check.
- Fix: changed the package constraint to Dart `>=3.0.0 <4.0.0` and Flutter
  `>=3.10.0`.

## Bridge port is not always 18080

- Status: documented
- Found while validating: `Jetchat`, `platform_design`, and
  `android-architecture-samples`
- Evidence: the three running apps reported bridge ports `18081`, `18082`, and
  `18083`.
- Impact: tools or docs that assume `127.0.0.1:18080` can report false
  negatives when another bridged app already owns that port.
- Current behavior: the runtime tries ports from 18080 upward, and the desktop
  CLI reads the per-app port file through ADB.
- Desired rule: user-facing docs should describe `18080` as the first attempted
  port, not a fixed endpoint.

## ADB installs can block on one or more device-side confirmation screens

- Status: desktop CLI support added; pending broad ROM/device verification
- Found while validating: real Android app installs on ColorOS/OPPO-family
  phones and other managed consumer devices.
- Evidence:
  - `adb install` can remain running while the phone displays an installer,
    security scan, unknown-source, or risk confirmation page.
  - Confirmation flows may have multiple steps, and button text varies by ROM,
    language, and risk level, such as `继续安装`, `安装`, `允许`, `确定`,
    `仍然安装`, `完成`, `打开`, or equivalent English labels.
  - A successful-looking first confirmation is not enough. One observed manual
    install flow required tapping `允许` first, then tapping a separate `完成`
    screen before the device returned to a usable app state.
  - In one observed ColorOS flow, UIAutomator reported package
    `com.oplus.appdetail`, text `检测结果：涉及敏感权限`, and a clickable
    `继续安装` button. Tapping that button allowed the waiting `adb install`
    process to return `Success`.
- Impact: an AI run can incorrectly classify installation as hung or timed out,
  even though the device is waiting for a human confirmation. This breaks the
  build-install-run verification loop before the app can be launched.
- Desired behavior: the desktop loop should watch installer state while an
  install command is pending, repeatedly read the active window through
  UIAutomator, click known positive confirmation buttons, and continue after
  `adb install` exits because some ROMs show a final `完成`/`打开` screen or
  another confirmation step. The loop must treat install completion and
  installer dismissal as two separate checks: the APK can be installed while
  the UI is still waiting on `完成` or `打开`. The loop should stop only after
  the app is installed and the installer UI has been dismissed or a real
  blocker is detected.
- Current workaround: manually run `uiautomator dump`, inspect the active
  installer window, and tap the positive button coordinates with
  `adb shell input tap`.
- Added capability: `install-apk` now runs `adb install`, polls the current
  installer surface with UIAutomator while the install process is pending,
  taps known positive installer buttons such as `继续安装`, `仍然安装`, `安装`,
  `允许`, `确定`, `完成`, and `打开`, then keeps polling briefly after
  `adb install` exits because some ROMs leave a final installer page visible.
  When `--package-name` is supplied, the command probes `pm path` before and
  after install so the result can distinguish `new_install`, `reinstall`, or
  `unknown_without_package_name`.
- Remaining risk: the assistant intentionally handles confirmation buttons,
  not arbitrary security-setting pages or vendor account policy pages. A ROM
  that requires toggling an unknown-source switch, logging in, or accepting a
  device-owner policy should still return a blocker rather than silently
  changing device policy.
- Regression note: OPPO/ColorOS can leave an app-market snack bar or downloader
  page in the foreground after install. That surface must not be treated as an
  installer finish screen even when it contains `打开` / `Open`; otherwise the
  helper can trigger an unrelated market action instead of ending the install
  loop.
- Guardrail: button text alone is not a safe action contract. The installer
  helper now treats system installer / risk-confirmation surfaces as the trusted
  domain, checks whether the target package is already installed, and stops
  clicking on installer finish, recommendation, or market surfaces. Generic
  `安装` / `Install` buttons are not clicked on finish or market pages because
  they can belong to ads or promoted apps.

## Soft keyboard can obscure lower-screen targets after input

- Status: desktop CLI guard added; pending device validation across IMEs
- Found while using: agent-driven app flows that tap an input field, type text,
  then repeatedly attempt to tap a lower-screen button while the soft keyboard
  still covers that area.
- Evidence:
  - After `input-text`, the IME can stay visible and reduce the usable app
    viewport.
  - Bridge View tree coordinates may still describe the app layout behind the
    keyboard, so a plain coordinate tap can hit the IME surface instead of the
    intended app node.
  - This causes retry loops that report the target as blocked or untappable,
    even though the app state is otherwise correct.
- Impact: AI runs can stall after form input, especially on login, search, and
  checkout screens with primary actions near the bottom.
- Desired behavior: keyboard visibility must be treated as a device state, not
  as an app-tree failure. Before tapping a lower-screen app node, the desktop
  loop should check whether the IME is visible, dismiss it when the target is
  in the keyboard risk area, refresh the tree, and then tap the refreshed
  coordinate. Direct text input should also offer an explicit "type then hide
  keyboard" mode.
- Added capability: `keyboard-state` reads `dumpsys input_method`,
  `hide-keyboard` dismisses the IME with keyboard-safe key events, `input-text
  --hide-keyboard` types and then hides the keyboard, and `tap-text` now
  automatically hides the keyboard before tapping app nodes in the lower
  viewport unless `--no-auto-hide-keyboard` is supplied. If the target is in
  the keyboard risk area and the IME cannot be dismissed, `tap-text` returns
  `keyboard_obscures_target` instead of pretending the tap succeeded.
- Remaining risk: `dumpsys input_method` markers vary by Android release and
  vendor IME. If a device reports stale or incomplete IME visibility, the guard
  can miss the obstruction; screenshots/UIAutomator hierarchy should be used
  as the next fallback signal for those devices.

## Concurrent UIAutomator dumps can collide on the device

- Status: fixed in desktop CLI `0.1.17`
- Found while validating: `D:\TestProject\nowinandroid` on OnePlus PKR110 /
  Android SDK 36.
- Evidence:
  - Running `wait-text` and multiple `uia-tree` commands in parallel caused
    device logcat to report
    `UiAutomationService ... already registered!`.
  - The target app stayed alive; the failure came from Android's shell
    `uiautomator dump` process trying to register more than one UiAutomation
    service at the same time.
- Impact: MCP or CLI users can naturally issue parallel observation requests,
  and the bridge may convert a harmless concurrent read into noisy platform
  crashes or transient UI-tree failures.
- Fix: desktop CLI now wraps every `uiautomator dump` call in a host-side,
  per-device cross-process file lock. Parallel commands queue on the host
  before touching the device, then execute the dump/read sequence one at a
  time.
- Verification:
  - `npm run check` passed with 23 tests, including a lock serialization
    regression.
  - Re-running three parallel UIAutomator-backed commands against Now in
    Android completed successfully.
  - `adb logcat -d -s AndroidRuntime` after the fixed run contained no
    `UiAutomationService`, `already registered`, or `FATAL EXCEPTION` entries.

## OkHttp auto capture can be skipped when app package shares the bridge prefix

- Status: fixed in Android Gradle plugin `0.1.6`
- Found while validating: `examples/android-native-sample`
- Evidence:
  - The sample's `Run OkHttp Auto Capture` button executed successfully and
    changed the page status to `OkHttp auto capture: HTTP 200`.
  - `/v1/network` still had no `source=okhttp-auto` record.
  - `javap` on the transformed sample class showed no call to
    `AiAppOkHttpAutoCapture.installBuilder(...)` before
    `OkHttpClient.Builder.build()`.
  - The plugin excluded every class whose package started with
    `io.github.mobileaidev.aiappbridge.`, which also excluded the sample app
    package, not only bridge internals.
- Impact: any consumer app whose package name reuses the bridge prefix can lose
  OkHttp auto capture while manual SDK network recording still works.
- Fix: the instrumentation exclusion now targets only bridge runtime/plugin
  internals (`io.github.mobileaidev.aiappbridge.android.*` and
  `io.github.mobileaidev.aiappbridge.gradle.*`). After rebuilding, `javap`
  showed `installBuilder` injected before `Builder.build()`, and the sample
  produced `source=okhttp-auto` GET and POST network records on device.

## WebView H5 traffic is not captured by native OkHttp instrumentation

- Status: fixed in desktop CLI `0.1.12` and Android runtime `0.1.7` for
  debuggable Android WebViews with WebView debugging enabled. JSBridge callback
  payload correlation is still a separate future capability.
- Found while diagnosing: a hybrid Android app where a native login opens an H5
  inventory page through WebView.
- Evidence:
  - Native login APIs were captured by the bridge network endpoint because they
    went through the app's OkHttp stack.
  - After entering the WebView inventory page, the bridge captured the H5 SDK
    script download, but it did not expose H5 page XHR/fetch requests,
    JavaScript console messages, or the exact return values passed through the
    native JSBridge callbacks.
  - The suspected failure surface was an H5-rendered `登录失败` message, so the
    missing observability sits exactly at the boundary that needs diagnosis.
- Impact: an AI run can prove that native login succeeded while still being
  blind to the H5 page's own auth requests and JSBridge token/header exchange.
  This can hide first-entry WebView bugs behind a misleading "native side looks
  fine" result.
- Fix: the Android runtime enables `WebView.setWebContentsDebuggingEnabled(true)`
  only for debuggable apps. The desktop CLI can locate
  `webview_devtools_remote_*` from `/proc/net/unix`, match it to the target
  package pid, forward it through ADB, attach by Chrome DevTools Protocol, and
  expose `webview-pages`, `webview-network`, and `webview-console` commands.
- Verification: the native sample on device `b46093e6` exposed
  `webview_devtools_remote_15747`; `webview-pages` listed the `Native H5 Test`
  CDP page; `webview-network` captured a WebView `fetch` request to
  `/v1/status?from=manual-webview-cdp-2` with method `GET`, HTTP status `200`
  from `Network.responseReceivedExtraInfo`, and the expected CORS failure log;
  `webview-console` captured `ai-bridge-webview-console-standalone`.
- Limitation: release builds that do not enable WebView debugging cannot be
  attached through normal ADB/CDP. CORS-blocked fetches can still expose status
  and headers through CDP extra-info events even when page JavaScript receives
  `TypeError: Failed to fetch`.

## Android PopupWindow is not included in `/v1/view/tree`

- Status: fixed in `0.1.3`
- Found while validating: `C:\project\reader`, home overflow menu
- Bridge version: `0.1.2`; fix version: `0.1.3`
- Evidence:
  - The overflow menu was visible in a device screenshot.
  - `/v1/view/tree` still returned only the Activity decor tree and did not
    include menu rows such as login, sync, scan, feedback, or settings.
  - `/v1/action/tap` on a visible menu row fell through to the underlying
    bookshelf item and opened `ReadActivity`.
- Likely cause: `/v1/action/tap` dispatches through the current Activity
  `decorView`, while PopupWindow owns a separate window root.
- Fix: `/v1/view/tree` now reports a `windows` array collected from Android
  window roots when reflection is available, and `/v1/action/tap` dispatches
  through the topmost root that contains the requested screen coordinates.
- Verified on `C:\project\reader` after installing the `0.1.3` debug build:
  the home overflow menu appeared as `type=popup`, and tapping the first row
  returned `windowType=popup` before navigating to `LoginActivity`.
- Remaining risk: Android hidden-API restrictions may block root reflection on
  some OS/device builds. Keep the explicit `root` field as the Activity decor
  compatibility path.

## Hidden child views can appear as visible in `/v1/view/tree`

- Status: fixed in `0.1.3`
- Found while validating: `C:\project\reader`, login page
- Bridge version: `0.1.2`; fix version: `0.1.3`
- Evidence:
  - On the logged-in login page, the not-login container was hidden.
  - `/v1/view/tree` still returned text from that hidden branch, for example
    the login title, with `visible=true` but zero-size bounds.
- Impact: text-based assertions can pass on content that is not actually
  visible to the user.
- Fix: each node now exposes `localVisible`, `effectiveVisible`, and keeps
  `visible` mapped to effective user-visible state. Zero-size, transparent, or
  hidden-ancestor nodes are marked not effectively visible.

## Network capture redaction does not cover query/body payloads

- Status: fixed in `0.1.3`
- Found while validating: `C:\project\reader`, login and bookshelf sync flow
- Bridge version: `0.1.2`; fix version: `0.1.3`
- Evidence:
  - `/v1/network` captures request URL, request body, and response body.
  - Login/sync requests can include phone numbers or mobile tokens in query or
    body payloads.
- Impact: test logs and exported bridge responses can contain user-sensitive
  data.
- Fix: network capture now redacts URL query values, JSON body fields, form
  fields, and header fields whose keys match auth/token/session/password/phone
  or verification-code style names. Captured network events include
  `redacted=true`.
- Remaining risk: free-form text bodies are only redacted when they are JSON or
  key-value form payloads. Do not treat bridge output as production-grade DLP.

## Launcher ambiguity with debug-only launcher activities

- Status: fixed in desktop CLI/MCP `0.2.1`
- Found while validating: `C:\project\reader`
- Bridge version: `0.1.2`
- Evidence:
  - Package-level launcher commands can enter LeakCanary's debug launcher
    instead of the app splash/main Activity when debug dependencies add their own
    launcher entry.
- Workaround: launch the app with an explicit component, such as
  `com.example.reader/.ui.activity.SplashActivity`.
- Fix: `launch-app` queries LAUNCHER Activity candidates and returns
  `launcher_ambiguous` with the candidate list when more than one entry exists.
  `launch-activity`, `launch-app --activity`, and `launch-app --component`
  provide explicit component startup with optional string extras.
- Verification: on OnePlus PKR110, `launch-app --package-name
  io.github.mobileaidev.aiappbridge.sample` reported the single candidate
  `io.github.mobileaidev.aiappbridge.sample/.debugbridge.DebugBridgeNativeTestActivity`
  and launched it; `launch-activity --activity
  .debugbridge.DebugBridgeNativeTestActivity --extra probe=launch-activity`
  also started the explicit component successfully.

## Screenshot capture does not prove the target package is foreground

- Status: fixed in desktop CLI `0.1.8`
- Found while validating: `C:\project\reader`, home/login visual checks
- Bridge version: desktop CLI `0.1.6`, app bridge `0.1.4`
- Evidence:
  - `ai-app-bridge screenshot --package-name com.example.reader ...` can still
    return a valid PNG of the device's current foreground screen.
  - During reader validation, a screenshot request returned the Android
    launcher because the device was being used manually between bridge actions.
  - The command result was structurally successful (`ok=true`, width/height
    present), so screenshot success alone was not enough to prove the Reader
    app was visible.
- Impact: visual validation can falsely pass or fail if a human, launcher,
  permission surface, or another app takes foreground between `status/tree` and
  `screenshot`.
- Fix: `screenshot --package-name ...` now includes foreground package/activity
  metadata parsed from `dumpsys window` and returns
  `error=foreground_package_mismatch` when the foreground package does not match
  the requested package.
- Verification: the native sample returned `foregroundMatchesPackage=true` while
  foregrounded, then returned `ok=false` with `foreground_package_mismatch` after
  pressing Home and capturing the launcher.

## Reused default artifact filenames can make validation evidence stale

- Status: fixed in desktop CLI `0.1.22`
- Found while validating: `D:\CompanyProject\pos-android`,
  `PayDialogNew` visual checks on a dual-display K2_MINI device
- Bridge version: desktop CLI `0.1.8`, app bridge `0.1.8`
- Evidence:
  - `screenshot` writes to `ai_app_bridge_screenshot.png` when `--out-file` is
    omitted.
  - The native sample smoke flow also reuses `smoke_screenshot.png` when no
    output path is provided.
  - During POS payment-dialog validation, repeated bridge screenshots were
    written through the same default name while the surrounding tool UI could
    still present an older image preview for that path.
  - A follow-up check with unique timestamped output paths showed the bridge
    screenshot and raw `adb exec-out screencap -p` output had the same byte size
    and hash, so the captured PNG itself matched ADB for display 0.
  - The device also had a second presentation display, where display 0 showed
    the cashier payment dialog and display 1 showed a different customer-facing
    screen. That made stale-path previews and wrong-display assumptions harder
    to distinguish by eye.
- Impact: validation evidence can be misread when file-producing commands reuse
  stable default names. This is not limited to screenshots; any future exported
  tree, log, report, trace, or MCP artifact with a reused default path can create
  the same false-current evidence risk.
- Fix: `screenshot` and `smoke` now generate unique default PNG paths under
  `build/ai_app_bridge_artifacts` when `--out-file` is omitted. Screenshot results
  include artifact metadata, MCP forwards `outFile` and `artifactDir` for
  screenshot/smoke flows, and MCP defaults generated artifacts to the MCP
  process working directory rather than the installed package `bin` directory.
  The CLI keeps the newest 20 generated screenshots for each command prefix and
  does not prune explicit `--out-file` paths.
- Verification: desktop CLI `npm run check` passed 29 tests, including
  regression coverage for generated artifact paths and fixed-count pruning.
  Real-device validation on TestProject apps
  `android-architecture-samples`, `AntennaPod`, and `platform_design` produced
  three unique screenshot paths with `foregroundMatchesPackage=true`; after
  seeding old generated screenshot names, the artifact directory stayed at 20
  generated screenshots. A separate explicit `--out-file` screenshot was
  created without pruning generated artifacts.

## `tap-text` can report success for a node outside the tappable viewport

- Status: fixed in desktop CLI `0.1.8`
- Found while validating: `C:\project\reader`, bookshelf entry navigation
- Bridge version: desktop CLI `0.1.6`, app bridge `0.1.4`
- Evidence:
  - `ai-app-bridge tap-text --target-text 一气朝阳 --package-name com.example.reader`
    returned `ok=true`, `source=bridge-tree`, and tap coordinates `x=718`,
    `y=2810`.
  - The device viewport reported by the preceding tree/status pass was
    `1264x2780`, so the selected node center was below the visible screen.
  - The command did not navigate away from `com.example.reader.ui.activity.MainActivity`.
- Impact: agent flows can believe a tap succeeded even though the target node is
  clipped/offscreen and Android ignores or misroutes the tap.
- Fix: `tap-text` now filters bridge-tree matches by effective visibility,
  positive bounds, and center point inside the root/window viewport. It skips
  offscreen bridge nodes and falls back to UIAutomator; if only offscreen bridge
  matches exist, it returns `bridge_tree_node_not_tappable`.
- Verification: Node unit tests cover visible selection after an offscreen
  duplicate and the offscreen-only failure path. Native sample smoke still
  passed tap, input, dialog, scroll, and back navigation.

## `status --package-name` can expose a raw socket hang-up before app readiness

- Status: fixed in desktop CLI `0.1.8`
- Found while validating: `C:\project\reader`, post-install bridge readiness
- Bridge version: desktop CLI `0.1.6`, app bridge `0.1.4`
- Evidence:
  - After installing the debug APK and clearing logcat, before explicitly
    starting Reader, `ai-app-bridge status --package-name com.example.reader`
    failed with the raw Node error `Error: socket hang up`.
  - Starting the app with
    `adb shell am start -W -n com.example.reader/.ui.activity.MainActivity` and
    retrying the same status command returned structured JSON with
    `activity.current=com.example.reader.ui.activity.MainActivity`.
- Impact: agent loops cannot reliably distinguish "target app is not started or
  bridge is not ready yet" from a real transport failure when the CLI exposes
  the low-level socket exception directly.
- Fix: `status` now catches socket reset, HTTP timeout, refused connections,
  ADB timeout, and forward failures and returns structured JSON with the
  requested package, attempted local/device ports, port discovery source, and a
  suggested next action.
- Verification: Node unit tests cover socket hang-up, status HTTP timeout, and
  ADB timeout normalization.

## Package port discovery can hang the CLI when ADB stalls

- Status: fixed in desktop CLI `0.1.8`
- Found while validating: multiple installed apps under `D:\TestProject`
- Bridge version: desktop CLI `0.1.7`
- Evidence:
  - `adb shell run-as <package> cat files/ai_app_bridge_port.json` hung on some
    installed apps while the package had a previously written port file.
  - Because CLI ADB subprocesses had no timeout, `status --package-name` could
    block indefinitely before reaching the HTTP bridge request.
- Impact: batch unattended validation can stall on one unhealthy device/package
  instead of returning a diagnosable result.
- Fix: ADB subprocess calls now use a default timeout
  (`AI_APP_BRIDGE_ADB_TIMEOUT_MS`, default 15000 ms, or `--adb-timeout-ms`) and
  classify timeouts as `adb_timeout` for `status`.

## Multiple package probes can fight over local port 18080

- Status: fixed in desktop CLI `0.1.8`
- Found while validating: multiple installed apps under `D:\TestProject`
- Bridge version: desktop CLI `0.1.7`
- Evidence:
  - Separate status/tree probes for different packages reused local
    `tcp:18080`, so later `adb forward` calls could remap the same local port
    to another device bridge port.
  - This produced false `HTTP timeout` results even when app-specific port files
    existed.
- Impact: parallel or rapid sequential validation across several bridged apps
  can report false negatives.
- Fix: when a package port file is discovered and `--port` was not explicitly
  supplied, the CLI now forwards local `tcp:<devicePort>` to the same device
  port instead of always using local 18080.

## Very large Gradle builds need watchdog and heartbeat handling

- Status: open
- Found while validating: `D:\TestProject\DuckDuckGo-Android`
- Evidence:
  - After repairing the required NDK and fixing the dependency configuration,
    `:app:assembleInternalDebug -PuseProprietaryFont=false --no-daemon` reached
    real multi-module resource, manifest, Kotlin, KSP, and Anvil work.
  - The build then produced no new Gradle output for more than an hour and no
    APK was created under `app\build\outputs`.
  - A JVM thread dump showed the Gradle daemon worker waiting for included build
    task completion while process CPU still advanced slowly.
- Impact: unattended production validation can burn hours on one large app
  without a clear "failed" result unless the harness has task-level heartbeats,
  log-stall detection, and a timeout policy.
- Workaround: for production-scale apps, run builds under an external watchdog
  that records the last output timestamp, current task evidence, JVM thread
  state, and artifact presence before terminating a stale run.

## MCP tool list is large for smaller-context models

- Status: fixed in desktop MCP `0.2.2`; further tuning can continue
- Found while publishing desktop MCP `0.2.1`: the MCP server exposed 48 tools
  after adding `launch_app` and `launch_activity`.
- Impact: models with smaller context windows may spend too much prompt budget
  on full tool schemas, even though the agent still needs to know that install,
  launch, UI, WebView, logcat, permission, and diagnostics capabilities exist.
- Desired direction: keep a small always-visible capability index/help tool so
  agents can discover the available domains and prefer bridge actions, then
  move detailed schemas behind grouped execution tools or domain-specific
  manifests. Do not hide important capabilities such as `install_apk`; shrink
  the resident schema, not the advertised capability set.
- Fix: default MCP surface now exposes only `capabilities` and `run`.
  `capabilities` advertises install, launch, UI/action, Flutter, WebView,
  logcat, network, permission, and diagnostics domains; `run` executes the
  selected CLI command. Legacy direct tools remain callable and can be listed
  by launching the server with `AI_APP_BRIDGE_MCP_SURFACE=full`.
- Compatibility hardening: MCP `initialize` now negotiates supported protocol
  versions instead of echoing any client version, includes concise server
  instructions for tool-search clients, supports `ping`, and accepts the
  standard `notifications/initialized` lifecycle notification.

## `--help` should not probe ADB or the default sample package

- Status: fixed in desktop CLI `0.1.10`
- Found while validating: `D:\TestProject\DuckDuckGo-Android`
- Evidence:
  - Running `node ...\ai-app-bridge.js --help` did not print help. Because the
    parser treated `--help` as an option and no command was present, it fell
    through to default `status`.
  - The command then attempted to query the default sample package
    `io.github.mobileaidev.aiappbridge.sample` and waited for bridge readiness.
- Impact: unattended scripts and humans can trigger device I/O while only trying
  to inspect CLI usage, which is confusing during multi-app validation.
- Fix: `--help` and `help` now print static usage text and return without
  constructing an ADB context or touching the device. Unit tests execute both
  forms with a deliberately invalid `ADB` value to prove no ADB subprocess is
  used.

## Windows KSP incremental processing can fail across drive roots

- Status: open environment/toolchain issue
- Found while validating: `D:\TestProject\DuckDuckGo-Android`
- Evidence:
  - `:app:kspInternalDebugKotlin` failed in Glide KSP with
    `this and base files have different roots`.
  - The processor attempted to associate
    `C:\Users\dev\.gradle\caches\...\okhttp3-integration-4.16.0-api.jar!...`
    with base project path `D:\TestProject\DuckDuckGo-Android\app`.
  - A narrower retry with quoted PowerShell argument `"-Pksp.incremental=false"`
    and `--no-build-cache` passed `:app:kspInternalDebugKotlin` in 4m12s.
- Impact: a production app can fail after dependency resolution and manifest
  merge even though the bridge runtime is not involved.
- Workaround: for Windows cross-drive builds, retry with
  `"-Pksp.incremental=false" --no-build-cache`; quote the `-P` argument in
  PowerShell so Gradle does not parse `.incremental=false` as a task name.

## Production Android clones may be missing native submodules

- Status: open repository setup issue
- Found while validating: `D:\TestProject\DuckDuckGo-Android`
- Evidence:
  - After KSP was fixed, `:httpsupgrade-impl:configureCMakeDebug[arm64-v8a]`
    failed because CMake could not find
    `src/main/cpp/bloom_cpp/src/BloomFilter.cpp`.
  - `git submodule status` showed leading `-` entries for
    `httpsupgrade/httpsupgrade-impl/src/main/cpp/bloom_cpp` and
    `submodules/privacy-grade`.
  - `git submodule update --init --recursive` checked out both modules and the
    nested `bloom_cpp/third-party/catch2`, after which the native CMake step and
    full APK build passed.
- Impact: unattended validation can misclassify a missing repository bootstrap
  step as a native toolchain or bridge integration failure.
- Workaround: before building large production Android repos, record
  `git submodule status` and run `git submodule update --init --recursive` when
  any required submodule is uninitialized.

## SDK manager can leave partial Android package downloads

- Status: open environment issue
- Found while validating: `D:\TestProject\DuckDuckGo-Android`
- Evidence:
  - Gradle attempted to auto-install `ndk;21.4.7075529` and failed with
    `ZipException: Archive is not a ZIP archive`.
  - The SDK temp area contained a partial
    `android-ndk-r21e-windows-x86_64.zip` of `545710784` bytes.
  - Resuming the official download to `1109665123` bytes and verifying SHA-1
    `FC44FEA8BB3F5A6789821F40F41DCE2D2CD5DC30` allowed the NDK to be installed
    with `Pkg.Revision = 21.4.7075529`.
- Impact: failures can look like app/Gradle failures while the actual problem
  is a corrupted SDK component download.
- Workaround: verify SDK component file size/hash before retrying the build; if
  the package is partial, remove only the exact failed component directory and
  install a verified archive.
