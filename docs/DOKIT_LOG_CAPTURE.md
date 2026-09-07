# DoKit log capture vs AI App Bridge

Primary sources: [didi/DoKit](https://github.com/didi/DoKit) `master` @ `626827cddb2feb2f3aee87a52a064b4e5ca2bed4`.

## Android DoKit

Not a `Log.d` / Timber bytecode hook. The Log kit starts an in-process logcat dump and keeps lines for the current pid. `DoKitReal.install` returns unless it is the main process. Only the `main` buffer is opened.

- Click path: `LogInfoKit.onClickWithReturn` → `LogInfoManager.start()`  
  https://github.com/didi/DoKit/blob/master/Android/dokit/src/main/java/com/didichuxing/doraemonkit/kit/loginfo/LogInfoKit.kt
- Init default: `LogInfoConfig.setLogInfoOpen(false)`  
  https://github.com/didi/DoKit/blob/master/Android/dokit/src/main/java/com/didichuxing/doraemonkit/config/LogInfoConfig.java
- Reader: `RuntimeHelper.exec(["logcat", "-v", "time"])` via `LogcatHelper`  
  https://github.com/didi/DoKit/blob/master/Android/dokit/src/main/java/com/didichuxing/doraemonkit/kit/loginfo/helper/LogcatHelper.java
- Filter: `logLine.getProcessId() == Process.myPid()`  
  https://github.com/didi/DoKit/blob/master/Android/dokit/src/main/java/com/didichuxing/doraemonkit/kit/loginfo/LogInfoManager.java

`DOKIT_LOG_SWITCH` in gradle.properties is the Gradle plugin's own log, not app Log capture.

## iOS DoKit

fishhook rebind of `NSLog`. Not `os_log`, not stderr.

- `doraemon_rebind_symbols({"NSLog", myNSLog, &old_nslog})`  
  https://github.com/didi/DoKit/blob/master/iOS/DoraemonKit/Src/Core/Plugin/Common/NSLog/Function/DoraemonNSLogManager.m
- Starts only if cached `nsLogSwitch` is on (`DoraemonManager` install)  
  https://github.com/didi/DoKit/blob/master/iOS/DoraemonKit/Src/Core/Manager/DoraemonManager.m
- Optional CocoaLumberjack kit (`DoraemonWithLogger`) is a separate logger hook, not system log.

This hook has crashed on iOS 15+ (fishhook / `vm_protect`); see issues 927, 1069, 1209.

## Flutter DoKit

`DoKit.runApp` defaults to `runZonedGuarded` and intercepts `ZoneSpecification.print` (Dart `print`), plus zone errors. That is not `debugPrint`, not `android.util.Log`, and not `NSLog`.

https://github.com/didi/DoKit/blob/master/Flutter/lib/dokit.dart

Optional iOS Weex (`WithWeex`) registers an external Weex logger at install. Web Console plugin replaces `window.console.*` when that plugin loads.

Live GET `/v1/logs`, `/v1/network`, `/v1/state`, and `/v1/events` read `MobileCaptureStore` on the phone. Host does not copy those payloads into live history. MCP `history:true` on those streams reads the phone FactStore while connected; disconnect returns `target_disconnected` and does not fall back to a Host-copied payload.

## AI App Bridge today

| Path | What it is | Default |
| --- | --- | --- |
| `recordLog` / POST `/v1/logs` | Explicit API | Only if the app calls it |
| Flutter `debugPrint` / `FlutterError` | Dart hook in debug | On when Flutter SDK `initialize` runs |
| Host `deviceLogScope=device` | `adb logcat` into `device-log` | Off |
| In-app `logcat` process | DoKit Android style | Not implemented |
| `NSLog` fishhook | DoKit iOS style | Not implemented |

Turning `deviceLogScope=device` on by default uses a capability we already have: host-side logcat while MCP observation is running. It is the same *kind* of source as DoKit Android (logcat text), not the same *place* (PC + adb vs in-app `Runtime.exec`). It does not add iOS `NSLog` capture.
