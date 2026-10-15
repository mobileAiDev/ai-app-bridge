# AI App Bridge Flutter

This source targets 0.4.10; registry publication is a separate step. Use a local path dependency before that version is published.

Flutter plugin for AI App Bridge. It exposes Flutter widget snapshots, runtime actions, structured logs, network records, state records, events, and H5 adapter registration so local AI agents can inspect, operate, verify, and iterate on Flutter apps on Android and iOS.

Agent-side MCP commands are discoverable through `capabilities`. Flutter UI uses
the `flutter` domain (`flutter-tree`, `flutter-nodes`, `flutter-action`,
`tap-flutter-text`, `input-flutter-text`, `scroll-flutter`); Flutter WebView/H5
adapters use the `webview` domain (`flutter-h5-*`); Flutter iOS evidence and
actions also appear under the `ios` domain (`ios-flutter-*`).

## Install

Install the stable Flutter package from pub.dev:

```sh
flutter pub add ai_app_bridge_flutter
```

To pin this release, use:

```yaml
dependencies:
  ai_app_bridge_flutter: 0.4.10
```

The plugin's Android debug variant includes the `0.4.10` Android runtime from
JitPack and starts the bridge server on the device. The iOS debug plugin starts
the Swift runtime from the app process. Release builds do not initialize the
Dart bridge and do not receive an Android SDK dependency from this plugin.
The iOS sources and C store are included in the Flutter package. Flutter's own
Swift Package Manager integration supplies its generated `FlutterFramework`
package; native iOS consumers use the separate repository-root Swift package.

## Initialize

```dart
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  AiAppBridge.instance.initialize(appName: 'your_app_name');
  runApp(const MyApp());
}
```

For automatic route names, reuse the provided observer without changing any
agent-side command:

```dart
MaterialApp(
  navigatorObservers: <NavigatorObserver>[
    AiAppBridge.instance.navigatorObserver,
  ],
)
```

UI observation is off by default. `ui-observation` (Android) or
`ios-ui-observation`, with `provider: "flutter"`, can open a 100–5000 ms window
for frame and pointer events. The returned lease expires locally; `stop` closes
it early using its `leaseId`. There are no periodic or animation-time layout
snapshots, even during a window. Frame events describe rendering, not semantic
changes. Tree commands pull a fresh snapshot through MethodChannel and release
their temporary Semantics handle afterwards. Status heartbeats do not scan UI.
Call `AiAppBridge.instance.shutdown()` when a debug harness tears down the engine.

## Opt-in Android profile builds (0.4.10)

This option is introduced in 0.4.10. Version `0.4.9` initializes the Flutter
bridge in debug only.

Android profile support is enabled by one Flutter build option:

```sh
flutter build apk --profile --dart-define=AI_APP_BRIDGE_PROFILE=true
```

Keep the same `initialize()` call and application source in both debug and
profile builds. The option enables Dart initialization in Android profile mode
and includes the matching Android runtime in the plugin's profile variant.
Omitting it, or setting it to `false`, leaves profile initialization disabled.
The option accepts exactly one `true` or `false` value. Debug remains enabled
by default. Release remains disabled even when the option is `true`.

Full snapshots report `app.mode` as `debug` or `profile`; public tree and node
results also carry `buildMode`. In profile mode,
`layout.widgetInspector` and `layout.widgetDump` return `ok: false`,
`error: "flutter_diagnostics_unavailable_in_profile"`, and
`reason: "debug_build_required"`. An empty diagnostic tree is not reported as
a successful observation. Secure-input suppression still applies. Operable
Element snapshots, target bindings, actions, H5 adapters and automatic capture
remain enabled; Semantics reports its actual collection result, which can be
unavailable in either build mode. Requesting operable scope still collects only
the operable source.

For add-to-app, pass the same option when generating the Flutter AAR:

```sh
flutter build aar --no-debug --no-release --dart-define=AI_APP_BRIDGE_PROFILE=true
```

Use that generated module's `flutter_profile` artifact and its generated
repository. The option must reach the Flutter build; setting a property only
on a later native-host build does not change an already compiled Dart AAR.
When a native host already supplies the Android SDK, use one matching SDK
version and normal Gradle dependency exclusions/substitution to avoid bundling
another SDK. The plugin's profile variant explicitly selects the Android SDK's
debug variant for local project dependencies. The host application's
`debuggable` setting is independent of Dart AOT and must satisfy the Android
SDK's runtime contract.

