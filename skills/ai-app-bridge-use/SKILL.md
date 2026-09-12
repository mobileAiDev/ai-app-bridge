---
name: ai-app-bridge-use
description: 通过 AI App Bridge 实际观察、操作和验证 App 时使用。用 Intent 进行观察与决策，用 Script 进行重复回归，用共享命令进行单次操作和诊断，并通过当前 MCP capabilities 核对参数与平台范围。开发 Bridge 本身时，以当前源码和命令合同为准。
---

# AI App Bridge Use

## 选择执行方式

Intent 和 Script 是一等执行入口。日常页面操作、未知流程和系统窗口交互使用 Intent 的观察与决策合同；固定流程使用 JavaScript/Python Script。单次观察、动作、安装、权限夹具和诊断命令同样有独立价值。

1. 从任务、构建产物和设备状态确定目标。Android 动作明确传 `serial`，App 操作传 `packageName`；iOS 使用 `deviceId`/`bundleId`，Native Intent 还需绑定 `wdaRunnerBundleId`/`wdaSessionId`；Web 使用当前文档的 `sessionId`/`runtimeEpoch`/`targetId`。
2. 调用 `capabilities` 查询本次实际运行版本的命令。指定 `command` 时返回完整 `inputSchema`、`role`、`entrypoints` 和 Script 能力声明。先核对平台与参数，再派发。
3. MCP 只有 `capabilities` 和 `run`。所有命令参数放在 `run.arguments`，命令名使用 capabilities 原样返回的名称。JSON 数字、布尔值不写成字符串。Intent/Script/evidence 必须明确 operation；嵌套控制参数也以当前 inputSchema 为准，错误中的 field 指向需修正的字段。
4. 从当前观察取得 selector 或坐标。`tap-text` 的 `provider:auto` 按 Native、Flutter、UIAutomator 顺序观察并选择一次动作；`provider:native|flutter|uia` 可固定回归来源。结果中的 observations/provider 说明选择依据。动作前会重新定位，多重匹配、语义身份或前台变化应重新观察。UIA 同名控件可用当前 `uia-tree` 的完整 `targetRef`，或当前 Intent revision 的 `selector.nodeRef`；引用失效后重新观察。Native 前台弹窗会阻挡后台 Flutter 文字动作。
5. 按任务的真实结果验证。执行完成、机械动作成功、UI 变化、业务状态和证据覆盖分别判断；操作后使用本轮新证据。没有足够证据的断言保留为 inconclusive。

## 最小调用

```json
{"command":"tap-text","arguments":{"serial":"DEVICE","packageName":"com.example.app","targetText":"设置","provider":"auto"}}
```

`wait-text` 使用 `timeoutMs`（默认 10000），文字精确匹配；`requireText`/`absentText` 是字符串数组，不接受 CSV。所有条件必须由同一次前台 provider 观察证明。纯消失等待必须明确 `provider`，读取失败不能证明消失。`requireActivity` 是完整类名。Native Intent 输入必须有 SDK `editable:true`。

`tap` 是物理坐标；`tap-flutter` 是 Flutter 逻辑坐标。显式 App 目标必须匹配前台。系统 UI 使用已观察的系统目标与 device scope。已派发但结果未知时，先重新观察，不通过另一个 provider 重试同一动作。

CLI 和 MCP 共用独立执行 Runtime、命令 schema 和 operationId。客户端退出后任务继续运行；用任务 cancel 停止一个任务，或 `runtime operation:stop` 等待全部已拥有工作收尾。更换版本或 Runtime 环境先显式 stop，再启动。详细生命周期见 CLI 包内 `docs/COMMAND_CONTRACT.md`（仓库路径 `desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md`）。

`script` 的 start/status/wait/result/pause/resume/decide/cancel/runtime-status 操作用于连续执行和控制。start 使用 script 及其内部 target，语言明确为 javascript 或 python；调用失败和断言结果由源码处理。status/wait 和完成事件保留小型 resultRef；最终返回值通过 `script operation:result` 加原 operationId 从持久存储读取，核对 representation 和 hash。编写脚本前查询 `capabilities {"command":"script"}`；按需读取 CLI 包内 `docs/SCRIPT_AUTHORING.md`（仓库路径 `desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md`）。`app.lifecycle` 和 `app.permissions` 是可信调用者为回归夹具显式选择的额外能力。JS/Python 是 trusted-local-code，权限声明不是 OS 沙箱。

普通 Android 命令的 timeoutMs 是包括排队和 Provider 调用的同一 Host 预算，默认 30000 ms；不能用内部重试延长。Script 的 policy.timeoutMs 限制整个运行，单个调用只能缩短预算。取消期间状态为 cancelling，已拥有的调用、回执和检查点收尾后才写 cancelled；已提交但未确认的动作仍是 ambiguous，不能宣称撤销成功。安装/权限 Intent、iOS/Web 及等待条件的范围按包内 COMMAND_CONTRACT.md 判断。

普通 Intent 的 timeoutMs 默认 300000，覆盖初次观察、等待决策、暂停和后续动作。cancel 会中止并等待已拥有的操作收尾，终态必须先写入检查点；写入失败是 blocked_evidence_store。重启后的 intent status 从持久证据恢复终态，live:false、recovered:true，不自动重放；缺少终态时报告 interrupted/runtime_restarted。最后一个动作的 dispatched/ambiguous 仍需独立检查。complete/fail/inconclusive 决策同样必须提供当前 basedOnRevision。

`install-apk` 通过 CLI 或 MCP 返回一个 supervised Intent 操作。调用者用该 operationId 观察系统页面并提交基于 revision 的唯一 selector 决策；没有 Agent 决策不会点击按钮。安装完成由 ADB 回执和独立 APK 身份核验共同确定。安装作为 Script 前置准备，后续客户端可继续观察和决策；同步 ctx.call 不提供安装入口，详见命令合同。

`permission-dialog` 同样返回 Intent 操作：先由 App 触发权限请求，再明确 packageName、permission 和 outcome（allow / allow-once / deny / dismiss）。依据实际弹窗决定 selector，以 PackageManager 状态及原 Activity 关闭核验结果；pending:activity_closure 时用 intent observe 继续核验。intent cancel 只停止任务；dismiss 才表示操作界面关闭弹窗。权限状态与 grant/revoke 夹具继续可直接调用；详情见包内 docs/COMMAND_CONTRACT.md。

## 证据与平台

Android 和 iOS 四流在持久后端接入后读取手机 FactStore；Host 记录执行与观察，Web 采集在接收时写入 Host FactStore。核对实际 refs、epoch、目标、窗口、coverage 和分页，保留失败或不完整覆盖。Script 和 Intent 支持 Android、iOS 和 Web，具体 provider 与动作范围以当前 schema 为准；支持平台不等于该 App 业务已经验证。

用 `evidence` 导出并离线核验保留的执行记录与文件；归档完整不等于业务通过。错误返回保留 `error`、`message`、`dispatched`、`ambiguous` 和操作状态。在冻结 App 的诊断中，完成后恢复运行。

## 版本差异

当前候选版移除了 batch、样例专用启动/smoke 命令、旧 MCP 工具别名和外层重复参数。连续步骤写成 Script，Flutter 普通启动用 launch-app。运行版本不支持新合同时，明确报告版本差异；以实际发现的能力继续任务，不能把旧证据描述为本轮验证。
