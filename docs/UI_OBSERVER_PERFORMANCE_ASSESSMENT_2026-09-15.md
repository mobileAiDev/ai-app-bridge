# UI 观察性能修复与跨平台合同（2026-09-15）

本轮已修改 SDK 和 Host：持续 UI 观察默认关闭，显式申请的观察窗口最长 5 秒，到期由设备/页面自身释放；SDK 启动、Activity 恢复、Host 心跳、Script 等待期间均不自动打开。业务扫码与重复请求不在本次范围。

## 同机复现与修复后证据

设备 OnePlus PKR110，Android 16 / API 36，序列号 `b46093e6`。使用独立 androidTest APK（`io.github.mobileaidev.aiappbridge.android.test`），同一个 Activity、600 行文本及一个小型绘制指示器，实际指纹仍覆盖上限 600 节点。未减少节点/深度预算，未关闭 SDK 其余日志或改设备动画设置，未录屏，未操作收银 App。

每段约 4.2 秒，使用交错时间间隔采样 40 次。CPU 是主线程 CPU 时间 / 经过时间，不是整机 CPU；队列等待是提交轻量回调到主线程的延迟，不是物理触摸耗时。

| 实验状态 | 修复前主线程 CPU | 最终修复后主线程 CPU | 主线程队列等待 p95（前 → 后） |
| --- | ---: | ---: | ---: |
| 小型动画，观察开启 | 69.2% | 21.6% | 68.8 → 1.1 ms |
| 相同动画，观察关闭 | 12.6% | 11.0% | 1.6 → 1.1 ms |
| 相同动画，再次开启 | 73.6% | 21.6% | 63.5 → 38.1 ms |
| 静止页面，观察开启 | 22.2% | 1.6% | 65.0 → 0.6 ms |
| 静止页面，观察关闭 | 2.3% | 0.35% | 0.6 → 0.6 ms |

7 次独立指纹调用中位数：**48.8 → 9.0 ms**。两段动画开启期仍有最高约 42–50 ms 的单次采样，不能宣称每次扫描都低于一帧预算。默认不采样是主要保护，主动窗口内还有按实际耗时降低频率的措施。

基线在同一手机上超过 25% 主线程 CPU 阈值，Instrumentation 断言失败；最终两段开启期均约 21.6%，断言通过。默认关闭、窗口过期、再次触发 resumed 后不自动重开的断言通过。静止关闭态的进一步下降包含移除原先每 500 ms 查找 WebView 的常驻任务。

- [基线原始样本](../build/ui-observer-performance/controlled.json)、[基线失败输出](../build/ui-observer-performance/controlled-instrumentation.txt)
- [最终原始样本](../build/ui-observer-performance/final.json)、[最终指标](../build/ui-observer-performance/final-summary.json)、[最终通过输出](../build/ui-observer-performance/final-instrumentation.txt)
- [真实 SDK HTTP / H5 合同测试输出](../build/ui-observer-performance/contract-instrumentation.txt)
- [最终 Android 源码与 APK SHA-256](../build/ui-observer-performance/final-sha256.txt)

这是受控诊断页面的结果，不能外推为所有 App、低端终端或 iPhone 的固定耗时。

## iPhone 真机验证

设备 iPhone 17 Pro Max，iOS 27.0，设备 ID `D56383E2-7854-5020-AFCE-8441A9C97193`。诊断页包含 600 个 UILabel 和一个真实 WKWebView，SDK 保持原有 240 节点上限。使用 Debug 构建，通过真实 SDK HTTP 端点开关窗口，不依赖 WDA 或 XCTest 的 UI 自动化授权。

| 修复后的同页状态 | 主线程 CPU | 测量期新增采样 |
| --- | ---: | ---: |
| 标签动画，开窗 | 10.2% | 18 |
| 同一动画，关闭 | 1.0% | 0 |
| 同一动画，再开窗 | 9.8% | 17 |
| 静止页面，开窗 | 6.4% | 18 |
| 静止页面，关闭 | 0.014% | 0 |