This option currently enables Android only. iOS profile builds remain disabled;
the bundled Swift runtime is compiled behind `DEBUG`. Profile measurements on
an emulator do not establish physical-device performance or compatibility with
every Flutter plugin and route. Keep debug builds for full framework diagnostics.

## Executing observed targets

Operable snapshots publish `targetSchema: "aab.flutter-target/v1"` and references
to live Elements. IDs remain stable when the same Element moves; replacement,
semantic changes and a new runtime invalidate old references. Empty EditableText
controls and real Scrollable containers are included in the operable tree.
Nested containers keep separate identities even when their bounds coincide.
Taps use the selected Element's current visible bounds, so a scroll ancestor's
center cannot redirect a label tap to an unrelated button.
Each scroll owner exposes its nodeId, axis, current pixels and available extents
(an unbounded extent is null); replacing its ScrollPosition invalidates old refs.

The Host binds these references for Intent and the public `tap-flutter`,
`input-flutter-text` and `scroll-flutter` commands. Select by exact text or an
observed node ID. The runtime rechecks the reference and current geometry before
dispatch. Input retains the exact editor/controller/focus across awaited frames
and updates that TextInputClient only. Multiple unfocused editors or multiple
implicit scroll containers are ambiguous; the runtime does not choose the first
editor or last scrollable.

Standard Material editors expose their own `labelText`, `hintText` and
`errorText` as optional `label`, `hint` and `errorText`; Cupertino editors expose
their `placeholder` as `hint`. Intent summaries preserve these declarations.
Choose the matching observed editor and use its node ID. Changing its label or
hint invalidates the old target; a validation message alone does not change its
identity. Custom label widgets and canvas content require App semantics.

Operable text excludes transparent TextSpan content, including inherited text
styles. Controls beneath zero-opacity Opacity or FadeTransition widgets are not
operable. Inspector diagnostic strings are never substituted for visible text.
These checks do not establish visibility through arbitrary shaders or native
system overlays.

Bound taps cancel their pointer stream if the target changes before UP. The
runtime serializes action requests and reports busy, invalid target, changed
focus and scroll-boundary errors explicitly. Arbitrary App callbacks are not
transactions. Android and iOS advertise `aab.flutter-execution/v1`: Native owns admission
and the deadline, Dart checks before new mutations, and a cancellation receipt
waits for the original execution to settle. Pointer timing stays local so a
transport wait cannot turn a tap into a long press. Cancelled owned waits send
CANCEL; an opaque App future remains occupied until completion. If settlement
cannot be confirmed, the SDK returns an ambiguous pending result and keeps
admission closed. Host never treats a closed socket as successful cancellation.
This contract requires matching Native SDK and Flutter plugin sources. On iOS,
the asynchronous plugin uses `executeAction`, `checkAction` and `cancelAction`;
unmanaged `runAction` is rejected. Native persists the original completion in its
segmented disk store before releasing admission. Host keeps unknown actions under
physical UDID ownership, and `ios-execution reconcile` queries the original receipt
without replay. A detached engine cannot clear a newer handler registration.
The iOS integration has software tests, an arm64 compile gate and a fixed
[Flexify Intent/Script business acceptance](../../docs/IOS_FLUTTER_BUSINESS_2026-09-11.md).
That evidence covers the documented workout flow, not arbitrary Apps or the whole
device. No receipt rolls back App effects.

## WebView Adapter

Flutter WebView DOM support requires a registered H5 adapter because the WebView controller lives in Dart:

```dart
AiAppBridge.instance.registerH5Adapter(
  AiAppBridgeH5Adapter(
    id: 'main-webview',
    source: 'webview_flutter',
    evaluateJavascript: (script) {
      return controller.runJavaScriptReturningResult(script);
    },
  ),
);
```

AI App Bridge is intended for debug builds and explicit Android profile test
builds. Do not expose runtime control surfaces in production builds without a
deliberate security review.

## iOS Notes

Flutter iOS support uses two layers:

- The Flutter plugin publishes widget/action snapshots to `AiAppBridgeIOS`.
- The desktop CLI/MCP uses WebDriverAgent/XCUITest for full-control device actions such as tap, input, swipe, permission dialogs, screenshots, and external UI tree reads.

The published Flutter package contains the iOS Swift runtime sources used by the plugin, so Flutter apps only need the pub dependency. Native iOS apps can use the separate SwiftPM package from the GitHub repository.
