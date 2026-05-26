# Validation 0.2.8

Date: 2026-05-26

## Local Package Checks

Passed:

```powershell
.\gradlew.bat :ai-app-bridge-gradle-plugin:test `
  :ai-app-bridge-gradle-plugin:build `
  :ai-app-bridge-android:build `
  :ai-app-bridge-gradle-plugin:publishToMavenLocal `
  :ai-app-bridge-android:publishToMavenLocal `
  --console=plain
```

Verified Maven Local coordinates:

```text
io.github.mobileaidev.aiappbridge:ai-app-bridge-android:0.2.8
io.github.mobileaidev.aiappbridge:ai-app-bridge-gradle-plugin:0.2.8
```

Remote consumer coordinates use JitPack, not Maven Central:

```text
com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.2.8
com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-gradle-plugin:0.2.8
```

Verified JitPack `0.2.8` remote endpoints:

```text
https://jitpack.io/com/github/mobileAiDev/ai-app-bridge/ai-app-bridge-android/0.2.8/ai-app-bridge-android-0.2.8.pom -> HTTP 200
https://jitpack.io/com/github/mobileAiDev/ai-app-bridge/ai-app-bridge-gradle-plugin/0.2.8/ai-app-bridge-gradle-plugin-0.2.8.pom -> HTTP 200
https://jitpack.io/com/github/mobileAiDev/ai-app-bridge/io.github.mobileaidev.aiappbridge.android.gradle.plugin/0.2.8/io.github.mobileaidev.aiappbridge.android.gradle.plugin-0.2.8.pom -> HTTP 200
```

Additional regression check after Kotlin DSL validation:

```powershell
.\gradlew.bat :ai-app-bridge-gradle-plugin:test `
  :ai-app-bridge-gradle-plugin:publishToMavenLocal `
  --console=plain
```

## Real App Checks

Passed:

1. `D:\CompanyProject\courier-android`
   - AGP: 4.0.2
   - Backend: legacy Transform
   - Build/install: `:app:installPreDebug` passed with JDK 8 and temporary `minSdkVersion 21`
   - Device package: `com.yto.receivesend.bridge`
   - Runtime: bridge `0.2.8`
   - Runtime commands: `status`, `tree`, `screenshot`, `permission-state`, `uia-tree`, `input-text`, and `tap-text` passed
   - Network: `okhttp-auto` captured login/startup requests and the network-test page requests
   - Note: original `minSdkVersion 19` build exceeds the legacy main-dex limit with or without AI App Bridge.

2. `D:\TestProject\AntennaPod`
   - AGP: 8.11.0
   - Backend: modern ASM
   - Build: `:app:assembleFreeDebug` passed
   - Device package: `de.danoeh.antennapod.debug`
   - Runtime: bridge `0.2.8`
   - Network: `okhttp-auto` captured an iTunes search request.

3. `D:\TestProject\NewPipe`
   - AGP: 8.13.2
   - Backend: modern ASM
   - Build: `:app:assembleDebug` passed
   - Device package: `org.schabi.newpipe.debug`
   - Runtime: bridge `0.2.8`
   - Network: `okhttp-auto` captured YouTube requests.

4. `D:\TestProject\DuckDuckGo-Android`
   - AGP: 8.13.2
   - Backend: modern ASM
   - Build: `:app:assembleInternalDebug` passed with `"-Pksp.incremental=false"`
   - Device package: `com.duckduckgo.mobile.android.debug`
   - Runtime: bridge `0.2.8`
   - Network: `okhttp-auto` captured DuckDuckGo config requests and `example.com` favicon requests.
   - Note: without disabling KSP incremental, the app hits a Windows cross-drive KSP path issue unrelated to AI App Bridge.

5. `D:\TestProject\android-architecture-samples`
   - AGP: 8.7.3
   - Backend: modern ASM
   - Build: `:app:assembleDebug` passed
   - Device package: `com.example.android.architecture.blueprints.main`
   - Runtime: bridge `0.2.8`

6. `D:\TestProject\nowinandroid`
   - AGP: 9.0.0
   - Backend: modern ASM
   - Build: `:app:assembleDemoDebug` passed offline; `:app:assembleProdDebug` passed online
   - Device packages: `com.google.samples.apps.nowinandroid.demo.debug`, `com.google.samples.apps.nowinandroid.debug`
   - Runtime: bridge `0.2.8`

7. `D:\TestProject\compose-samples\Jetchat`
   - AGP: 9.2.0
   - Backend: modern ASM
   - Build: `:app:assembleDebug` passed
   - Device package: `com.example.compose.jetchat`
   - Runtime: bridge `0.2.8`

8. `D:\TestProject\flutter_inappwebview\flutter_inappwebview_android\example\android`
   - AGP: 8.13.2
   - Backend: modern ASM
   - Build: `:app:assembleDebug` passed
   - Device package: `com.pichillilorenzo.flutter_inappwebview_android_example`
   - Runtime: bridge `0.2.8` after excluding the old `com.github.ldpGitHub.ai-app-bridge` runtime pulled by the sample's existing Flutter bridge dependency.
   - WebView: `webview-pages`, `h5-dom`, and `webview-console` passed against the `AI Bridge H5 Probe` page.

9. `D:\TestProject\smooth-app\packages\smooth_app`
   - AGP: 8.11.1
   - Backend: modern ASM
   - Build: `flutter build apk --debug` passed with `PUB_CACHE=D:\TestProject\.pub-cache`
   - Install: `app-debug.apk` installed on device
   - Device package: `org.openfoodfacts.scanner`
   - Runtime: bridge `0.2.8`
   - Runtime commands: `status`, `tree`, `screenshot`, and `network` passed
   - Note: first build exposed a Kotlin DSL issue in `AiAppBridgeExtension`; adding standard `getXxx()` boolean getters fixed it. The remaining Windows cross-drive Pub cache issue was avoided by moving `PUB_CACHE` to D: for the validation command.

10. `D:\TestProject\flutter-samples\platform_design`
   - AGP: 8.11.1
   - Backend: modern ASM
   - Flutter package: local `ai_app_bridge_flutter 0.2.3` path dependency
   - Build: `:app:assembleDebug --refresh-dependencies` passed without `mavenLocal()`
   - Dependency proof: `debugRuntimeClasspath` resolved only `com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.2.8` through project `:ai_app_bridge_flutter`
   - Install: `adb install -r -d build\app\outputs\apk\debug\app-debug.apk` passed
   - Device package: `dev.flutter.platform_design`
   - Runtime: bridge `0.2.8`
   - Runtime commands: `status`, `tree`, `flutter-nodes`, `screenshot`, and `network` passed
   - Note: published `ai_app_bridge_flutter 0.2.1` still depended on Android runtime `0.2.7`; the local `0.2.3` package fixes this by depending on JitPack Android runtime `0.2.8`.

## Release Gate

Release can proceed. The `0.2.8` GitHub tag is visible through JitPack, and Flutter `ai_app_bridge_flutter 0.2.3` resolves the JitPack Android runtime coordinate.
