# AGP 4 Legacy Transform Plan

## Goal

Ship one public Gradle plugin that supports both modern AGP instrumentation and AGP 4 legacy Transform API builds.

The external plugin id stays the same:

```gradle
id("io.github.mobileaidev.aiappbridge.android")
```

## Implementation

1. Detect the available AGP API at runtime.
2. Use the current `androidComponents` ASM backend when AGP exposes the modern instrumentation API.
3. Use a legacy `Transform` backend when AGP 4 exposes `com.android.build.gradle.AppExtension`.
4. Share the OkHttp bytecode visitor between both backends.
5. Keep the bridge Android runtime compatible with minSdk 19.
6. Keep OkHttp capture debug-only by default.

## Test Scope

Unit tests cover:

1. inserting `AiAppOkHttpAutoCapture.installBuilder(builder)` before `OkHttpClient.Builder.build()`;
2. skipping bridge runtime and OkHttp/Okio classes;
3. handling duplicate jar entries in the AGP 4 Transform path;
4. preserving the modern ASM visitor path.

## Validation Matrix

Required local checks:

1. `:ai-app-bridge-gradle-plugin:test`
2. `:ai-app-bridge-gradle-plugin:build`
3. `:ai-app-bridge-android:build`
4. `publishToMavenLocal`

Required app checks:

1. AGP 4 app builds through the legacy Transform backend.
2. AGP 7+ apps build through the modern ASM backend.
3. Built APKs install on a real Android device.
4. The runtime bridge status reports the expected version.
5. Apps that issue OkHttp requests produce `source = okhttp-auto` network records.

## Release Gate

Do not publish or push the release branch until all buildable validation apps pass, or until an app-specific environment blocker is explicitly accepted as out of scope.
