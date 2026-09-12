# 第三阶段 M：H5 结束凭据、DOM 语义和真实回执恢复

Android H5 执行已接入与 Native、Flutter、shell 一致的设备占用和结束证明规则。排队取消不会留下迟到的 JavaScript，提交后不能用本地超时冒充远端结束；公开 JS/Python 已验证点击、输入、等待、手机事件和原回执恢复。本轮还修复了前台弹窗选择与空输入查询。整个体系仍在生产化推进中，本阶段不是全 App 或全平台验收。

## 实现

- Native 的执行协调实现提取为 `ManagedActionExecutor`，Native/H5 保留各自协议和状态。新增 `aab.h5-execution/v1`、`status.debugBridge.h5ExecutionSchema/h5Action` 与 `/v1/h5/cancel`，Host 固定原 actionId/runtimeEpoch 后派发。
- `H5EvaluationTask` 在主线程准入前可取消；准入后等待原 JavaScript 回调和 Java adapter 调用都结束。1500 ms grace 只限制回复等待，未知执行继续占用。超时或取消后取得回调仍保留失败原因，不重放脚本。
- 原 H5 完成事件按 actionId 落入手机 CaptureStore。普通结果、Script 返回值及 action-receipt 保存 `executionReceipt`；H5 wait 的多个 child poll 保留 `executionReceipts`。公开 `device-ownership reconcile` 使用原目标与身份查询，缺失/错误凭据继续阻断。
- Native tree/action 与 H5 DOM/eval 统一前台窗口范围。Android 29+ 使用公开 `WindowInspector`；旧 Android 版本的枚举失败显式报错，不把 Activity decor 当作遗漏弹窗的替代。多个 shown WebView 拒绝选择第一个。
- Native/Flutter typed H5 共用一份 renderer 脚本。CSS selector 与 targetText 二选一，exact 比较单独字段；重复/隐藏/禁用目标、无效 selector 和扫描上限均有明确错误。点击只调用一次语义 click，输入在 focus 回调后重验原元素和值。
- 输入只使用已校验的字符串 `value`，删除旧内部别名和 String 转换。空值可清除；原 DOM 快照会用 aria-label 填充显示 text，现增加独立 `value`，避免把标签误认成输入内容。
- `h5-wait`/`flutter-h5-wait` 统一 `timeoutMs`、`intervalMs` 和 `exact`，移除 `timeoutSec`；执行错误立即返回，仅确定不存在的目标重试。显式零滚动不变成默认向下滚动。

公开命令仍为 95 项。合同见 [COMMAND_CONTRACT](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)、[Script 使用合同](../desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md)和 [3M 机器目录](audits/2026-09-09/command-contract-phase3m.json)。

## 验证及独立结果

