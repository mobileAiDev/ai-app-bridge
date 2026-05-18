# Progress

## 2026-05-18

- Android runtime `0.1.9` adds `/v1/action/input-text`, which sets text on the
  focused or coordinate-matched native `EditText` from inside the app process.
  This avoids Android 16 `adb shell input text` Unicode failures.
- Desktop CLI `0.1.25` makes `input-text` prefer that native bridge endpoint.
  For non-ASCII text it now returns a structured
  `unicode_text_requires_bridge_input` result instead of falling back to ADB.
- MCP tool descriptions now tell agents to use bridge input for
  Chinese/Unicode and expose `input_flutter_text` for Flutter text fields.
- Flutter package `0.1.10` now depends on Android runtime `0.1.9` in debug
  builds so Flutter consumers pick up the same native input endpoint.

## 2026-05-12

- `flutter_inappwebview_android/example` was revalidated against the published
  Flutter package path first: `flutter pub get` resolved hosted
  `ai_app_bridge_flutter 0.1.8`, `flutter analyze --no-pub` passed,
  `flutter build apk --debug --no-pub` passed, and `install-apk` completed as
  `installMode=reinstall`.
- The same WebView validation operated the Flutter button and H5 callback
  closure: `tap-flutter-text "Run AI Bridge Probe"` updated the H5 page,
  `flutter-h5-click --selector "#h5-event-button"` returned `ok=true`,
  `/v1/logs`, `/v1/state`, and `/v1/events` all exposed the probe records, and
  `webview-network` captured an H5 `fetch` to
  `https://httpbin.org/get?from=heartbeat-2055-webview-cdp` with method `GET`,
  HTTP status `200`, response body, `Network.requestWillBeSent`,
  `Network.responseReceived`, and console message
  `AI_BRIDGE_STRESS_CDP_RESPONSE 200`.
- That run confirmed a Flutter package bug: `recordState(... value:
  "Flutter probe run #1")` arrived in `/v1/state` as `"Flutter"` through the
  MethodChannel path. Flutter package `0.1.9` fixes MethodChannel capture value
  serialization. Rebuilding and reinstalling the example with local `0.1.9`
  proved `/v1/state` now returns the full string
  `Flutter probe run #1`; the WebView CDP fetch/console path still passed with
  `https://httpbin.org/get?from=heartbeat-2055-after-state-fix`.
- Flutter `ai_app_bridge_flutter 0.1.9` was published to pub.dev after a
  zero-warning `flutter pub publish --dry-run`. Post-publish validation switched
  the same example to hosted `ai_app_bridge_flutter: ^0.1.9`; `flutter pub get`,
  `flutter analyze --no-pub`, `flutter build apk --debug --no-pub`,
  `install-apk`, and the state string assertion all passed.

- `platform_design` was revalidated as a real Flutter target from
  `D:\TestProject\flutter-samples\platform_design` using a local path
  dependency on `flutter/ai_app_bridge_flutter`.
  `flutter analyze --no-pub`, `flutter build apk --debug --no-pub`, and
  `install-apk --package-name dev.flutter.platform_design` all passed on
  device `b46093e6`.
- Desktop CLI `0.1.18` fixes the excessive Flutter `status` output found in
  that run. Default `status` now returns compact layout metadata; `--full`
  keeps the raw response available. `npm run check` passed 24 tests.
- Flutter package `0.1.8` fixes stale/off-route Flutter target matching.
  Before the fix, a song detail page could still report a previous list item
  tap as `ok=true`. After the fix, opening `Script Coin` and then tapping old
  list text `Tool Spot` returned `text_not_found`, and compact status only
  exposed current detail targets.

- Desktop CLI `0.1.17` adds a host-side cross-process lock around
  `uiautomator dump`. A Now in Android validation pass reproduced the device
  failure mode by running `wait-text` and multiple `uia-tree` commands in
  parallel; logcat showed `UiAutomationService ... already registered!`. After
  the lock fix, three parallel UIAutomator-backed commands all completed and
  `adb logcat -d -s AndroidRuntime` showed no `UiAutomationService`,
  `already registered`, or `FATAL EXCEPTION` entries.
