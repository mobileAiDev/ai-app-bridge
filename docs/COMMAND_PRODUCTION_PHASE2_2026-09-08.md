# 命令生产化第二阶段：权限 Intent 与真实状态核验

本轮交付对象是 AI App Bridge。NotallyX 仅触发已有麦克风权限请求，业务代码未改。基线为 `4da58fa` 加第一阶段未提交工作区；当前仍有 93 个公开命令，原 97 项审计逐项处置表继续维护。

## 已完成

- `permission-dialog` 从固定 allow 文案/资源 ID/点击循环改为 MCP supervised Intent。复用现有 observe、revision、decision、dispatch marker、receipt、设备仲裁与证据存储；不新增独立执行协议。
- 调用者明确 `serial/packageName/permission/outcome`。观察真实 UI 后决定唯一 selector；支持 `allow / allow-once / deny / dismiss`。Agent 的 complete 不能代替系统核验。
- ActivityManager 绑定请求 App、Android 用户、UID、Activity 实例；输入前重新核对请求和权限状态。UIA selector 在当前树重新解析，标签变化与重复匹配停止派发。
- 原权限 Activity 退出与 PackageManager 授权结果共同决定完成。Activity 尚在退出时返回 `pending:activity_closure`，用 observe 继续核验，不重放按钮。
- `intent cancel` 只停止任务，等待已提交输入结束并记录实际状态；`dismiss` 才执行关闭弹窗。超时在输入前检查实际 deadline，不能因定时器调度延迟继续输入。EOF/SIGTERM 收尾后再关闭 FactStore。
- `permission-state/grant/revoke` 保留为直接能力，Script 仍可声明 app.read/app.permissions。查询真实设备指定包、指定用户的 runtime permissions，按 `|` 正确解析 flags；grant/revoke 一次 pm 提交后独立读回。缺失、未知、系统拒绝和结果不符有分别的错误。
- 更新当前命令合同、完整命令处置表及仓库/发行包 Skill。全局已安装 Skill 未作为开发事实源。

## 当前代码验证

最终 `node --test`：**770/770 通过，0 skipped，16.175 秒**，日志 `build/phase2-full-accepted.log`。覆盖四种结果、陌生 ROM 包名/文案、多用户/权限解析、请求者与 Activity 变化、过期 revision、错误期望、无动作外部变化、取消/超时、输入前及进行中取消、持久化失败与设备租约释放。

实际 MCP 子进程验证了权限工作流与 Script 的 grant/revoke/state 调用。stdin EOF 后，新进程重新读取 FactStore，证明等待中的工作流已取消、没有输入；发行包另验证 SIGTERM 同义收尾和归档。

真实 npm pack → 全新目录 npm install → native install lifecycle/node-gyp → 安装产物公开 MCP 验证通过。公开工具仍为 capabilities/run，命令数 93。发行包 79 个非依赖源文件与当前工作区逐字节一致；未发布 npm。

- tarball SHA-256：`2298a617418b6561dc4f0769b2142dadb1620227828a0e503c2c940e9a3e7d88`
- 发行验证：`build/ai_app_bridge_artifacts/command-production-phase2-package-final2-2026-09-08/report.json`
- 文件对应：`build/ai_app_bridge_artifacts/command-production-phase2-package-final2-2026-09-08/source-match.json`

## 最终发行包真机验收

OPPO `b46093e6`，PKR110 / Android 16；样例 `io.github.mobileaidev.notallyx.sample`，7.11.2-aab-baseline / 71120。使用干净安装目录内的 MCP server，控制器源码已冻结到本次目录。以下每个肯定结果同时保留实际 UI 决策、动作回执、PackageManager 读回、原 Activity 关闭和独立原始 dumpsys 文件。

| 场景 | Intent ID | 结果 | 实际授权状态 | 原弹窗 | 输入次数 |
| --- | --- | --- | --- | --- | --- |
| `cancel` | `intent-1788869654319-3` | `cancelled` | false；flags 保持原状 | 保留 | 0 |
| `dismiss` | `intent-1788869656843-4` | `completed` | false；flags 保持原状 | 关闭 | 1 |
| `deny` | `intent-1788869663999-7` | `completed` | false；包含 USER_SET | 关闭 | 1 |
| `allow-once` | `intent-1788869673186-10` | `completed` | true；包含 ONE_TIME | 关闭 | 1 |
| `allow` | `intent-1788869682535-13` | `completed` | true；无 ONE_TIME | 关闭 | 1 |

`cancel` 期间，另一条设备变更命令返回 target_busy；停止后同一弹窗仍在，随后由新的 dismiss 操作关闭。允许和仅本次允许后只观察录音页的 `00:00`，随后返回列表，没有操作开始录音按钮或创建音频附件。