证据根目录为 `build/ai_app_bridge_artifacts/command-production-phase3m-2026-09-09/`。设备是已授权的 `FYZLAU49X8OVQGJ7 / OPPO PGFM10 / API 36`。基线 HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`，开始时逐文件核对了上一阶段 565 个来源并保存 219 个已有修改/未跟踪文件的哈希；没有提交、推送或发布。

| 检查 | 结果与证据 |
| --- | --- |
| Host 全量 | 950/950，0 失败/取消/跳过；26116.734125 ms；`logs/host-all-final.log` |
| Android 单测 | 165/165，0 失败/错误/跳过；`sdk-build-fourth-report.json` |
| Android SDK 真机 | 46/46，87.038 秒；含 11 个 H5 场景及 35 个既有 Native/Flutter 场景；`logs/sdk-device-fourth.log`、`sdk-device-final-summary.json` |
| 精确 Host DOM 脚本 | Android instrumentation asset 由当前 Host 函数生成，Host 测试逐字节检查；真实 renderer 检查单次点击、空值/Unicode、重复目标、错误 CSS、focus 回调改变值，独立 JavascriptInterface 与 renderer 读取核对结果 |
| 前台窗口 | Native 弹窗阻断背景 WebView，弹窗内 WebView 正常可用；树查询包含两层窗口且前台有焦点。排队超时/取消无迟到写，提交后取消/超时保持占用直到原回调；SDK 原响应可恢复且同 ID 不能重放 |
| 公开三入口衔接 | Native Intent 滑动现有容器并观察 H5；JS/Python 分别执行 H5 清空、Unicode 输入、点击、等待和输入恢复，各 9 条设备断言、5 份 H5 凭据；`public-h5-sixth/report.json` |
| 独立 CDP 结果 | 根据实际 App PID、DevTools socket 与页面身份连接，读取与 SDK DOM 查询独立。两种 Script 后正文为 Native H5 clicked、输入恢复初始值；错误 selector/不存在目标未改变状态 |
| Host 崩溃与恢复 | 截住真实 SDK 完成响应后 SIGKILL Host；普通命令、Native Intent、JS/Python 均被阻断；丢失与错 actionId 的凭据不能解锁，原凭据恢复成功；独立计数为 1，代理仅收到一次原 H5 派发 |
| 持久查询及离线核验 | 新进程从分段 FactStore 按 target/actionId 查回恢复记录，摘要与原 SDK 响应一致。14 份归档重新打开存储导出后搬移，在禁用 ADB、原存储不可用时全部 verified；共 18 份执行凭据，其中两条通过的 H5 Script 为 10 份；`offline/report.json`、`offline/recovery-disk-proof.json` |
| 干净发行包 | 最终 npm tarball 新目录安装，原生依赖实际编译、95 项能力、Script/Intent/权限/退出重启合同通过；`package-final/report.json`。发布文件与源码、安装物一致，89 个 bin 文件与实际真机测试包一致；`package-source-verification.json` |
| UI 与恢复 | 已逐张核看 Intent 展示 H5、JS/Python 完成、崩溃后计数 1、恢复初始内容的 5 张截图；`visual-review.json`。恢复的是页面内容，Native 容器保持 Intent 后的滚动位置 |

真机实际使用的 Host 包 SHA-256 为 `f049545aadeef836589437e7ead5521b222058f4ced9c0d9c9e5821ee30e85ad`。补齐文档后的最终包为 `6d2440703440f34470070b11f5d15e5979602c225cba0ffc0caf20bb369b751c`，运行时 89 个 bin 文件逐字节相同。JS/Python 的本轮短场景及导出分别为 2737 ms、2867 ms；这些时间不能外推完整 App 回归速度。

最终 instrumentation APK SHA-256 为 `a14344e873387a50a43abcf28a31204d0acd3d0b62a24d1868d2de3d57b1bc14`。现有 native sample 的新 APK 为 `9cdff0b4f5990b56bd34ed6d455505335557e78af65978df1eb1e8a2887faa45`。sample 的四个源码文件哈希完全未变，仅 SDK 重建。未修改 NotallyX/LocalSend 业务或操作非 OPPO 设备。

崩溃动作的原身份为 `h5-crash-1788927397972`，runtime epoch 为 `1788927385713-744a037c-ee1b-4241-9c04-8705a2119232`。故障只注入 Host HTTP 回复通道；计数见证是 sample 页面内临时设置的点击处理器，恢复后移除。独立 CDP 始终只读取结果，没有充当操作的备用通道。验证开始前在 SDK 空闲时显式重启 sample 进程来固定页面，此夹具初始化不是恢复未知执行的手段。

## 失败记录与范围限制

- 首轮 SDK 42 项中 4 项失败：3 项为计数器与 DOM named property 重名，1 项为背景 WebView 被误选。第二轮 46 项中 3 项失败：旧反射窗口枚举缺失，以及 focus 测试前提不成立。公开窗口枚举、明确焦点前提和独立值读取后，第三轮 46 项通过；补齐空值查询后第四轮重新跑完 46 项。
- 公开控制器前几轮分别因未支持的 className selector、把顶层 Script 凭据读成 nested result、旧历史 gap 没有先取得新完整窗口，以及 DOM 显示 text 无法验证空值而失败。前两类修正控制器；第三类保持证据门禁，新增完整前置窗口；第四类增强 SDK 查询。第五次在更新 APK 后尚未启动 App，返回 bridge_not_ready；显式启动后第六轮完成。全部原记录保留，未改写为通过。
- 原 SDK APK 安装仅由 Intent 执行已观察到的系统确认 UI；安装本身由测试准备 ADB 发起。后续从新进程导出了原已取消 Intent。它不是完整 install-apk 流程或 PackageInstaller 恢复验收。
- 原始 H5 回调结束不等于页面后续 Promise、timer、网络或业务完成。SDK 只在内存保留一个原终态；SDK 重启或回执被淘汰仍不能靠 idle 解锁。
- `h5-dom` 仍有独立的只读队列/超时实现；多 WebView 显式身份、frame、跨页面 generation、截断明示、页面遮挡和 trusted 输入事件等尚未完成。新公开窗口枚举本轮覆盖 Native tree/action 与 H5；自动 UI observer/console 的旧窗口发现另有实现，尚待统一。
- Flutter H5 共享 DOM 脚本和 Host 等待参数，但未由本轮 native WebView 证明 Flutter H5、WKWebView 或其他 Android 版本可交付。Intent 当前没有直接 H5 provider，本轮仅证明 Native Intent 与 H5 Script 衔接。

## 下一关

优先处理安装的 PackageInstaller 原任务结束身份、取消和故障恢复，并确定普通命令历史写入失败时的公开合同。UIA 原子目标绑定、shell 未确认任务退役、通用 CDP/HTTP 结束协议、iOS 持久查询与平台 target、原四 App 固定覆盖、连续压力和性能门禁继续保留。样例 App 只用于发现 Bridge 缺口。