- The same pass upgraded `D:\TestProject\nowinandroid` from bridge `0.1.5` to
  `0.1.8`, rebuilt `:app:assembleDemoDebug`, installed
  `app-demo-debug.apk` with `install-apk`, and verified `/v1/status` reported
  runtime `0.1.8` on `com.google.samples.apps.nowinandroid.demo.debug`.
  UIAutomator operated the Compose `Bookmark` control, logcat recorded
  `AiLoop  : For You bookmark changed id=2 bookmarked=true`, and the known
  Compose limitation remained: bridge `tree` sees `AndroidComposeView` while
  `uia-tree` exposes the actionable Compose semantics.

- Added WebView DevTools/CDP capture for debuggable Android WebViews:
  - Android runtime `0.1.7` enables WebView debugging only when the host app is
    debuggable.
  - Desktop CLI `0.1.12` exposes `webview-pages`, `webview-network`, and
    `webview-console`; MCP exposes matching tools.
  - `webview-network` captures H5 request URL/method/headers, response status
    and headers when CDP exposes them, loading failures, and console/log output.
- Validation completed on device `b46093e6`:
  - `npm run check` passed with 13 `node:test` tests.
  - Android runtime and Gradle plugin build plus `publishToMavenLocal` passed.
  - Flutter `flutter analyze --no-pub` passed.
  - Native sample `:app:assembleDebug` passed and `install-apk` completed as
    `installMode=reinstall`.
  - `webview-pages` found `webview_devtools_remote_15747` and listed the
    sample `Native H5 Test` page.
  - `webview-network` captured a WebView `fetch` to
    `/v1/status?from=manual-webview-cdp-2` with method `GET` and HTTP status
    `200` from CDP extra-info, plus the expected CORS console error.
  - `webview-console` captured `ai-bridge-webview-console-standalone`.
  - Final sample smoke passed with WebView CDP counts `events=10`,
    `requests=1`, and `console=5`.
  - `D:\TestProject\flutter_inappwebview` Android example was launched on the
    same device with its existing AI bridge probe. `webview-network` attached
    to `webview_devtools_remote_18559`, captured the page
    `https://debug.local/ai-bridge-probe/run/0`, proved a blocked cleartext H5
    fetch reports `net::ERR_CLEARTEXT_NOT_PERMITTED`, and then captured an
    HTTPS H5 fetch to `https://httpbin.org/get?from=testproject-webview-cdp-https`
    with method `GET`, status `200`, response headers, response body, and
    console message `ai-bridge-testproject-cdp-https-response 200`.

## 2026-05-11

- Release-candidate validation for Android `0.1.6` and desktop CLI `0.1.11`
  completed on OPPO device `FYZLAU49X8OVQGJ7`:
  - Desktop CLI `npm run check`, `npm pack --dry-run`, and zero-side-effect
    `--help` passed.
  - Android runtime and Gradle plugin build passed with
    `:ai-app-bridge-android:build :ai-app-bridge-gradle-plugin:build`.
  - `install-apk` proved both `installMode=new_install` and
    `installMode=reinstall`; the OPPO installer flow required tapping
    `继续安装`, and the fixed helper stopped before app-market / installer
    finish recommendation surfaces.
  - A mistaken app-market install of `com.phoenix.read` was identified,
    uninstalled, and covered by the new market-surface guard.
  - Keyboard validation proved `keyboard-state` reports true when the IME is
    visible, `input-text --hide-keyboard` dismisses it, and stale
    `mIsInputViewShown=true` is not treated as visible when
    `mInputShown=false`, `mWindowVisible=false`, and `mImeWindowVis=0`.
  - Sample bytecode inspection with `javap` proved
    `AiAppOkHttpAutoCapture.installBuilder(...)` is injected before
    `OkHttpClient.Builder.build()`.
  - Runtime OkHttp auto capture produced `source=okhttp-auto` GET and POST
    records, including POST request/response bodies.
  - Final native sample smoke passed status, SDK tree, UIAutomator tree,
    screenshot, H5 DOM/click/input/wait/scroll, tap, input, dialog, capture
    query, permission state, scroll, and back navigation.

- Desktop CLI `0.1.8` was published to npm after local package validation.
  `npm view @lidongping/ai-app-bridge version` returned `0.1.8` after publish.
  The temporary npm token was removed from the working tree after use; because
  it appeared in chat, it should still be rotated.
