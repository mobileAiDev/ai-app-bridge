# mobileAiDev Migration Design

## Goal

Move the current public identity of AI App Bridge to `mobileAiDev/ai-app-bridge`
while leaving old published packages and git history intact.

The migrated default branch should not show the former personal identity
strings in the current source tree, landing documentation, package names, sample
package names, or future dependency snippets.

## Non-goals

- Do not rewrite git history.
- Do not delete or unpublish old npm, JitPack, pub.dev, or GitHub release
  artifacts.
- Do not add compatibility aliases for old package names inside the new runtime.
- Do not change bridge runtime behavior except where package names, plugin ids,
  artifact coordinates, or version metadata must change.

## New public coordinates

| Surface | New value |
| --- | --- |
| GitHub repository | `mobileAiDev/ai-app-bridge` |
| JitPack Android runtime | `com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android` |
| JitPack Gradle plugin module | `com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-gradle-plugin` |
| Android/Gradle package prefix | `io.github.mobileaidev.aiappbridge` |
| Gradle plugin id | `io.github.mobileaidev.aiappbridge.android` |
| Flutter pub package | `ai_app_bridge_flutter` |
| npm package | `@mobileaidev/ai-app-bridge` |
| Android sample app id | `io.github.mobileaidev.aiappbridge.sample` |

The first migrated release version is `0.2.0`. Older `0.1.x` packages remain
available under their existing coordinates.

The Flutter pub package name stays `ai_app_bridge_flutter` because it does not
contain the former personal identity. Its version, repository metadata, issue
tracker metadata, Android package name, and debug Android runtime dependency are
updated for the `mobileAiDev` release.

## Required code changes

1. Rename Android runtime Kotlin packages and source directories to
   `io.github.mobileaidev.aiappbridge.android`.
2. Rename Gradle plugin Java packages and source directories to
   `io.github.mobileaidev.aiappbridge.gradle`.
3. Rename Flutter Android plugin Kotlin packages and source directories to
   `io.github.mobileaidev.aiappbridge.flutter`.
4. Update the Android manifest provider class name.
5. Update the Gradle plugin id, implementation class, Maven group, and version.
6. Update the OkHttp ASM hook owner and package exclusion prefixes. This is a
   functional requirement because the class visitor uses JVM internal names.
7. Update Flutter plugin metadata, Android debug dependency, reflective runtime
   class name, and package version.
8. Update CLI package metadata, README snippets, default sample package, and
   npm package version.
9. Update sample app package names and imports.
10. Scrub current documentation examples that still contain old package names,
    old GitHub owner names, old npm package names, or local paths that expose the
    old identity.

## Validation gates

Before publishing:

1. A case-insensitive scan for the former personal identifiers returns no
   current source-tree matches outside `.git`.
2. `node -c desktop/ai-app-bridge-cli/bin/ai-app-bridge.js`
3. `node -c desktop/ai-app-bridge-cli/bin/mcp-server.js`
4. `cd desktop/ai-app-bridge-cli && npm test`
5. `cd desktop/ai-app-bridge-cli && npm pack --dry-run`
6. `./gradlew --no-daemon :ai-app-bridge-android:build :ai-app-bridge-gradle-plugin:build`
7. `cd examples/android-native-sample && ./gradlew --no-daemon :app:assembleDebug`
8. `cd flutter/ai_app_bridge_flutter && flutter pub get`
9. `cd flutter/ai_app_bridge_flutter && flutter analyze`

After publishing:

1. Verify JitPack POM/AAR/JAR endpoints for `0.2.0`.
2. Verify `npm view @mobileaidev/ai-app-bridge version dist-tags --json`.
3. Install the new npm package globally and verify `ai-app-bridge --help`.
4. Validate at least one clean Android consumer resolves the new JitPack
   runtime coordinate.

## Manual prerequisites

- The GitHub repository `https://github.com/mobileAiDev/ai-app-bridge` must
  exist and the local git credential must have push permission.
- The npm scope `@mobileaidev` must exist or belong to a user account, and the
  npm token used for publishing must have permission to publish
  `@mobileaidev/ai-app-bridge` with public access.
- The npm token must not be committed, written to project files, or included in
  migration logs.