每段约 3.5–3.7 秒，主线程 CPU 通过 Mach `THREAD_BASIC_INFO` 的 user/system 累计时间计算。数值包含诊断页自身工作，不是整个 App 的所有线程或整机 CPU。这里比较修复版的开/关状态，**没有把它写成旧版 iOS 的前后优化比例**。主动窗口内单次采样最高约 20 ms，仍不承诺所有采样均在一帧内完成。

本轮通过默认零采样、状态心跳不扫描、时长/所有者约束、真实 UILabel 变化的语义事件、无人清理时自动到期、到期后不再扫描，以及 WKWebView console 原函数恢复。后台清理使用 `didEnterBackground` 通知注入验证，并验证 `didBecomeActive` 通知不重新开窗；这不等于真实 Home/锁屏切换验收。iOS 原生通道还验证了 Flutter handler 的按需调用和新旧 revision；该 handler 用例本身不是 Dart 运行时测试。

免费签名名额已满，因此诊断页临时复用了已有 Flexify 测试包身份；原签名 App 已先备份并校验，两个诊断页运行结束后已恢复原 App。诊断前后的 SQLite 主文件 SHA-256 一致，该校验不包含 WAL 或 Keychain。恢复包保留了它原有的 SDK 版本，本次未将修复发布到原测试 App。

- [真机结果与逐项断言](../build/ui-observer-ios-device/result.json)、[运行输出](../build/ui-observer-ios-device/run.log)
- [诊断页源码](../ios/ai-app-bridge-ios/validation/UiObserverDeviceProbe.swift)、[源码和实际二进制 SHA-256](../build/ui-observer-ios-device/source-and-binary-sha256.txt)
- [SQLite 主文件保留核对](../build/ui-observer-ios-device/database-preservation.json)

## 真实 Flutter/iOS 通道验证

在同一 iPhone 上运行 Flutter 3.44.8 / Dart 3.12.2 的独立诊断页，直接依赖当前工作树中的 Flutter SDK。页面有 300 行文字和持续动画，通过 `HTTP → iOS SDK → Flutter MethodChannel → Dart` 验证，31 项断言通过：

- 默认没有自动发布的 layout；动画运行期间原生采样仍为零，Flutter 观察也关闭。
- 显式取树先读到 `20.00`，修改 Widget 后再次取树读到 `21.00`；两次读取后 Semantics 都恢复到原先的关闭状态。
- 等待超过旧版 1.2 秒周期并读取状态，快照更新时间没有自动变化，状态中不包含缓存 layout。
- 开窗后得到 10 条真实 Flutter UI 帧事件；错误所有者及并发开窗被拒绝。窗口自行到期后，动画继续运行，但后续查询不再收到新的观察事件。
- 匹配所有者可以提前关闭窗口；完成时没有遗留的强制 Semantics。

这里只验证观察和取树链路，没有把 Flutter 帧事件当成业务成功证据，也没有声称测出了 Flutter 整体 CPU 的优化比例。第一次诊断客户端使用了 SDK 合同不接受的 chunked POST；修正诊断客户端为显式 Content-Length 后完成上述验证，SDK HTTP 解析规则未改变。

- [Flutter 真机结果](../build/ui-observer-flutter-device/result.json)、[诊断源码](../flutter/ai_app_bridge_flutter/validation/ui_observer_device_probe.dart)
- [实际构建使用的 Dart / 二进制 SHA-256](../build/ui-observer-flutter-device/source-and-binary-sha256.txt)、[诊断客户端第一次失败](../build/ui-observer-flutter-device/result-client-framing-failure.json)

## 各平台具体改动

