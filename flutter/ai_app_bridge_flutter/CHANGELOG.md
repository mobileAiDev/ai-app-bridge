# Changelog

## 0.1.10

- Uses Android runtime 0.1.9 for debug builds, including the native
  Unicode-safe `/v1/action/input-text` bridge endpoint.

## 0.1.9

- Preserves string values with spaces when Flutter capture APIs forward
  `recordState`, `recordLog(data)`, and `recordEvent(data)` through the Android
  MethodChannel bridge.

## 0.1.8

- Uses Android runtime 0.1.8 for debug builds.
- Skips obvious non-text OkHttp request/response bodies in automatic capture.
- Filters Flutter runtime targets through viewport and hit-test reachability so
  stale/off-route widget nodes are not tapped after navigation.

## 0.1.7

- Uses Android runtime 0.1.7 for debug builds.
- Enables debug-only WebView DevTools/CDP observability through the Android runtime.

## 0.1.6

- Uses Android runtime 0.1.6 for debug builds.
- Keeps OkHttp auto capture active for consumer app packages while excluding only bridge runtime/plugin internals.

## 0.1.5

- Automatically includes the Android debug runtime from the Flutter plugin's Android debug variant.
- Lowers the Android runtime minimum SDK to 21.
- Broadens the package SDK constraint to Dart 3.0+ / Flutter 3.10+.
- Documents that Flutter apps should call `WidgetsFlutterBinding.ensureInitialized()` before bridge initialization.

## 0.1.4

- Aligns the Flutter package version with the Android bridge and desktop CLI 0.1.4 release.
- Updates package metadata for the public 0.1.4 release.

## 0.1.0

- Initial Flutter plugin release for AI App Bridge.
- Adds widget snapshot, runtime action, log, network, state, event, and H5 adapter bridge APIs.
