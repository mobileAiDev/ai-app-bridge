# Optional UI executors (0.3.8)

Bridge keeps its existing SDK paths and exposes optional executors through `capabilities`, `run`, and JavaScript/Python Script. Select an executor explicitly. No command silently changes a touch into a setter, switches framework after failure, or repeats an uncertain action.

## What is installed

| Capability | Dependency location | Integration requirement |
| --- | --- | --- |
| Android UI Automator / Espresso | Application **androidTest** dependencies and its generated test APK | Small precompiled test entry; matching installed application and test packages |
| Android WebView H5 | Optional `ai-app-bridge-test-espresso-web` in androidTest | JavaScript already enabled by the application; explicit WebView and frame selection |
| Android Compose | Optional `ai-app-bridge-test-compose` in androidTest | Application-matched Compose test runtime and a JUnit rule surrounding the session |
| Flutter WidgetTester | `ai_app_bridge_test` in **dev_dependencies**, using Flutter SDK test packages | Debug APK built from `integration_test/bridge_test.dart` |
| Web Playwright | CLI-managed directory outside the page SDK | Explicitly prepare the pinned Playwright package and matching browser |
| iOS | Existing WDA / XCUITest integration | Existing signing, device and WDA prerequisites; no new iOS executor in this version |

These dependencies are isolated from ordinary production source sets. They are visible in build metadata and diagnostics. They do not disappear from the installation or compatibility requirements. Android does **not** need a separate business App, repository, or Gradle project. The standard test APK is an Android test artifact.

## Automatic preparation in the existing project

Use `executor-prepare` from CLI, MCP `run`, or JavaScript/Python `ctx.call` with `app.test`. This is a Host operation: it does not require a device target, install an App, start UI observation, or open an executor session. Preparation uses the selected project's existing toolchain and keeps its application ID. The result separates preparation from installation and session readiness.

```sh
ai-app-bridge executor-prepare --platform android --project-dir /project \
  --module :app --variant debug --adapters '["espresso-web"]'
ai-app-bridge executor-prepare --platform flutter --project-dir /flutter-app \
  --flutter-path /flutter-sdk/bin/flutter
ai-app-bridge executor-prepare --platform ios
ai-app-bridge executor-prepare --platform web --browser chromium
```

- Android: a temporary Gradle init script adds the test dependencies and a generated session class only for this invocation. The dependency-check plugin is applied automatically. The result contains the actual application ID, instrumentation component, test class, APK paths and SHA-256 values. Existing matching test dependencies/runners are reused; conflicting Bridge test dependencies are rejected. Business Gradle, manifest and source files are not edited. Select the actual module and debuggable variant; flavors and APK splits retain their original identities. The current build integration uses the AGP 7.4–8.x variant API on macOS/Linux; AGP 9 and Windows preparation are not part of this profile. A local `file:` Maven `repositoryUrl` can explicitly select development artifacts; ordinary preparation resolves the same release version from JitPack.
- Flutter: the command runs the project's selected Flutter executable, adds the exact `ai_app_bridge_test` version to `dev_dependencies` with Pub, and generates a test entry under `build/ai-app-bridge`. It supports Pub workspaces, an explicit `entrypoint`, `flavor`, `dartDefines`, and `mainArguments` for applications whose main accepts a string list. Pubspec/lock changes are visible configuration; the result lists them. Main Dart code is not edited. The helper uses the same Flutter SDK as the App. Baseline resolution uses `pub get --enforce-lockfile`: commit a valid application/workspace lockfile first. This prevents dependency changes before comparison, including on a new computer. If adding the helper changes an existing production dependency version or Pub fails midway, preparation restores the pubspec/lock and reports the conflict or original error. A successful dependency solve is followed by a real debug build. Repeated preparation reuses the exact resolved helper. `testPackagePath` explicitly selects a local helper during development and must carry the matching Bridge version. The current WidgetTester host remains Android-only; iOS Flutter controls use the existing iOS Flutter SDK/WDA paths.
- iOS: checks Xcode and prepares a pinned WDA project in the managed executor directory. Source hashes are verified before reuse. `ios-setup --start-wda` reuses that project to sign, build and launch the Runner for the explicitly selected phone. Xcode, signing credentials, device trust and Enable UI Automation are still required. No XCTest source is added to the business application.
- Web: uses the existing pinned Playwright/browser preparation, outside the page SDK. It can be reused without modifying the web project or adding browser dependencies to its production bundle.

Generated files and logs are placed under the project's `build/ai-app-bridge/prepare/<id>`; each preparation writes `result.json`, including failures. Mobile preparation reports `built-not-installed` (iOS source preparation reports `source-prepared`). Install the returned matching artifacts with the public install commands, then open the selected executor. JS/Python workflow changes do not require rebuilding an already prepared App; changes to application code or test dependencies do.