| 平台 | 原先的常驻工作 | 现在的行为 |
| --- | --- | --- |
| Android | resume 后挂观察；绘制触发整树指纹；每 500 ms 静态扫描；另有常驻 H5 查找 | 默认没有重型监听/扫描。限时窗口内合并触发；窗口发现只在根变化时请求指纹。按完成时间及耗时安排下次采样；结束重置基线、资源缓存与监听。H5 采集同步受窗口约束。 |
| iOS | Bridge 启动 CADisplayLink，最多 10 次/秒、240 节点；每 500 ms 查找 WKWebView | 默认不启动显示链接或 H5 定时器。显式窗口内才开始，后台不扫描，过期释放。根据本次耗时降低频率。H5 console hook 在结束时恢复。 |
| Flutter | 常驻帧/指针监听、强制 Semantics、1.2 秒周期快照和动画期间快照 | 移除自动界面快照任务。帧/指针事件仅在窗口内采集；窗口内也不按帧生成树。主动取树时临时开启 Semantics，读取完释放。取树和动作结束后释放临时 Element 绑定；下一次请求重新检查当前目标。 |
| Web | 配置 capture.ui 后长期监听 mutation，并计算 DOM 指纹 | capture.ui 仅配置观察能力；start() 不安装 UI 捕获。显式限时窗口才安装，过期/断开恢复监听和 history 包装。过期检查也阻止迟到 mutation 继续计算指纹。 |

Android 指纹散列保留原 SHA-256 编码、字段顺序、盐及隐私边界。用 8 KB 缓冲区分块提交，替代每字段长度的逐字节 JNI 调用；固定字段名只编码一次，语义摘要复用当前线程的摘要实例，资源名使用有界缓存，位置数组复用。等长文字变化仍有语义差异，EditText 仍只观察输入长度。没有把 View 访问搬到后台，也没有通过缩小覆盖范围伪造性能收益。

Flutter 内置的 iOS SDK 镜像同步修改，避免普通 iOS 与 Flutter/iOS 运行两套不同策略。

## 状态读取与取树分开

`GET /v1/status` 只返回状态及 Flutter 元数据，**不生成 Flutter 界面树**，也不携带旧 layout 冒充新结果。Host 每 5 秒的状态心跳不会触发扫描。

`GET /v1/flutter/snapshot` 通过已注册 MethodChannel 的 `readSnapshot` 主动读取最新树。`flutter-tree`、`flutter-nodes`、iOS 对应命令和需要选择 Flutter 节点的动作使用这个入口。SDK 设定回复期限；Dart 在读取进行中、指针/动作执行中、运行时更换或超时时明确拒绝，返回失败，不返回旧快照。

默认关闭不影响主动取 Native / Flutter / H5 树、Instrumentation / Espresso / UI Automator / WDA 操作、业务日志、网络记录、主动事件或动作回执。自动 UI 变化证据只在相应观察窗口内可用；没有事件不能推导“界面没变”“稳定”或“操作成功”。Flutter 帧事件依旧只表示绘制，不冒充语义变化。

Native View 的变化不能代替 H5 DOM 的变化证据；嵌入 H5 要主动读取 `h5-dom` / `flutter-h5-dom` / iOS 对应入口，或使用 Web 页面自己的观察窗口。H5 console 采集也与 DOM 业务断言不同。

## 命令与脚本接入

| 命令 | 目标 | provider |
| --- | --- | --- |
| `ui-observation` | Android packageName / serial | native（默认）或 flutter |
| `ios-ui-observation` | iOS deviceId / bundleId | native（默认）或 flutter |
| `web-ui-observation` | Web sessionId / runtimeEpoch / targetId | Web DOM |

共同操作：`start` 必须提供整数 `durationMs`（100–5000）；`status` 读状态；`stop` 必须携带 start 返回的 `leaseId`。同一观察器只允许一个所有者，重复 start 返回 busy，错误所有者不能关闭别人的窗口。没有无限期模式和自动续租。过期或 SDK/页面重启后重新开始会建立新基线。

Android / iOS Native HTTP 入口为 `POST /v1/ui/observation`，Flutter 为 `POST /v1/flutter/observation`。请求体仅包含 operation 及对应 durationMs / leaseId，响应 schemaVersion 为 `aab.ui-observation/v1`。

命令已进入能力发现与 Script 的 `capture.read` 权限。JS 和 Python 都通过现有 `ctx.call` 编排，不需要把测试代码放进业务 App。SDK 接入/构建与脚本语言是两层：安装 npm CLI 不会自动修复已经安装在手机中的旧 SDK。

JS 观察窗口示例（target 来自脚本输入，与声明的 Script 目标一致）：