- Re-ran broad device validation across installed apps under `D:\TestProject`
  after ADB recovered to device `b46093e6`:
  - `android-architecture-samples`: explicit launch succeeded; bridge `0.1.5`
    on port `18083`; `/v1/status`, `/v1/view/tree`, and foreground screenshot
    verification passed.
  - `compose-samples\Jetchat`: explicit launch succeeded; bridge `0.1.4` on
    port `18081`; `/v1/status`, `/v1/view/tree`, and foreground screenshot
    verification passed.
  - `NewPipe`: retry after initial app readiness failure succeeded with bridge
    `0.1.5` on port `18084` and a large UI tree. Screenshot correctly failed
    with `foreground_package_mismatch` while Android permission UI was in front,
    proving the desktop CLI guard catches permission surfaces.
  - `AntennaPod`: bridge `0.1.5` on port `18085`; status/tree/screenshot passed.
  - `Now in Android`: bridge `0.1.5` on port `18087`;
    status/tree/screenshot passed.
  - `flutter_inappwebview` Android example: bridge `0.1.5` on port `18086`;
    status/tree/screenshot passed.
  - `flutter-samples\platform_design`: bridge `0.1.5` on port `18082`;
    status/tree/screenshot passed.
- External project build validation from the same pass:
  - `android-architecture-samples` `:app:assembleDebug` passed.
  - `compose-samples\Jetchat` `:app:assembleDebug` passed.
  - `AntennaPod` `:app:assembleDebug` passed.
  - `NewPipe` `:app:assembleDebug` passed and executed
    `:app:transformDebugClassesWithAsm`.
  - `flutter-samples\platform_design` `flutter build apk --debug --no-pub`
    passed after Kotlin incremental compilation reported a cross-drive cache
    path warning and fell back.
  - `openfoodfacts/smooth-app` stayed toolchain-blocked before bridge runtime:
    local Dart was `3.9.2`, while the app requires Dart `^3.11.5`.
- `Now in Android` deep validation was expanded with real code changes:
  `ForYouViewModel` exposes a `BookmarkValidationUiState`, bookmark operations
  enter validating/saved/removed/invalid/failed states, `ForYouScreen` renders
  the status surface, and `ForYouViewModelTest` covers the state transitions.
  The worker-ran targeted unit test
  `:feature:foryou:impl:testDemoDebugUnitTest --tests ...ForYouViewModelTest`
  and `assembleDemoDebug` both passed. The APK was installed on device,
  `/v1/status` and screenshot foreground verification passed, UIAutomator saw
  the bookmark control toggle between `Bookmark` and `Unbookmark`, and logcat
  contained `AiLoop  : For You bookmark changed id=2 bookmarked=false`.
- `flutter_inappwebview` Android example deep validation was expanded with a
  local H5 bridge page in `lib/main.dart`. The app now loads
  `https://debug.local/ai-bridge-probe/`, exposes an `AI Bridge Closure Probe`
  Flutter surface, injects Flutter state into the H5 page, and receives H5
  button events through `window.flutter_inappwebview.callHandler`. `flutter
  analyze --no-pub` and `flutter build apk --debug --no-pub` passed. Runtime
  `/v1/status` reported H5 DOM title `AI Bridge H5 Probe`, controls
  `h5-input` and `h5-event-button`, Flutter operable nodes such as
  `AI Bridge Probe Banner`, and capture counts `logs=1`, `state=2`, `events=2`.
- `DuckDuckGo-Android` was used as a 100+ module production-scale validation
  target. A debug-only runtime dependency was added with
  `debugImplementation "com.github.ldpGitHub.ai-app-bridge:ai-app-bridge-android:_"`,
  and `versions.properties` maps it to `0.1.5`. The first build exposed an
  environment blocker: automatic `ndk;21.4.7075529` install left a partial ZIP
  and failed with `ZipException: Archive is not a ZIP archive`. The NDK was
  repaired by downloading the official `android-ndk-r21e-windows-x86_64.zip`,
  verifying SHA-1 `FC44FEA8BB3F5A6789821F40F41DCE2D2CD5DC30`, and installing it
  under `Sdk\ndk\21.4.7075529`.