Installing the npm package alone does not install Android SDK/JDK, Flutter, Xcode, Python, or project-specific tools such as Rust. Preparation reports the missing prerequisite or original compiler log; it never upgrades a business toolchain to hide a conflict.

Android uses the project's Gradle wrapper. For a monorepo that shares a wrapper outside `projectDir`, pass its exact path as `--gradle-path /path/to/gradlew`. Existing matching test dependencies and a custom test runner are retained. Installing a generated androidTest APK does not require it to declare an application version; manifest package, signature and installed APK bytes are still verified.

Android WebView H5 requires the optional `espresso-web` adapter and the application's existing JavaScript configuration. iOS WKWebView uses the existing bound H5 SDK path. Playwright manages browser pages; it is not silently used as the controller for a native App's embedded WebView.

## Android: optional manual customization

Automatic preparation generates the entry and dependencies below. Add them manually only when the project needs custom test rules or adapters. All Bridge artifacts use the same version:

```kotlin
android {
    defaultConfig {
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
}
dependencies {
    androidTestImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-test-instrumentation:0.3.8")
    // Optional H5 adapter:
    androidTestImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-test-espresso-web:0.3.8")
}
```

Place this tiny entry in the existing `app/src/androidTest/java/...` directory:

```java
package example.app;
import io.github.mobileaidev.aiappbridge.executor.instrumentation.AndroidExecutorTest;
public final class BridgeSessionTest extends AndroidExecutorTest {}
```

This is a precompiled, long-running JUnit test. Host passes the session identity, token, Activity and lease as Instrumentation arguments. The test thread executes incoming commands serially. Python/JS scripts do not become Kotlin/Java source and do not require rebuilding for each workflow. You may extend the test's `adapters()` and add ordinary JUnit rules or idling resources. Arbitrary business field reflection and arbitrary existing `@Test` method invocation are not exposed as remote commands.

Opening a session **restarts and instruments the target application**. Install the matching main and test APKs built from this application first:

```sh
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
adb -s DEVICE install -r -t app/build/outputs/apk/debug/app-debug.apk
adb -s DEVICE install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
ai-app-bridge android-executor --operation status --serial DEVICE
ai-app-bridge android-executor --operation open --serial DEVICE \
  --package-name example.app \
  --instrumentation example.app.test/androidx.test.runner.AndroidJUnitRunner \
  --test-class example.app.BridgeSessionTest --activity example.app.MainActivity
```

Use the actual installed component names returned by `status`. Supply the returned `sessionId` and `runtimeEpoch` to subsequent operations. `observe` requires an `engine` listed in `open.capabilities.adapters`. `act` requires the current `snapshotId` and a `nodeId` from that observation. Changing adapters invalidates the previous snapshot.

The instrumentation artifact includes `uiautomator` and `espresso`. Add H5 in `adapters()` with `adapters.put("espresso-web", new EspressoWebExecutor())`, after obtaining `super.adapters()`. H5 observation accepts `webView: {by:"description",value:"..."}` or `resourceId`, and `framePath: [{name:"..."}]` or `{index:0}` entries. An unspecified WebView must match exactly one WebView. JavaScript is not automatically enabled. `webClick`, `webKeys`, `webClear` and `webScrollIntoView` use WebDriver JavaScript atoms, not Android IME or physical touch. Open Shadow DOM and cross-origin frame support must be checked for the concrete WebView; closed Shadow DOM is not advertised.

## Dependency checks and Compose

Apply `io.github.mobileaidev.aiappbridge.test` from the same Gradle plugin artifact. It only validates resolved dependencies; it adds no UI bytecode instrumentation and does not rewrite versions. With JitPack, map this plugin ID in `pluginManagement.resolutionStrategy.eachPlugin` to `com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-gradle-plugin:<requested version>`, as for the existing `io.github.mobileaidev.aiappbridge.android` plugin. Include JitPack, Google Maven and Maven Central in the appropriate repositories.

The initial Android adapter profile is runner **1.7.0**, Espresso / Espresso-Web **3.7.0**, UI Automator **2.4.0**, Java **11**, minSdk **23**, compileSdk **35**. The source build uses AGP **8.9.1** and JDK **17**. This is a supported profile, not a promise that every old Gradle/AGP combination can consume the artifacts.

Compose is optional and its runtime is supplied by the consumer. The initial Compose adapter profile is **1.8.3**. Apply the application's **same Compose BOM** to its main/debug and androidTest dependencies, then add `ui-test-junit4` without an independent version. The plugin rejects a different main/test Compose runtime or an unvalidated adapter profile. It does not upgrade an application's Kotlin, Compose, AGP or compileSdk to make the check pass. An application outside this profile can keep the existing SDK/UI Automator route or provide a separately validated adapter build.