验收控制器中的 NotallyX 导航 selector 来自本轮 Intent 观察；它是固定样例的测试控制器，不是 Bridge 内置权限文案规则。普通 shell 的 pm revoke 在此 OPPO 上被平台 SecurityException 拒绝，产品返回 permission_change_denied、平台原因及未改变的读回状态。测试夹具复位显式使用设备原有 Magisk root，只撤销该样例的 RECORD_AUDIO、清理 USER_SET/USER_FIXED；产品没有自动提权路径。

最终恢复为 granted=false，仅保留原 USER_SENSITIVE_WHEN_GRANTED/USER_SENSITIVE_WHEN_DENIED。发行包矩阵后，独立复制的 SQLite 全业务表行内容与矩阵前一致：11 条 BaseNote、11 条 Label 及 android_metadata 的行 SHA-256 均一致；APK 字节哈希也未变。

- APK SHA-256：`ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`
- 真机结果：`build/ai_app_bridge_artifacts/command-production-phase2-permissions-2026-09-08/device-matrix-packed2/report.json`
- 冻结控制器：同目录 `controller.js`；MCP 请求响应：`mcp.jsonl`；独立结果：`oracle-*-package.txt`、`app-after-*.json`
- 样例前后对照：`build/ai_app_bridge_artifacts/command-production-phase2-permissions-2026-09-08/business-after-packed.json`
- 最终 APK：同目录 `apk-after-packed.json`；授权恢复及显式 root 夹具调用均有记录。

## 离线归档

最终五份 Intent 归档共 32 条记录。复制到新目录后，在新 MCP 进程中将 FactStore 指向不可用文件、ADB 指向不存在路径，五份归档仍全部 integrity=verified。结果位于 `build/ai_app_bridge_artifacts/command-production-phase2-permissions-2026-09-08/offline-packed/report.json`。

- cancel：`a7d379e85735f36207a36f80ffcb67940fc5f138d4102d5372fc4529c9b3bfa3`
- dismiss：`6e154e760a52f784a75737debcf8c8ce86e11dddefe94486b30f8e95bbc746b0`
- deny：`0c09d790b9a9a45402df317f645616aa48480bab480100a24127ea51e783974a`
- allow-once：`670b2aa4a4da72295b2ff4121581f467df713e22a1b106a3a5e21624726c3183`
- allow：`d9988637c9b343cb34fbba95b80bff04f5994a35b4d931bc88865be59950d4a2`

归档完整性与业务结果仍分别判断。本轮业务结果另有原始 PackageManager、录音页状态和独立数据库对照，不以归档校验本身代替验收。

## 保留的失败与范围

- 初次前台已切到其他 App，工作流返回 permission_dialog_not_found、零输入。组件短名/全名的比较缺陷导致过一次不确定观察，已修复并加入测试。
- 早期测试控制器在 UI 尚未加载完成时连续返回/找不到导航目标；失败结果保留在 device-matrix-final、device-matrix-final2。控制器改为重新观察，并以实际 MainActivity 到达为清理结束条件，未改样例代码。
- 首次发行包真机尝试的 launch-app 在 15000ms 超时，该次保留为失败（device-matrix-packed）。重新核对前台后，以显式 adbTimeoutMs=30000 做了独立完整验收；未把超时请求或其不确定结果当成通过。全命令启动/等待 deadline 的统一仍属下一阶段。
- 与打包并行的全套测试中，10k 节点 p95 曾为 33.496ms，超过现有 20ms 门槛。保留 phase2-full-final.log，不降低门槛；串行完整测试及最终独立 node --test 都通过。此处不据此声称持续负载下性能已验收。
- Android 请求探针当前要求一个 top-resumed Activity 及其详细记录；多显示器/不支持的 dumpsys 格式明确报错。ActivityManager 此记录不公开权限列表，Agent 根据实际页面确认语义，再对指定 permission 独立核验。权限组、后台权限和 app-op 不由一个 grant 位推导。
- deny 的 USER_SET 与已观察控件共同构成证据，不把它解释为所有“拒绝后是否再询问”的策略等价。普通 shell 可否 grant/revoke 取决于设备授权，root 测试复位不代表普通设备都支持。
- 单进程设备仲裁仍不覆盖另一 Host、外部操作或骤然进程死亡；iOS/Web 未获得此 Android 权限合同的同等验证。

下一轮按命令组统一点击、输入、滑动和等待的定位、操作参数、deadline 与取消合同，同时保留 Native/Flutter/UIAutomator 的必要观察选择能力。之后继续跨进程独占、安装故障分支及 iOS 最小真机闭环；不扩展样例 App 产品功能。