- DuckDuckGo then reached real multi-module resource, manifest, Kotlin, KSP,
  and Anvil build work. `internalDebugImplementation` was not supported by this
  Groovy/AGP setup, so the dependency was narrowed to standard
  `debugImplementation` to keep release variants bridge-free. After that, the
  build ran for more than an hour with no APK output; thread dump showed the
  Gradle daemon worker waiting for included build task completion while CPU was
  still advancing slowly. The run was terminated and recorded as an unattended
  watchdog/heartbeat requirement for very large Gradle builds, not as a bridge
  dependency resolution failure.
- DuckDuckGo validation was resumed with narrower evidence first:
  `:app:dependencyInsight --configuration internalDebugRuntimeClasspath
  --dependency ai-app-bridge-android` resolved
  `com.github.ldpGitHub.ai-app-bridge:ai-app-bridge-android:0.1.5` for
  `internalDebugRuntimeClasspath`, and
  `:app:assembleInternalDebug --dry-run` completed successfully.
- The resumed full build exposed two production-repo environment/toolchain
  issues before APK output:
  - `:app:kspInternalDebugKotlin` failed in Glide KSP with
    `this and base files have different roots` between
    `C:\Users\ldp\.gradle\...okhttp3-integration-4.16.0-api.jar` and
    `D:\TestProject\DuckDuckGo-Android\app`. Quoting
    `"-Pksp.incremental=false"` in PowerShell and disabling build cache let the
    narrow KSP task pass in 4m12s.
  - `:httpsupgrade-impl:configureCMakeDebug[arm64-v8a]` failed because
    `bloom_cpp/src/BloomFilter.cpp` was missing. `git submodule update --init
    --recursive` checked out `bloom_cpp`, `privacy-grade`, and
    `bloom_cpp/third-party/catch2`.
- With those fixes, DuckDuckGo `:app:assembleInternalDebug
  -PuseProprietaryFont=false "-Pksp.incremental=false"
  --no-configuration-cache --no-build-cache --no-daemon --max-workers=2`
  completed successfully in 7m09s and produced
  `app\build\outputs\apk\internal\debug\duckduckgo-5.278.1-internal-debug.apk`
  (`121423989` bytes).
- Runtime validation on device `b46093e6` passed:
  - ColorOS install required tapping the device-side `继续安装` confirmation;
    `adb install --no-streaming -r -d ...duckduckgo-5.278.1-internal-debug.apk`
    then returned `Success`.
  - `run-as com.duckduckgo.mobile.android.debug cat
    files/ai_app_bridge_port.json` returned bridge port `18089`, version
    `0.1.5`.
  - `status --package-name com.duckduckgo.mobile.android.debug` returned
    `ok=true`, app version `5.278.1`, debuggable `true`, current activity
    `com.duckduckgo.app.onboarding.ui.OnboardingActivity`, and bridge
    `127.0.0.1:18089`.
  - `tree --package-name com.duckduckgo.mobile.android.debug` returned
    `ok=true`, `windowCount=1`, `nodeCount=294`, and visible onboarding nodes
    including `Let's do it!`.
  - `screenshot --package-name ...` wrote
    `D:\TestProject\DuckDuckGo-Android\build\ai-bridge-duckduckgo.png`
    (`1264x2780`) with `foregroundMatchesPackage=true`.
  - `tap-text --target-text "Let's do it!"` selected the bridge-tree node and
    tapped `(632,1169)`, after which UIAutomator showed onboarding step `1 / 3`
    with `Protections activated!` and `Choose Your Browser`.
- Desktop CLI `0.1.10` was published to npm after adding a zero-side-effect
  `--help`/`help` path. The DuckDuckGo run showed that `--help` previously fell
  through to default `status` and probed the sample app. Unit tests now execute
  both help forms with an invalid `ADB` value to prove no device command is run.
  The MCP server now reports its version from `package.json` instead of a stale
  hard-coded value. `npm view @lidongping/ai-app-bridge version` returned
  `0.1.10` after publish.

## 2026-05-10

- Desktop CLI `0.1.8` fixes were implemented for reader and unattended
  validation failures:
  - `status --package-name` now returns structured JSON for socket hang-up,
    HTTP timeout, ADB timeout, refused connections, and forward failures instead
    of exposing raw Node errors.
  - ADB subprocess calls now have a default timeout, configurable with
    `AI_APP_BRIDGE_ADB_TIMEOUT_MS` or `--adb-timeout-ms`.
  - Package port discovery no longer forces all package probes through local
    `18080`; discovered device ports are forwarded to matching local ports when
    `--port` is not explicitly supplied.
  - `screenshot --package-name` now includes foreground package/activity
    metadata and fails with `foreground_package_mismatch` when the current
    foreground package is not the requested target.
  - `tap-text` now rejects invisible, empty, or offscreen bridge-tree matches
    before tapping, and falls back to UIAutomator.