```javascript
const target = ctx.inputs.target;
const opened = await ctx.call('ui-observation', { ...target, operation: 'start', durationMs: 1500 });
if (!opened.ok || opened.result.ok !== true) throw new Error(JSON.stringify(opened));
try {
  // 在这里执行已声明的动作，并按业务条件读取 tree / events 验证。
} finally {
  await ctx.call('ui-observation', { ...target, operation: 'stop', leaseId: opened.result.leaseId });
}
```

Python 使用同一命令与权限，调用方式为同步 `ctx.call`：

```python
target = ctx.inputs['target']
opened = ctx.call('ui-observation', {**target, 'operation': 'start', 'durationMs': 1500})
assert opened['ok'] and opened['result']['ok']
try:
    # 执行动作和明确的业务断言。
    pass
finally:
    ctx.call('ui-observation', {**target, 'operation': 'stop', 'leaseId': opened['result']['leaseId']})
```

窗口已到期时 stop 可返回 lease mismatch；status.active=false 表示没有活动窗口。Host 消失时无需依赖 finally，SDK/页面也会到期清理。普通 CLI/MCP 的 `feedback=full` 自动围绕本次动作申请窗口并 finally 关闭；若 SDK 不支持观察，它会在执行该动作前明确失败。launch 的系统反馈保留原有独立路径。普通 Script / Intent 不会因为整个任务仍在运行就持续开启观察，按实际需要调用以上能力。

## 兼容性与验收边界

需要重新构建/集成这些 SDK；仅升级 CLI、已有 0.3.6 候选包或重连 MCP 都不能把修复写入旧 App。旧 SDK 缺少新快照/观察端点时明确失败，不通过旧缓存或恢复常驻扫描绕过去。没有新增 App 测试框架依赖，也没有改操作执行器和业务源码。

Android 真机验证包含：默认零指纹采样；错误所有者及重复启动拒绝；HTTP 开窗后捕获 TextView 的真实语义变化；到期后文字变化不再采样；状态心跳不拉取 Flutter 树；显式请求通过注册通道得到新快照；真实 WebView 上 console hook 默认不存在、开窗安装、到期恢复原函数。最后另跑同机性能回归。

Flutter 的 Widget/MethodChannel 测试覆盖默认无自动快照、最新读取、Semantics 释放、到期关闭，以及既有定位/输入/滚动/导航/H5/取消行为。Web 测试覆盖默认不查询 DOM、窗口所有权、过期解绑与已有 UI 事件语义。Host 测试覆盖命令 schema、JS/Python 共用权限、反馈失败清理及 iOS 独立控制路由。

最终软件回归：CLI 全套 1313 项、Flutter 66 项、Web 23 项通过；Flutter analyze 无问题。Android 观察器单元测试和真实 HTTP/H5 合同测试通过，性能测试在同机基线上先失败、修复版通过。上述数字不包含并不存在的全 App 业务验收。

iOS SDK Debug / Release 编译通过，77 项 macOS Swift 测试通过；UIKit 运行证据来自上述 iPhone 诊断页。电脑没有 Simulator runtime，现有 UIKit XCTest 套件未运行。Web 大型 DOM 的窗口内 CPU 仍未量化；本轮未声称消除每个平台上所有取树尖峰。

## 复测

```sh
./gradlew :ai-app-bridge-android:testDebugUnitTest :ai-app-bridge-android:assembleDebugAndroidTest --console=plain
adb -s b46093e6 install -r android/ai-app-bridge-android/build/outputs/apk/androidTest/debug/ai-app-bridge-android-debug-androidTest.apk
adb -s b46093e6 shell am instrument -w -r -e class io.github.mobileaidev.aiappbridge.android.UiObservationContractTest io.github.mobileaidev.aiappbridge.android.test/androidx.test.runner.AndroidJUnitRunner
adb -s b46093e6 shell am instrument -w -r -e uiObserverPerformance true -e class io.github.mobileaidev.aiappbridge.android.UiObserverPerformanceTest io.github.mobileaidev.aiappbridge.android.test/androidx.test.runner.AndroidJUnitRunner
```

测试仅使用上述独立包和设备。结果保存在 `files/ui-observer-performance.json`，可通过 `adb exec-out run-as` 导出；普通测试不传 performance 参数时跳过较长的性能采样。