```java
@Rule public final ComposeTestRule compose =
    AndroidComposeTestRule_androidKt.createEmptyComposeRule();
@Override protected Map<String, ExecutorAdapter> adapters() {
    Map<String, ExecutorAdapter> adapters = super.adapters();
    adapters.put("compose", new ComposeExecutor(compose));
    return adapters;
}
```

The rule must start **before** Activity/composition creation. The adapter uses automatic test clock advancement and idle frame ticks; animation timing is not wall-clock fidelity. `click` uses Compose touch input; `composeInput`, `composeReplaceText`, `composeClearText`, scroll semantics and `semanticLongClick` are explicit semantics operations. WebView/platform Views and system dialogs require their corresponding adapters. No private Compose field reflection is used by Bridge.

Espresso text actions have different semantics. `replaceText` is the framework's setter path; a custom editor can deliberately suppress its business listeners, so an immediate text readback is insufficient. `replaceTextViaInputConnection` explicitly selects the editor's full text and commits through its `InputConnection`, reporting `espresso-input-connection`. It supports Unicode when the editor accepts that connection and does not fall back to a setter. `typeText` injects key input and has the framework's keyboard character limits. Reopen the screen and check persisted application state for all three paths; none alone proves a physical keyboard/IME workflow. Espresso observations include checked state for `Checkable` widgets.

## Flutter

Add `ai_app_bridge_test: 0.3.8` to the application's `dev_dependencies`. The helper takes `flutter_test` and `integration_test` from the **same Flutter SDK** as the application. It is a Dart test helper, not an additional Android plugin with its own AGP/Kotlin versions.

The helper declares Flutter **>=3.41.0** and Dart **>=3.11.0 <4.0.0**. The 0.3.8 automatic preparation was exercised with LocalSend on Flutter **3.41.9 / Android API 36**, preserving all 214 production dependency versions. Earlier executor validation covered Flutter 3.41.9 / API 25 and 3.44.8 / API 36. These are specific verified combinations; other SDK versions still need validation with the application's plugin graph.

```dart
// integration_test/bridge_test.dart
import 'package:ai_app_bridge_test/ai_app_bridge_test.dart';
import 'package:your_app/main.dart' as app;
void main() => aiAppBridgeTest(app.main);
```

```sh
flutter build apk --debug --target integration_test/bridge_test.dart \
  --dart-define=INTEGRATION_TEST_SHOULD_REPORT_RESULTS_TO_NATIVE=false
adb -s DEVICE install -r -t build/app/outputs/flutter-apk/app-debug.apk
ai-app-bridge flutter-executor --operation open --serial DEVICE \
  --package-name example.app --activity example.app.MainActivity
```

This version supports the standard **Android Flutter embedder**, with its normal application private cache directory. Launch configuration and original receipts use `no_backup/ai-app-bridge-integration`, outside evictable caches. Opening restarts the test-entrypoint app. Closing drains the tester queue and terminates only the original process, identified by boot ID, PID and process start time. The helper uses a fully live frame policy. `tap`, `longPress`, drag/fling, `ensureVisible`, `pageBack`, `pump` and `enterText` are exposed. `enterText` changes Flutter editing state and reads it back; it does not prove native IME input. Flutter platform views, WebView DOM and system dialogs require another applicable provider. Flutter iOS/desktop/web test-host launch is not implemented by this helper.

## Web

```sh
ai-app-bridge web-executor --operation status --browser chromium
ai-app-bridge web-executor --operation prepare --browser chromium --timeout-ms 300000
ai-app-bridge web-executor --operation open --url http://localhost:3000 --browser chromium
```

The CLI manages exact Playwright **1.63.0**, an included npm lock file and matching browser downloads. `prepare` is explicit; normal SDK usage does not download browsers. Cache keys include the dependency lock digest, OS and CPU architecture. Node **26.3.x** is the verified Host baseline (`>=26.3.0 <27` contract). Browser preparation is serialized and reports failures. `status` separates the static version from actual executable availability.

`observe` returns pages and documents. Pass the observed `targetId`, `frameId` and `documentId` to actions/waits. A navigation during automatic waiting cannot move an old command into the replacement document. Selectors must be unique; role names and text matching are exact. `css` accepts standard CSS syntax, not Playwright selector chains. Actions include click, doubleClick, hover, fill, type, press, check, select, drag, scrollIntoView and upload. Physical `wheel` is not exposed: Playwright's page mouse API cannot bind the event atomically to the observed document. It is never replaced with a synthetic DOM event. Dialogs default to dismiss; an action may explicitly request accept/dismiss. Browser dialogs, popup pages, open Shadow DOM and iframe observations are supported; native OS dialogs and closed Shadow DOM are outside this executor.