- Desktop CLI tests were added with Node's built-in test runner. Current
  coverage includes socket hang-up normalization, HTTP timeout normalization,
  ADB timeout normalization, foreground window parsing, offscreen duplicate
  `tap-text` selection, and offscreen-only `tap-text` failure.
- Local repository verification for this slice passed:
  - `npm run check` in `desktop/ai-app-bridge-cli`.
  - `:ai-app-bridge-android:build :ai-app-bridge-gradle-plugin:build`.
  - `flutter pub get` and `flutter analyze --no-pub` in
    `flutter/ai_app_bridge_flutter`.
  - `npm pack --dry-run` for the desktop CLI package.
- Native sample verification passed on device `b46093e6` before ADB later went
  offline during external-app validation:
  - Built `examples/android-native-sample` with
    `:app:assembleDebug`; `transformDebugClassesWithAsm` executed.
  - Installed through the ColorOS security installer flow.
  - `smoke --skip-flutter-launch` passed status, SDK tree, UIAutomator tree,
    screenshot, H5 DOM/click/input/wait/scroll, tap, input, dialog, capture
    query, permission state, scroll, and back navigation.
  - Foreground screenshot verification returned `foregroundMatchesPackage=true`
    while the sample was foreground, then returned
    `foreground_package_mismatch` after pressing Home.
- External app validation under `D:\TestProject`:
  - NewPipe was fully validated before the device went offline:
    `status --packageName org.schabi.newpipe.debug --port 18084` returned
    bridge `0.1.5`, app `0.28.6`, current `org.schabi.newpipe.MainActivity`,
    and `capture.network=13`; `/v1/view/tree` returned `nodeCount=364` and
    `windowCount=1`; foreground was
    `org.schabi.newpipe.debug/org.schabi.newpipe.MainActivity`; screenshot
    returned a `1264x2780` PNG.
  - AntennaPod and Now in Android were installed and had bridge port files
    (`18085` and `18087`), but runtime CLI validation was blocked after an ADB
    transport failure. The device stayed `offline` after server restart, so
    deeper validation was stopped instead of forcing more commands.
  - Flutter validation inventory confirmed installed packages for
    `flutter_inappwebview` and `platform_design`; `smooth-app` remains blocked
    by local Dart `3.9.2` versus its required `^3.11.5`.

- Compatibility validation expanded to external projects under `D:\TestProject`:
  `compose-samples\Jetchat`, `android-architecture-samples`, and
  `flutter-samples\platform_design`.
- `Jetchat` validated with remote Android `0.1.4`: Gradle `9.4.1`, AGP
  `9.2.0`, Kotlin `2.3.21`; `:app:assembleDebug` succeeded, APK installed,
  `/v1/status` reported bridge `0.1.4`, and `/v1/view/tree` returned a Compose
  tree.
- `android-architecture-samples` exposed a release blocker in remote Android
  `0.1.4`: its app `minSdk=21` cannot consume runtime AAR `minSdk=23`.
  Lowering the runtime and Flutter wrapper Android `minSdk` to 21 was verified
  locally through Maven Local with build, install, `/v1/status`, and
  `/v1/view/tree`.
- `flutter-samples\platform_design` validated Flutter runtime data capture:
  after calling `WidgetsFlutterBinding.ensureInitialized()` before
  `AiAppBridge.instance.initialize(...)`, `/v1/status` included Flutter widget
  snapshot data and operable nodes such as list items and tabs.
- Flutter integration is being simplified for `0.1.5`: the Flutter plugin's
  Android debug variant now declares the Android runtime dependency, so Flutter
  consumers only need the pub package plus a JitPack repository. The release
  variant keeps the runtime absent.
- Flutter package SDK constraints were widened from Dart `^3.9.2` to
  `>=3.0.0 <4.0.0` and Flutter `>=3.10.0`, matching the documented runtime
  requirements instead of forcing latest Flutter projects only.
