# 公开命令逐项评估（2026-09-08）

源码基线 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`。由实际 `capabilities(includeOptions:true)` 导出 **97 个命令：94 个既有命令、3 个新执行/证据入口**，涉及 134 个公开参数名。compact surface 为 2 个 MCP tools；full surface 实际只有 51 个 tools，不能把它理解为 97 个命令各一个 tool。

这里逐项盘点的是公开合同与实现路径；没有声称在本轮对 97 个命令逐一做了真机验收。生产化阻断、复现与执行顺序见 [整体审计](COMMAND_PRODUCTION_AUDIT_2026-09-08.md)。完整参数名及源码位置在 [JSON 清单](audits/2026-09-08/command-catalog.json)。

处置建议：保留 36 项；迁入样例 2 项；重构后保留 33 项；专家能力 16 项；收敛入口 10 项。所有建议均待实施；本次未删除、改名或替换生产命令。

通用参数问题：当前 capability 返回的是参数名数组，缺少每个参数的类型、必填条件、互斥规则、范围、单位、默认值和错误 schema。下表“公开参数”是当前原样清单，不代表这些参数已被严格验证。

## core

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `status` | 保留 | packageName, port, serial, full | 保留身份、runtime epoch、持久化接入状态；能力发现需区分已实现与已验证。 |
| `tree` | 保留 | packageName, port, serial, compact, textFilter, resourceIdFilter, classFilter, visibleOnly, maxNodes, maxDepth, history, factCursor | 不同观察来源有实际用途；统一观察 ID、时间、目标、坐标空间及缺失原因，截图/树不能单独代表业务成功。 |
| `uia-tree` | 保留 | serial, compact, textFilter, resourceIdFilter, classFilter, visibleOnly, maxNodes, history, factCursor | 不同观察来源有实际用途；统一观察 ID、时间、目标、坐标空间及缺失原因，截图/树不能单独代表业务成功。 |
| `screenshot` | 保留 | serial, packageName, outFile, artifactDir, history, factCursor | 不同观察来源有实际用途；统一观察 ID、时间、目标、坐标空间及缺失原因，截图/树不能单独代表业务成功。 |
| `logs` | 保留 | packageName, port, serial, sinceId, sinceMs, limit, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | Android attached 后读持久事实；初始化/失败时仍可能为内存后端。明确 live、history、decision-window、分页和 coverage，网络字段过滤须保持 refs 对齐。 |
| `network` | 保留 | packageName, port, serial, compact, urlFilter, method, statusCode, noBodies, bodyMaxBytes, sinceId, sinceMs, limit, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | Android attached 后读持久事实；初始化/失败时仍可能为内存后端。明确 live、history、decision-window、分页和 coverage，网络字段过滤须保持 refs 对齐。 |
| `state` | 保留 | packageName, port, serial, sinceId, sinceMs, limit, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | Android attached 后读持久事实；初始化/失败时仍可能为内存后端。明确 live、history、decision-window、分页和 coverage，网络字段过滤须保持 refs 对齐。 |
| `events` | 保留 | packageName, port, serial, sinceId, sinceMs, limit, includeActions, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | Android attached 后读持久事实；初始化/失败时仍可能为内存后端。明确 live、history、decision-window、分页和 coverage，网络字段过滤须保持 refs 对齐。 |

## diagnostics

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `logcat` | 保留 | serial, packageName, pid, appPid, tag, level, grep, lines, since, follow, durationSec, clear, history, factCursor | 系统/其他 App 无 SDK 时有独立价值；明确 PID 与整机范围、清缓冲的副作用、截断及退出原因。 |
| `smoke` | 迁入样例 | serial, packageName, outFile, artifactDir, skipFlutterLaunch | 依赖仓库演示流程/Activity，不应作为通用业务能力默认公开；保留在开发诊断或 sample runner。 |

## app

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `install-apk` | 重构后保留 | serial, packageName, apkPath, allowDowngrade, streaming, installTimeoutMs, installerTimeoutMs, intervalMs | 目前 ADB install 加旧 UIA 标签轮询，没有新 Intent；重构为可观察可取消的安装流程，核对 APK 身份/目标版本/签名及系统安装结果。 |
| `clear-app-data` | 重构后保留 | serial, packageName | 显式目标已有保护；需核对 SDK 请求不确定时转 pm clear 的重复派发、独立清除结果和错误格式。 |
| `freeze-app` | 专家能力 | serial, packageName, pid | 不是常规页面稳定机制；信号操作需权限/超时/恢复约束，避免将停住 App 留给下一次操作。 |
| `thaw-app` | 专家能力 | serial, packageName, pid | 不是常规页面稳定机制；信号操作需权限/超时/恢复约束，避免将停住 App 留给下一次操作。 |
| `launch-app` | 保留 | serial, packageName, activity, component, action, category, data, extra, clearTask | 分别保留默认 launcher 与显式 component 用途；已有 launcher_ambiguous，统一启动结果、目标、clearTask 和 extras 合同。 |
| `launch-activity` | 保留 | serial, packageName, activity, component, action, category, data, extra | 分别保留默认 launcher 与显式 component 用途；已有 launcher_ambiguous，统一启动结果、目标、clearTask 和 extras 合同。 |
| `launch-native-test` | 迁入样例 | serial, packageName | 依赖仓库演示流程/Activity，不应作为通用业务能力默认公开；保留在开发诊断或 sample runner。 |
| `launch-flutter` | 收敛入口 | serial, packageName, initialRoute | 当前基于 .MainActivity 与 ai_app_initial_route；普通 Flutter 启动并入 launch-app，特定 harness 路由能力移入样例。 |
| `permission-state` | 保留 | serial, packageName, permission | 真实 dumpsys 权限状态有价值；明确权限不存在、权限状态未知、设备不可读的不同错误。 |
| `permission-grant` | 专家能力 | serial, packageName, permission | 测试夹具控制有价值；默认流程用真实系统授权交互。明确作用范围、枚举、持久化影响和复核结果。 |
| `permission-revoke` | 专家能力 | serial, packageName, permission | 测试夹具控制有价值；默认流程用真实系统授权交互。明确作用范围、枚举、持久化影响和复核结果。 |
| `permission-dialog` | 重构后保留 | serial, targetText, buttonText, resourceId, attempts, intervalMs, exact | 系统权限流程应复用 Intent 观察和唯一目标决策；固定标签/多次尝试需绑定实际页面及取消结果。 |
| `appops-set` | 专家能力 | serial, packageName, op, mode | 测试夹具控制有价值；默认流程用真实系统授权交互。明确作用范围、枚举、持久化影响和复核结果。 |

## action

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `tap` | 重构后保留 | serial, tapX, tapY | 保留物理坐标原语；拒绝 null/boolean/越界参数。App-local 目标不符时必须停止，不能继续 ADB 点击。 |
| `tap-text` | 重构后保留 | serial, packageName, targetText, noAutoHideKeyboard | 两个观察来源可保留；统一精确 selector、唯一匹配、最新观察与前台检查，避免首个重复标签被默选。 |
| `tap-uia-text` | 重构后保留 | serial, targetText, exact | 两个观察来源可保留；统一精确 selector、唯一匹配、最新观察与前台检查，避免首个重复标签被默选。 |
| `wait-text` | 重构后保留 | serial, packageName, targetText, timeoutSec, intervalMs, requireText, absentText, requireActivity | 统一毫秒 deadline、取消与探测频率；超时区别目标未出现/观察失败，默认不自动重试动作。 |
| `input-text` | 重构后保留 | serial, packageName, text, tapX, tapY, hideKeyboard | 保留 Unicode SDK 输入；明确空字符串、目标定位和清空/替换行为，ASCII fallback 需显式合同，不能改变不确定操作结果。 |
| `keyboard-state` | 保留 | serial | 读键盘与收键盘有独立用途；区分启发式状态与实证，明确收键盘使用何种动作及结果。 |
| `hide-keyboard` | 保留 | serial, force, intervalMs | 读键盘与收键盘有独立用途；区分启发式状态与实证，明确收键盘使用何种动作及结果。 |
| `swipe` | 重构后保留 | serial, startX, startY, endX, endY, durationMs | 保留设备输入；统一单位、数值范围和目标租约，keyCode=0 不得被隐式变成 4；动作执行不等于业务成功。 |
| `keyevent` | 重构后保留 | serial, keyCode | 保留设备输入；统一单位、数值范围和目标租约，keyCode=0 不得被隐式变成 4；动作执行不等于业务成功。 |

## flutter

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `flutter-tree` | 收敛入口 | serial, packageName, port, history, factCursor | 全树与 operable 投影来自同一快照，宜同一观察接口的明确 view；实际 shape/性能等价前保留两者，不盲删。 |
| `flutter-nodes` | 收敛入口 | serial, packageName, port, history, factCursor | 全树与 operable 投影来自同一快照，宜同一观察接口的明确 view；实际 shape/性能等价前保留两者，不盲删。 |
| `flutter-action` | 专家能力 | serial, packageName, payload | raw payload 不适合默认 Agent/Script 面；保留底层调试用途，常规动作使用 typed 命令。 |
| `tap-flutter` | 保留 | serial, packageName, tapX, tapY | 新命令；明确 Flutter logical pixels、观察 freshness、runtime actionId 与异步作用域。Android 已实测，不能据此宣布 iOS 等价。 |
| `tap-flutter-text` | 重构后保留 | serial, packageName, targetText | 统一文字选择器唯一性、输入目标、滚动边界和 actionId；命令/内部 helper 的物理与逻辑坐标路径应收口。 |
| `input-flutter-text` | 重构后保留 | serial, packageName, text, tapX, tapY, hideKeyboard | 统一文字选择器唯一性、输入目标、滚动边界和 actionId；命令/内部 helper 的物理与逻辑坐标路径应收口。 |
| `scroll-flutter` | 重构后保留 | serial, packageName, targetText, delta, maxSwipes | 统一文字选择器唯一性、输入目标、滚动边界和 actionId；命令/内部 helper 的物理与逻辑坐标路径应收口。 |

## webview

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `h5-dom` | 保留 | serial, packageName, port, history, factCursor | 保留 WebView DOM 观察；说明 window/frame 目标、快照 generation、跨页面失效和字段截断。 |
| `h5-eval` | 专家能力 | serial, packageName, script | 任意 JS 是显式调试能力，默认流程用 typed 操作；不要把任意脚本执行伪装成只读查询。 |
| `h5-click` | 重构后保留 | serial, packageName, selector, targetText, exact | 保留 DOM 语义操作；统一 selector 与 text 二选一、exact、空输入、毫秒超时及嵌套 result 的错误。 |
| `h5-input` | 重构后保留 | serial, packageName, selector, targetText, value, exact | 保留 DOM 语义操作；统一 selector 与 text 二选一、exact、空输入、毫秒超时及嵌套 result 的错误。 |
| `h5-wait` | 重构后保留 | serial, packageName, selector, targetText, timeoutSec, intervalMs | 保留 DOM 语义操作；统一 selector 与 text 二选一、exact、空输入、毫秒超时及嵌套 result 的错误。 |
| `h5-scroll` | 重构后保留 | serial, packageName, selector, targetText, deltaX, deltaY | 保留 DOM 语义操作；统一 selector 与 text 二选一、exact、空输入、毫秒超时及嵌套 result 的错误。 |
| `flutter-h5-dom` | 收敛入口 | serial, packageName, port | 实现适配至 H5，建议同一 H5 命令合同配显式 provider；先完成不同桥接返回值/上下文一致性验证。 |
| `flutter-h5-eval` | 专家能力 | serial, packageName, script | 任意 JS 是显式调试能力，默认流程用 typed 操作；不要把任意脚本执行伪装成只读查询。 |
| `flutter-h5-click` | 收敛入口 | serial, packageName, selector, targetText, exact | 实现适配至 H5，建议同一 H5 命令合同配显式 provider；先完成不同桥接返回值/上下文一致性验证。 |
| `flutter-h5-input` | 收敛入口 | serial, packageName, selector, targetText, value, exact | 实现适配至 H5，建议同一 H5 命令合同配显式 provider；先完成不同桥接返回值/上下文一致性验证。 |
| `flutter-h5-wait` | 收敛入口 | serial, packageName, selector, targetText, timeoutSec, intervalMs | 实现适配至 H5，建议同一 H5 命令合同配显式 provider；先完成不同桥接返回值/上下文一致性验证。 |
| `flutter-h5-scroll` | 收敛入口 | serial, packageName, selector, targetText, deltaX, deltaY | 实现适配至 H5，建议同一 H5 命令合同配显式 provider；先完成不同桥接返回值/上下文一致性验证。 |
| `webview-pages` | 专家能力 | serial, packageName, webviewPort, socketName, targetId, pageUrlFilter, keepForward | CDP 选页诊断保留；多 socket/page 必须显式选择，不能将默认第一页当目标身份。 |
| `webview-network` | 保留 | serial, packageName, webviewPort, socketName, targetId, pageUrlFilter, urlFilter, durationMs, script, includeResponseBody, bodyMaxBytes, maxEvents | 这是按时长现场采集的 CDP 结果，不是手机持久历史；明确会建立连接、截断与会话范围，不能宣称现成 durable coverage。 |
| `webview-console` | 保留 | serial, packageName, webviewPort, socketName, targetId, pageUrlFilter, durationMs, script, maxEvents | 这是按时长现场采集的 CDP 结果，不是手机持久历史；明确会建立连接、截断与会话范围，不能宣称现成 durable coverage。 |

## ios

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `ios-doctor` | 保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, wdaUrl | 只读环境/设备发现保留；设备歧义错误已有，需把 WDA、SDK、持久化证据可用性分别报告。 |
| `ios-setup` | 专家能力 | deviceId, bundleId, appPath, iosHost, iosPort, runtimeUrl, wdaUrl, wdaProjectPath, wdaBundleId, teamId, startWda | 签名/构建/启动 WDA 是长流程；应有可查询进度、子进程清理、超时和恢复合同，不能混入日常动作参数。 |
| `ios-devices` | 保留 | deviceId | 只读环境/设备发现保留；设备歧义错误已有，需把 WDA、SDK、持久化证据可用性分别报告。 |
| `ios-install-app` | 重构后保留 | deviceId, appPath | 当前 devicectl 安装返回即 ok；补目标包身份、版本和独立安装结果验证，平台能力不能冒充 Android 安装 Intent。 |
| `ios-launch-app` | 保留 | deviceId, bundleId, terminateExisting | 保留显式 bundleId 启动，补前台与运行实例结果合同；真机同义验收仍待做。 |
| `ios-status` | 保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl | 分别属于 SDK/WDA 观察；标明来源、设备、bundle、generation、坐标空间与是否同一前台，不用存在端点替代实测。 |
| `ios-tree` | 保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, history, factCursor | 分别属于 SDK/WDA 观察；标明来源、设备、bundle、generation、坐标空间与是否同一前台，不用存在端点替代实测。 |
| `ios-logs` | 重构后保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, sinceId, sinceMs, limit, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | 生产 GET 当前只读有界内存；非 legacy-live 明确 persistence_unavailable。需接持久后端与 cursor/ref/epoch 合同后才开放强证据。 |
| `ios-network` | 重构后保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, sinceId, sinceMs, limit, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | 生产 GET 当前只读有界内存；非 legacy-live 明确 persistence_unavailable。需接持久后端与 cursor/ref/epoch 合同后才开放强证据。 |
| `ios-state` | 重构后保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, sinceId, sinceMs, limit, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | 生产 GET 当前只读有界内存；非 legacy-live 明确 persistence_unavailable。需接持久后端与 cursor/ref/epoch 合同后才开放强证据。 |
| `ios-events` | 重构后保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, sinceId, sinceMs, limit, includeActions, history, factCursor, view, runtimeEpoch, afterActionId, mobileFactId, targetKey | 生产 GET 当前只读有界内存；非 legacy-live 明确 persistence_unavailable。需接持久后端与 cursor/ref/epoch 合同后才开放强证据。 |
| `ios-h5-dom` | 保留 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, history, factCursor | WKWebView DOM 读取有价值；补多 WebView/页面选择、来源、freshness 与真机合同。 |
| `ios-h5-eval` | 专家能力 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, script | 任意 JS 是显式调试能力，默认流程用 typed 操作；不要把任意脚本执行伪装成只读查询。 |
| `ios-flutter-tree` | 收敛入口 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, history, factCursor | 同 Flutter 观察视图收敛；iOS native capture 入口尚未保留完整 actionId，不能套用 Android 通过结论。 |
| `ios-flutter-nodes` | 收敛入口 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, history, factCursor | 同 Flutter 观察视图收敛；iOS native capture 入口尚未保留完整 actionId，不能套用 Android 通过结论。 |
| `ios-flutter-action` | 专家能力 | deviceId, bundleId, iosHost, iosPort, runtimeUrl, payload | raw 调试入口；需 typed Flutter 同义操作和完整 actionId ingress 后再进入常规脚本目录。 |
| `ios-screenshot` | 保留 | deviceId, outFile, artifactDir, displayUniqueId, history, factCursor | 分别属于 SDK/WDA 观察；标明来源、设备、bundle、generation、坐标空间与是否同一前台，不用存在端点替代实测。 |
| `ios-wda-status` | 专家能力 | wdaUrl | 保留 WDA 诊断；应绑定实际 device/session，不能把任意可访问 WDA 当成指定设备。 |
| `ios-uia-tree` | 保留 | bundleId, wdaUrl, wdaSessionId, history, factCursor | 分别属于 SDK/WDA 观察；标明来源、设备、bundle、generation、坐标空间与是否同一前台，不用存在端点替代实测。 |
| `ios-tap` | 重构后保留 | bundleId, wdaUrl, wdaSessionId, tapX, tapY | 保留 WDA 原语；Script 丢失 iOS target 且要求 serial；输入/滑动的超时 fallback 会二次派发，先补目标模型与不确定结果语义。 |
| `ios-input` | 重构后保留 | bundleId, wdaUrl, wdaSessionId, text, tapX, tapY, accessibilityId, elementId, clearFirst | 保留 WDA 原语；Script 丢失 iOS target 且要求 serial；输入/滑动的超时 fallback 会二次派发，先补目标模型与不确定结果语义。 |
| `ios-swipe` | 重构后保留 | bundleId, wdaUrl, wdaSessionId, startX, startY, endX, endY, durationMs | 保留 WDA 原语；Script 丢失 iOS target 且要求 serial；输入/滑动的超时 fallback 会二次派发，先补目标模型与不确定结果语义。 |

## web

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `web-provider-status` | 保留 | 未公开专用参数 | 连接管理有价值；统一 token/target、端口、会话生命周期、TTL 和断连状态；默认 loopback 已有。 |
| `web-session-start` | 保留 | host, webPort, path, token | 连接管理有价值；统一 token/target、端口、会话生命周期、TTL 和断连状态；默认 loopback 已有。 |
| `web-connect-info` | 保留 | 未公开专用参数 | 连接管理有价值；统一 token/target、端口、会话生命周期、TTL 和断连状态；默认 loopback 已有。 |
| `web-sessions` | 保留 | 未公开专用参数 | 连接管理有价值；统一 token/target、端口、会话生命周期、TTL 和断连状态；默认 loopback 已有。 |
| `web-status` | 保留 | sessionId | 区分实时已连接、已断连最后快照与显式历史，携带 target 与快照时间。 |
| `web-dom` | 保留 | sessionId, targetId, selector, refresh, timeoutMs, history, factCursor | 区分实时已连接、已断连最后快照与显式历史，携带 target 与快照时间。 |
| `web-logs` | 重构后保留 | sessionId, sinceId, sinceMs, limit, history, factCursor | live 读 session 内存，Host history 是另一路已采记录。补字节与 session/state 上限、断连标志、values/limit 一致性及覆盖语义。 |
| `web-network` | 重构后保留 | sessionId, sinceId, sinceMs, limit, history, factCursor | live 读 session 内存，Host history 是另一路已采记录。补字节与 session/state 上限、断连标志、values/limit 一致性及覆盖语义。 |
| `web-state` | 重构后保留 | sessionId, sinceId, sinceMs, limit, history, factCursor | live 读 session 内存，Host history 是另一路已采记录。补字节与 session/state 上限、断连标志、values/limit 一致性及覆盖语义。 |
| `web-events` | 重构后保留 | sessionId, sinceId, sinceMs, limit, includeActions, history, factCursor | live 读 session 内存，Host history 是另一路已采记录。补字节与 session/state 上限、断连标志、values/limit 一致性及覆盖语义。 |
| `web-command` | 专家能力 | sessionId, targetId, name, arguments, timeoutMs | 任意 Web command 与 SDK capabilities 绑定；常规流程使用 typed 命令，限制结果体积并统一失败语义。 |
| `web-click` | 重构后保留 | sessionId, targetId, selector, targetText, timeoutMs | 保留 DOM 语义操作；Script target 当前丢 sessionId/targetId 且变更租约要求 serial，需平台身份和 action correlation。 |
| `web-input` | 重构后保留 | sessionId, targetId, selector, value, timeoutMs | 保留 DOM 语义操作；Script target 当前丢 sessionId/targetId 且变更租约要求 serial，需平台身份和 action correlation。 |
| `web-wait` | 重构后保留 | sessionId, targetId, selector, targetText, timeoutMs | 保留 DOM 语义操作；Script target 当前丢 sessionId/targetId 且变更租约要求 serial，需平台身份和 action correlation。 |
| `web-scroll` | 重构后保留 | sessionId, targetId, selector, deltaX, deltaY, timeoutMs | 保留 DOM 语义操作；Script target 当前丢 sessionId/targetId 且变更租约要求 serial，需平台身份和 action correlation。 |

## advanced

| 命令 | 建议 | 当前公开参数 | 评估及验收重点 |
| --- | --- | --- | --- |
| `forward` | 专家能力 | serial, packageName, port | 应由连接 Module 管理；保留诊断入口，必须按 serial 验证所有权，不能影响其他会话。 |
| `remove-forward` | 专家能力 | serial, port | 应由连接 Module 管理；保留诊断入口，必须按 serial 验证所有权，不能影响其他会话。 |
| `batch` | 保留 | defaults, steps, stopOnError, includeRaw, maxRawChars | 保留少量顺序调用便利性；限制步数和总预算，明确只判调用结果，没有 Script 的暂停/恢复与业务断言合同。 |
| `script` | 保留 | operation, waitMs, afterSequence, recordingDir | 主要回归入口；需补完整 ScriptSpec schema、平台 target、统一设备执行、取消/断连/重启及生产打包验证。 |
| `intent` | 保留 | operation, recordingDir | 日常观察与决策入口；需补完整 decision schema、安装场景、重启后查询、跨平台及共享执行原语。 |
| `evidence` | 保留 | operation, namespace, operationId, outputDir, includeRecordedPayloads, archiveDir, manifestSha256 | 导出/离线 verify 已有实证；始终区别归档完整性、执行成功和业务断言，公开真实未采/淘汰/缺文件错误。 |