Control `text` contains the element's `innerText`, preserving an empty string. It is `null` for elements without `innerText`; hidden `textContent` is not substituted. Each action ID occupies one slot across all pages in the session. Reusing it on another page is rejected with `executor_receipt_identity_mismatch`; changing other action arguments is rejected with `idempotency_conflict`.

## Agent, Python and JS contract

Discover only the operation needed:

```json
{"command":"android-executor","operation":"act"}
```

This is a `capabilities` selection, not an action. Execute through the existing `run` tool, or `ctx.call` in Script with **`app.test`** permission. Script targets remain `platform:"android"` for Android/Flutter Android, and `platform:"web"` for browser sessions. Device/package targeting is inherited from the Script target; session identities are explicit inputs.

```javascript
// Within module.exports.main = async ctx => { ... }
const reply = await ctx.call('android-executor', {
  ...ctx.inputs.identity, operation: 'observe', engine: 'espresso'
});
if (!reply.ok || !reply.result.ok) throw new Error(JSON.stringify(reply));
const observation = reply.result.observation;
const buttons = observation.nodes.filter(n => n.text === 'Submit');
if (buttons.length !== 1) throw new Error('Expected exactly one Submit button');
const result = await ctx.call('android-executor', {
  ...ctx.inputs.identity, operation: 'act', snapshotId: observation.snapshotId,
  actionId: 'submit-once', action: {type: 'click', nodeId: buttons[0].nodeId}
});
if (!result.ok || !result.result.ok) throw new Error(JSON.stringify(result));
```

```python
reply = ctx.call('flutter-executor', {**ctx.inputs['identity'], 'operation': 'observe'})
assert reply['ok'] and reply['result']['ok'], str(reply)
observation = reply['result']['observation']
nodes = [n for n in observation['nodes'] if n.get('key') == 'submit']
assert len(nodes) == 1
result = ctx.call('flutter-executor', {
    **ctx.inputs['identity'], 'operation': 'act',
    'snapshotId': observation['snapshotId'], 'actionId': 'submit-once',
    'action': {'type': 'tap', 'nodeId': nodes[0]['nodeId']}
})
assert result['ok'] and result['result']['ok'], str(result)
```

An action receipt means the framework call ended, not that a payment/order/business transaction succeeded. Observe again and assert the independent business result. Do not reuse stale snapshots or change an action's mechanism after a failure without a new decision.

## Cancellation, recovery and lifecycle

- One test thread / browser worker serializes UI effects. Native device effects use the shared device ownership contract. UI Automator and the legacy UIA runtime cannot own Android UiAutomation simultaneously; the Host drains and hands over the connection explicitly.
- `timeoutMs` requests cancellation; it does not prove rollback. Already executing framework work must return its original receipt or the original process must be confirmed ended. An unsettled WebView atom ends the test session. No replacement action starts against an unresolved device effect.
- The same `actionId` with identical arguments returns its original receipt. A changed request is rejected. An unresolved receipt is never redispatched. Deduplication is session-scoped; it is not universal exactly-once business execution across process loss or new sessions.
- `receipt` remains readable after normal close. Host restart can recover Android/Flutter descriptors and read retained device records; a lost browser worker's original receipts remain readable, but its live browser session cannot be resumed.
- Use explicit `close` for normal teardown. Android/Flutter tests also have an idle lease (default 10 minutes, selectable 10 seconds–1 hour). Host loss preserves original state for recovery; it does not erase unresolved ownership. Run `device-ownership --operation reconcile --serial DEVICE` when required by the error. A closed Flutter test may require reconciliation/close to end its original app process.
- Each session permits at most 4096 action receipts, with bounded request/response and observation sizes. Receipts are retained for audit; storage is not automatically deleted across sessions. Operators must archive/remove closed session artifacts according to their retention policy. Never remove an unresolved session's records to bypass a device lock.

## Performance evidence

On the same API-36 device, sample APK, Activity, counter button and Instrumentation lifetime, 20 effective samples per path (two warmup rounds excluded) alternated Espresso touch and the existing SDK touch. Both included Host persistence and the same Espresso observations before/after every action. Every counter increment was verified.

| Metric (ms) | Espresso | Existing SDK touch |
| --- | ---: | ---: |
| Median action | 362 | 314 |
| Action p95 | 397 | 345 |
| Median action + before/after observation | 413 | 359 |

This does not establish a general speedup. Startup, dependency preparation, screenshots, model time and CLI process startup are excluded and must be reported separately. Semantics/setter input is a different operation from physical keyboard/IME input; its shorter duration cannot establish an equivalent-interaction speedup.

The version's local verification and publication status are recorded in the repository delivery report. Local artifact checks are separate from public registry publication and real customer workflow acceptance.