- `0.1.5` local verification completed:
  - Repository build passed with
    `:ai-app-bridge-android:build :ai-app-bridge-gradle-plugin:build`.
  - Flutter plugin passed `flutter pub get` and `flutter analyze --no-pub`.
  - Android artifacts were published to Maven Local under JitPack coordinates
    `com.github.ldpGitHub.ai-app-bridge:*:0.1.5` for local proof.
  - `android-architecture-samples` rebuilt with `0.1.5`, installed on device
    `b46093e6`, `/v1/status` reported bridge `0.1.5`, and `/v1/view/tree`
    returned the Compose root.
  - `platform_design` removed the host app's manual Android runtime dependency
    and used the local Flutter plugin `0.1.5`; debug runtime classpath included
    `ai-app-bridge-android:0.1.5`, release runtime classpath did not include
    it, the APK installed, `/v1/status` reported bridge `0.1.5`, and Flutter
    widget/operable data was present.
- `0.1.5` remote dependency verification completed after pushing tag `0.1.5`:
  - JitPack returned HTTP 200 for both `ai-app-bridge-android` and
    `ai-app-bridge-gradle-plugin` POMs.
  - `android-architecture-samples` removed `mavenLocal()`, rebuilt with
    `--refresh-dependencies`, installed, and reported bridge `0.1.5` through
    `/v1/status`; `/v1/view/tree` returned the Compose root.
  - `platform_design` removed `mavenLocal()`, rebuilt using the local Flutter
    plugin plus remote JitPack Android runtime, installed, and reported bridge
    `0.1.5` with Flutter widget/operable data.
- Flutter `ai_app_bridge_flutter` `0.1.5` was published to pub.dev. After
  pub.dev API and archive download showed `0.1.5`, `platform_design` removed
  the local path override and resolved `ai_app_bridge_flutter: ^0.1.5` from
  pub.dev. `flutter pub get`, `flutter analyze --no-pub`, `flutter build apk
  --debug --no-pub`, install, `/v1/status`, and `/v1/view/tree` all passed.
  The installed app reported bridge `0.1.5`, Flutter app
  `platform_design`, `operableCount=6`, first widget `MyAdaptingApp`, and
  native child `FlutterView`.
- `NewPipe` current validation completed from official `dev` at `cd171dab5402`:
  Gradle `9.4.1`, AGP `8.13.2`, Kotlin `2.3.21`, OkHttp `5.3.2`.
  Minimal debug integration added remote Android runtime `0.1.5` and enabled
  the debug Gradle plugin's OkHttp capture. `debugRuntimeClasspath` resolved
  `ai-app-bridge-android:0.1.5`; `:app:assembleDebug` succeeded and executed
  `:app:transformDebugClassesWithAsm`. The APK installed on device `b46093e6`
  after switching from adb streaming install to `--no-streaming`; `/v1/status`
  reported bridge `0.1.5` on port `18084`, `/v1/view/tree` returned the
  NewPipe home tree, and `/v1/network` returned `13` `okhttp-auto` records with
  redaction enabled.
- `AntennaPod` current validation completed from official `develop` at
  `78594ec`: Gradle `8.13`, AGP `8.11.0`, Kotlin BOM `1.9.24`, OkHttp
  `4.12.0`. Minimal debug integration added remote Android runtime `0.1.5`
  and enabled the debug Gradle plugin's OkHttp capture. `freeDebugRuntimeClasspath`
  resolved `ai-app-bridge-android:0.1.5`; `:app:assembleDebug` succeeded and
  executed `transformFreeDebugClassesWithAsm` plus `transformPlayDebugClassesWithAsm`.
  `app-free-debug.apk` installed on device `b46093e6`; `/v1/status` reported
  bridge `0.1.5` on port `18085`, and `/v1/view/tree` returned the AntennaPod
  home tree.
- `Now in Android` current build validation completed from official `main` at
  `7d45eae`: Gradle `9.4.0`, AGP `9.0.0`, Kotlin `2.3.0`, OkHttp `4.12.0`,
  Retrofit `2.11.0`. Minimal debug integration added remote Android runtime
  `0.1.5` and enabled the debug Gradle plugin's OkHttp capture.
  `demoDebugRuntimeClasspath` resolved `ai-app-bridge-android:0.1.5`;
  `:app:assembleDemoDebug` succeeded and produced `app-demo-debug.apk`. The
  APK installed on device `b46093e6`; `/v1/status` reported bridge `0.1.5` on
  port `18087`, `/v1/view/tree` returned the Compose root, and `/v1/network`
  returned `6` `okhttp-auto` records with Firebase URL token redaction.
