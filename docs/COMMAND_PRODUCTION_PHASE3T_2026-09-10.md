# 第三阶段 T：WDA 设备、App 与 session 绑定

本批关闭一个具体缺口：旧 WDA 路径只拿到 URL 就操作，并可能在读树时隐式创建 session、启动 App。现在必须核验选中设备上的 Runner 容器，再把实际前台 App 进程与显式 session 绑定；不能由地址或 vendor UUID 冒充物理设备身份。

交付对象是 Bridge。Android 沿用 3O 固定结果；本批没有设备清单查询、手机操作、Android/Flutter/Swift SDK 修改或样例业务修改。已有测试通过后冻结，只重跑受改动影响或明确失败的检查。

## 已完成的合同

- 固定依赖 WDA 14.1.1，在独立副本注入 Bridge 绑定检查，不修改 node_modules 原包。准备器保留完整 Runner 构建输入、上游许可及变更前后 SHA；版本或注入点不匹配明确失败。
- Runner 原生代码原子写入自己的 Documents/ai_app_bridge_wda.json，包含 aab.ios-wda/v1、真实 bundle ID、运行 epoch、PID 和实际端口。写盘失败不就绪；每个请求和响应都绑定这组身份。
- Host 从明确 deviceId/wdaRunnerBundleId 的 App 容器复制描述，再连接该设备的开发隧道。可选 wdaUrl 仅选转发端点，不能替代容器核验；旧 WDA、端口扫描、日志 URL 推断和隐式 session 创建均退出公开路径。
- 新增 ios-wda-session 的 create/status/close。create 只附着当前前台 App，不能启动 App 或替换已有 session；close 不终止 App，并允许前台已切换后关闭原 session。共 98 个公开命令。
- WDA 原生主路由队列在派发前检查 Runner、session、前台 bundle/PID。ios-uia-tree/tap/input/swipe 都要求明确 App 和 session；tap/swipe 仍是前台 App 范围的坐标动作。
- ios-input 必须指定一个 elementId 或唯一 accessibilityId；同一个 W3C element 完成点击、可选清空和输入。移除坐标预点、隐式焦点和全局键盘替代路径。
- HTTP 200 中的 W3C value.error 仍为失败；缺失/错误响应身份不成功。写响应丢失不换通道重放，物理 UDID 占用保留，跨 App 后续写入受阻。
- ios-setup 复用已绑定 Runner，或创建自己拥有的 xcodebuild 进程。构建环境移除 Host 注入的 macOS 头文件/库路径，关闭 Xcode 默认头文件搜索；失败或取消只终止自己创建的进程组，并等待实际关闭。spawn 失败不能假报已经派发设备操作。
- doctor.ready 同时要求设备开发隧道、DDI、App SDK 和绑定 WDA；无需额外 WDA URL 就能检查选中 Runner。它表示连接条件，不表示生产验收。

公开参数、例子和边界已同步到 [命令合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#ios-wda-target-and-session)、CLI README 及中英文根 README。

## 实际验证与失败记录

证据根目录：build/ai_app_bridge_artifacts/command-production-phase3t-2026-09-10/。按最终有效的不同检查计 71 项 Host 定向检查，重跑不累计覆盖。

| 检查 | 结果与范围 |
| --- | --- |
| WDA 绑定与公共合同 | host-wda-02.log，29/29；受控 devicectl 子进程、真实本地 HTTP 和实际副作用文件，覆盖旧 Runner 拒写、App/PID 变化、显式 session、重复目标、HTTP 200 错误、响应丢失和跨 App 阻断。 |
| 原 SDK 绑定与执行 | host-ios-affected-01.log，27/29，剩余 2 项在 host-targeted-fixes-02.log 通过。原 Host SIGKILL、跨别名阻断及原 SDK 持久完成恢复保留；只更新 WDA 调用参数和测试启动时间预算。 |
| iOS CLI | host-ios-cli-01.log，5/6；旧 required 字段预期更新后，余下 1 项在 host-targeted-fixes-02.log 通过。该定向重跑共 3/3，未重跑全部 Host 或全部 CLI。 |
| Runner 准备和启动 | host-wda-project-01.log，7/7；上游原包未改、构建脚本齐全、容器绑定复用、实际 SIGTERM 无响应的受控子进程在取消/期限后关闭、spawn 失败不假派发，以及 doctor 连接条件。 |
| 原生绑定与磁盘 | wda-foundation-02.log；真正编译执行 Foundation 检查程序，实际写盘、替换 epoch/PID、无效/重复头及 App/session 拒绝、写盘失败不就绪通过。它不是 XCUITest 真机动作测试。 |
| iOS Runner 构建 | wda-arm64-build-04.log，实际 arm64 build-for-testing 成功，含注入的 Objective-C 与完整 Runner；签名关闭、未安装。 |
| 发行包 | package-content/report.json：实际 npm tarball 和干净目录安装通过，原生 node-gyp 生命周期真实执行；102 个运行时文件和 3 个 WDA 源文件与工作区逐字节一致，新进程从安装目录解析 WDA 14.1.1 并准备完整项目。未发布 npm。 |

初始失败均保留，不把修复前的日志改为成功：

1. WDA 构建前两轮因 Host/Xcode 注入 /usr/local/include 交叉编译失败。第三轮源码编译链接成功，但准备器遗漏 scheme 调用的 Scripts/embed-runner-icon.sh；补齐完整 Scripts 后第四轮实际构建成功。
2. Foundation 测试首轮因 NSCAssert 宏中的字典逗号导致测试程序无法编译，修正括号后通过。
3. WDA Host 首轮把既有占用错误码期望写错；实际阻断正确，按真实合同改为 device_ownership_unresolved。原 SDK/CLI 三个失败分别是旧 WDA 参数、旧必填字段预期和受控子进程尚未启动 HTTP 就耗尽 600 ms 预算；更新参数与 2000 ms 总预算，仍要求只有一次 HTTP、总期限触发和真实 socket 关闭。
4. 干净包安装成功后，探针从错误模块调用 capabilityPayload。仅修正探针导入，复用同一个 tarball 和安装目录完成验证，没有第二次 npm 安装。

包 SHA-256：d468548678a5348a2304ea43203177de2edb19e196f110715a6a0facd18a232f。

## 收口和下一步

本批退出条件是：真实 Runner 身份与前台 App/session 在公开命令内闭合；错误目标无副作用；未知响应保留物理占用；原生构建、受控进程生命周期和实际发行包可核验。以上软件关口完成后冻结，相关源码变化或出现反证才重开对应检查。

下一关只推进 WDA/native 动作本身的受管执行：主队列排队取消、派发后原结束记录持久化、Host 重启后按原身份恢复，以及输入焦点/元素变化时的写入边界。当前 WDA 主队列仍不能在繁忙时及时处理普通取消请求；SDK ios-execution reconcile 不能释放未知 WDA 操作。不能把本批身份校验或本地进程关闭写成远端动作取消完成。

iOS 设备接入通知仍待用户回复；本批没有用历史配对记录代替在线设备，也没有真机结果。设备接入后优先验证公开存查、原引用、真实 App 重启、SDK 取消和绑定 WDA。iOS Intent/Script 继续关闭，直到必要平台合同和最小真机闭环通过。

整体主线保持有限的剩余关口：平台动作/存查合同、iOS/Web 公开执行闭环、发行 SDK 组合、既定多 App/整机套件、连续运行与故障验收。安装/启动结果、多 WKWebView、Android 已列明的系统边界和 LocalSend 缺失断言仍按原计划处理；不为扩大测试数量新增样例业务或重复已有完整矩阵。整体生产验收未完成。