- `Now in Android` deep AI-loop validation completed on device `b46093e6`:
  the app was deliberately changed across layout, logic, network, and logging.
  `ForYouScreen` now renders an `AI loop: For You` banner with
  `Bookmark actions`, `ForYouViewModel` increments that count and logs when a
  news bookmark changes, and `NetworkModule` adds the debug request header
  `X-Ai-Loop: nowinandroid` to OkHttp calls. `:app:assembleDemoDebug`
  succeeded, the APK was installed with `adb install --no-streaming -r -d`,
  and the app was operated through the human path: dismiss notification
  permission, select `Headlines`, tap `Done`, then bookmark the first news
  card. `/v1/view/tree` verified the banner changed from
  `Bookmark actions: 0` to `Bookmark actions: 1` and the bookmark semantic
  changed from `Bookmark` to `Unbookmark`. `/v1/network` verified Firebase
  image requests captured by `okhttp-auto` included `requestHeaders` with
  `X-Ai-Loop: nowinandroid`. Filtered logcat verified
  `Added X-Ai-Loop header...`, `X-Ai-Loop: nowinandroid`, and
  `For You bookmark changed id=2 bookmarked=true`.
- `openfoodfacts/smooth-app` current validation is environment-blocked, not
  bridge-blocked. The official `develop` branch at `4adadbb` was minimally
  wired with `ai_app_bridge_flutter: ^0.1.5`, JitPack in Android repositories,
  and `AiAppBridge.instance.initialize(...)` after
  `WidgetsFlutterBinding.ensureInitialized()`, without a manual host Android
  runtime dependency. `flutter pub get` fails before Gradle because the app
  requires Dart `^3.11.5`; the default Flutter is `3.35.8-ohos-0.0.3`
  with Dart `3.9.2`, and the highest checked local Flutter `3.41.6` still has
  Dart `3.11.4`.
- `flutter_inappwebview` Android example validation completed from official
  `master` at `17527ca`: repository `.fvmrc` expects Flutter `3.38.6`, while
  the available Flutter was `3.35.8-ohos-0.0.3` with Dart `3.9.2`. The
  `flutter_inappwebview_android/example` app resolved
  `ai_app_bridge_flutter: ^0.1.5` from pub.dev, initialized the bridge after
  `WidgetsFlutterBinding.ensureInitialized()`, and added JitPack to Android
  repositories without a manual host Android runtime dependency. `flutter pub
  get`, `flutter analyze --no-pub`, and `flutter build apk --debug` succeeded.
  `debugRuntimeClasspath` proved `ai-app-bridge-android:0.1.5` came through
  `project :ai_app_bridge_flutter`. The APK installed on device `b46093e6`;
  `/v1/status` reported bridge `0.1.5` on port `18086`, with Flutter snapshot
  data including `MaterialApp`, `MyApp`, `Scaffold`, `PlatformViewLink`, and
  `AndroidViewSurface`; the operable tree included the title
  `Official InAppWebView website`.
- `flutter_inappwebview` Android example deep AI-loop validation completed on
  device `b46093e6`: the example app was deliberately changed to add an
  `AI Bridge Closure Probe` screen surface with `AI Bridge Probe Banner`,
  `AI Bridge Probe idle`, and `Run AI Bridge Probe`, plus bridge log/event/state
  recording and H5 adapter updates. `flutter analyze --no-pub` and
  `flutter build apk --debug` succeeded. The APK installed with
  `adb install --no-streaming -r -d`, the app launched with bridge `0.1.5` on
  port `18086`, and `/v1/status` initially reported Flutter operable nodes for
  the probe plus H5 URL `https://inappwebview.dev/`. After tapping
  `Run AI Bridge Probe`, `/v1/status` reported `capture.logs=2`,
  `capture.state=1`, and `capture.events=1`; the operable text changed to
  `AI Bridge Probe tapped 1`; H5 changed to
  `https://inappwebview.dev/?ai_bridge_probe=1`; and filtered logcat contained
  `[ai_bridge_probe] tap=1 url=https://inappwebview.dev/?ai_bridge_probe=1`.
- Observed runtime ports during validation were `18081`, `18082`, `18083`,
  `18084`, `18085`, `18086`, and `18087`; desktop tools must keep reading the
  per-app port file and must not assume `18080`.
- Next Android compatibility queue: `DuckDuckGo Android`, `AnkiDroid`,
  `Organic Maps`, and `WordPress Android`.
- Next Flutter compatibility queue: Flutter `add_to_app`, `put-flutter-to-work`,
  `AppFlowy`, `LocalSend`, `Hiddify`, and `flutter/gallery`.
  `openfoodfacts/smooth-app` needs Flutter `3.41.9` or newer before it can be
  fully validated.
- Published local Android bridge `0.1.3` with `./gradlew.bat build publishToMavenLocal --no-daemon`.
- Added multi-window view-tree reporting for PopupWindow/Dialog roots through
  `/v1/view/tree.windows`.
- Updated `/v1/action/tap` to dispatch through the topmost window root that
  contains the requested screen coordinate.
- Added effective visibility metadata: `localVisible`, `effectiveVisible`, and
  compatibility `visible`.
- Added safe-default network redaction for sensitive URL query, header, JSON,
  and form keys.
- Reader app-level verification target for this slice: install `C:\project\reader` with bridge
  `0.1.3`, open the home overflow menu, verify menu rows appear in
  `/v1/view/tree.windows`, and verify bridge tap can enter `LoginActivity`
  without falling through to the bookshelf item.
- Reader verification completed on a OnePlus `PKR110` / Android SDK 36 device:
  `/v1/status` reported bridge `0.1.3`, `/v1/view/tree.windows` included a
  `popup` root for the overflow menu, `/v1/action/tap` on the menu row returned
  `windowType=popup`, and the app navigated to `LoginActivity`.
- Network redaction was verified with a synthetic `/v1/network` payload:
  `mobile`, `token`, `Authorization`, `phone`, and nested `mobileToken` values
  were captured as `[redacted]`.
- `flutter_inappwebview_android/example` was revalidated with hosted
  `ai_app_bridge_flutter 0.1.9` and desktop CLI `0.1.18`/local `0.1.19`
  changes. `flutter pub get`, `flutter test`, `flutter build apk --debug`,
  and `install-apk` all passed. `/v1/status` reported bridge runtime `0.1.8`,
  Flutter layout, H5 DOM body text, H5 controls, logs, states, and events.
  `webview-pages` selected the package WebView DevTools socket and listed one
  page for `AI Bridge H5 Probe`.
- A confirmed CLI gap was found and fixed: generic `tap-text` did not fall
  back to Flutter operable nodes even though `wait-text` could see them. After
  the fix, `tap-text "Run AI Bridge Probe"` returned
  `source=flutter-operable-tree`, tapped physical coordinates `404,812`, and
  the app advanced to `Flutter probe run #2`.
- WebView DevTools/CDP validation on the same app passed: `webview-console`
  captured `AI_BRIDGE_CDP_CONSOLE_2225` and also triggered the H5 button via
  script; `wait-text "H5 event button_click acknowledged #1"` passed and
  `/v1/logs` captured the H5 payload. `webview-network` captured a
  `GET https://example.com/?ai_bridge_probe=2225` fetch with
  `Network.requestWillBeSent`, `Network.responseReceived`, HTTP `200`, and the
  WebView user agent/request headers.
- Published desktop CLI `0.1.19` was revalidated against
  `flutter-samples/platform_design`: `flutter test`, `flutter build apk
  --debug`, reinstall, launch, `status`, screenshot, and generic
  `tap-text "Sad Word"` all passed. The tap used `source=flutter-operable-tree`
  and entered the detail page.
- The same platform design run found and fixed another confirmed CLI issue:
  `wait-text` searched raw Flutter `widgetDump.text`, so it could see offstage
  list text such as `Odd Bell` after navigation. Desktop CLI `0.1.20` now
  excludes raw widget dumps from `wait-text` search input and uses current
  operable/H5 text instead. `npm run check` passed 26 tests, and the device
  retest passed `wait-text "Sad Word" --absent-text "Odd Bell"` while
  `tap-text "Odd Bell"` still failed as expected.
