# 命令体系生产化：第一阶段结果

日期：2026-09-08。基线 `4da58fa`，分支 `codex/script-intent-isolated-rebuild`。本轮为未提交工作区改动，未发布。

## 交付与整体范围

对基线全部 97 项命令逐项检查并给出处置，当前保留 93 项。详见 [完整处置及整体设计](COMMAND_SYSTEM_REDESIGN_2026-09-08.md) 和 [机器合同](audits/2026-09-08/command-contract-phase1.json)。Intent/Script 为一等执行入口；保留必要观察、物理交互、权限夹具、安装、启动、清数据和专家诊断。删除重复 batch、sample smoke/固定启动命令、旧多工具别名、旧 dispatcher 和 Script 经 MCP JSON 转发的中间层。

CLI/MCP 与 Script 的能力目录、基础类型、目标、permission、错误由共享注册表约束。参数拒绝未知字段、隐式 JSON 类型转换及非法坐标；支持 keyCode=0。一个 Host 进程内所有 Android 变更按物理 serial 仲裁，嵌套动作保留所有权。请求 ID 内容冲突不复用旧结果。显式 App 目标不符不得点击；SDK/WDA 动作结果未知时不换通道重放。tap-text 自动 Native→Flutter→UIA 发现保留，在观察阶段确定来源，选择后一次派发，歧义停止。

这不是全部命令已经生产验收；完整嵌套 schema、语义定位/观察新鲜度、统一 deadline/取消、跨进程与跨平台仍有明确工作。

## 安装已经接入 Intent

公开 MCP `install-apk` 返回普通 supervised Intent 的 operationId。Host 冻结 APK 副本、解析 manifest、验签并记录 SHA256，提交一次 ADB 安装请求。系统交互经同一 `intent observe/decide/cancel` 协议处理；安装模块没有 ROM 包表、按钮文本白名单或轮询自动点击。Agent 根据实时页面选唯一 selector，动作关联观察 revision、decision、marker 和 receipt。

完成条件为 ADB 成功回执加手机实际安装 base.apk SHA256 与已验签文件完全相同。旧包存在不能使新请求通过；Agent 的 complete 不能覆盖独立核验。安装作为固定 Script 前置准备，不暴露为同步 ctx.call 或一次性 CLI 命令。取消停止并等待 Host ADB 进程结束，再核验实际安装状态；不承诺 Android 已提交安装的回滚。

真机：OPPO PKR110，Android 16，serial `b46093e6`。只操作 LocalSend 测试包 `org.localsend.localsend_app.bridge_sample`。
APK：LocalSend 1.18.2 / versionCode 64，186770497 字节，SHA256 `7a2b4794bfb2dda4fd373b9f6ba74e311ae6094f3045c9ee2397ddfb9a38f4f6`。

- 覆盖安装：`intent-1788863655802-1`，无系统提示，ADB 成功，安装路径改变，手机 APK hash 一致。
- 全新安装：`intent-1788863740270-1`，安装前独立查询包不存在；观察 `com.oplus.appdetail` 安装引导页，显示实际 App/版本及两个按钮。Agent 依据 revision 2 的观察提交 `confirm-current-apk`，唯一 selector 为该页面真实 btn_left。一次点击后安装成功，独立 hash 一致。
- 安装期间另一条 keyevent 返回 `target_busy`、`dispatched:false`，实际设备仲裁生效。
- 完成后的系统窗口转换曾使后续观察返回 `foreground_changed_during_observation`；该失败保留。安装完成依据独立安装物核验，不把变动中的 UI 树当成稳定新观察。
- 本轮还实测 tap-text 自动选择：Native 未匹配，Flutter 唯一匹配设置，按逻辑坐标一次成功派发。

证据：[安装报告](../build/ai_app_bridge_artifacts/command-production-phase1-install-2026-09-08/report.json)、[安装页截图](../build/ai_app_bridge_artifacts/command-production-phase1-install-2026-09-08/fresh/installer.png)。两个安装与初态准备共三份归档复制后在新 MCP 进程验证，通过；验证环境指定不存在的 ADB 与无效 Host store 路径，未依赖活动 worker/源 store。

## 自动化与发行包验证

- Host `npm test`：754/754 通过，0 跳过，约 13.941 秒；[完整日志](../build/phase1-full-v6.log)。安装专项 9 项包含无决策不动作、陌生文案/包、旧 revision、前台变化、独立身份不符/不可读、失败/超时/取消、落盘失败前不派发和单次进程控制。
- 实际 `npm pack` → 干净目录 npm install → 原生 node-gyp 编译 → 包内 CLI 帮助、两工具能力发现、Script runtime 与受控 ADB/UIA/按键调用通过。93 个入口，Script completed，实际 UIA 深度过滤、keyCode=0 和结构化 Agent 回答均通过。此项使用受控传输，不冒称手机测试。
- [打包报告](../build/ai_app_bridge_artifacts/command-production-phase1-package-final-uia-2026-09-08/report.json)，tarball SHA256 `0c86565b01d1024d752d15020459d9bba689c13f93a4955f1eaec062ca6a23b9`。npm 12 对 bundled native 的 allowScripts 提示仍存在；本轮源码核实该提示为 advisory，最终通过 foreground-scripts 日志直接证明 install lifecycle 与原生编译完成。
- [最终源码核对](../build/ai_app_bridge_artifacts/command-production-phase1-package-final-uia-2026-09-08/source-review.json)：发行包中 78 个代码/合同/Skill 文件与最终工作区逐字节一致；机器合同与当前公开发现一致；97 项基线无遗漏或重复；专项 111 次调用仍满足最终注册表。两份冻结脚本及原有 Flutter lockfile 未改。

专项 Script 源码保持 SHA256 `d3cf883186dcc636a19c412bdfd68b35bf8c1374cd497dd81d072cc2f27b1e03`，动作和断言未改，只给控制器增加显式设备参数。当前 OPPO 上三次正向分别为 8.651、8.338、9.046 秒；每次 6 个动作、4 个真实路由事实、18 项断言通过。错误设备名按预期 failed，0 个动作；等待 Agent 时取消后没有新调用，0 个动作。三次正向共 6 次独立偏好读取吻合，前后系统主题/颜色一致。

[专项五轮结果](../build/ai_app_bridge_artifacts/command-production-phase1-script-matrix3-2026-09-08/report.json) 的 5 份归档均在源 MCP 退出后复制并离线核验。另有 55 个外部证据文件，6 份偏好结果的时间、目标、对应问题/答复和路由关联均通过检查；[外部证据清单](../build/ai_app_bridge_artifacts/command-production-phase1-script-matrix3-2026-09-08/external-evidence/manifest.json) SHA256 为 `94721f6554ea941947a844c68ecdd728c89c839c8539af1904274f748c00271a`。

这只对应主题菜单专项，不代表原完整场景或全 App 覆盖。另补跑原 v1.0.5 完整脚本，源码 SHA256 `e193188913c89c76cd30769e09c70887cec74c2df5bed60475cf8937a29aa985` 保持不变；结果未通过，原因与后续实际阻断见下文。

## 保留的失败与尚未验证项

早期清理误删 UIA 读取 retry helper，造成旧安装尝试无有效观察并超时；已修复为有界只读重试，并加入实际包内 UIA 调用验证。旧安装失败记录保留在 `build/phase1-install-oppo.json`。

早期全量测试保留旧 batch/别名预期、一次从错误 cwd 启动以及恢复测试的未设界等待；逐项修正后最终全量通过。另一次并行全量中的时间阈值失败保留，原阈值下专项 15/15 再验通过，未放宽性能指标。[性能复验](../build/phase1-performance-recheck.log)。

首次干净包验证器把 npm advisory 误判为脚本未执行，记录保留在 `build/phase1-package-final.log`。改为记录和检查实际编译日志后通过；没有关闭 npm 安全策略。

新手机重新安装后生成不同设备名；第一轮固定 Script 的“expected device name”明确 failed，0 个变更动作。这是夹具不符，不能算通过，失败记录保留。后续按冻结脚本所需初态通过 App UI 设置，不能修改断言来掩盖。初态探索还保留一次 Agent 把 nodeId 放错层级而被拒绝的记录；表明完整 decision schema 仍应优先补齐。

第二次专项矩阵暴露本轮注册表把 `script decide` 限定为字符串，原结构化偏好核验回答被拒绝。已按真实 JSON 回答合同修复，并验证对象/数组/null/false/0/空字符串、同内容重复回答及冲突回答；第三次专项矩阵通过。失败矩阵和恢复初态的 Intent `phase1-fixture-restore-after-schema-fix` 均保留，未改断言。

原 v1.0.5 完整脚本在文件选择器处被本轮 schema 漏列 `uia-tree.maxDepth` 拒绝；已补齐原本真实实现支持的参数，并把深度/数量边界与实现对齐，公开 MCP 测试和最终发行包均验证实际节点过滤。其 [失败记录](../build/ai_app_bridge_artifacts/command-production-phase1-original-script-2026-09-08/report.json) 与离线可验证的失败归档保留，不能改记为通过。

修复后另行真实 [UIA 读取](../build/ai_app_bridge_artifacts/command-production-phase1-install-2026-09-08/fixture-after-picker/001-uia-tree.json) 显示当前 PKR110 文件管理器被 `com.oplus.safecenter` 的“使用指纹验证”应用锁拦住；完整文件选择流程需要用户在手机上认证。系统截图只保留黑色页面与指纹图标，应用锁文字依据真实 UIA。没有更改或绕过手机应用锁。此外，代码核对发现旧完整脚本的 picker 取消使用 `tap + feedback:off`，按新合同应在新脚本版本中显式增加 `scope:device`；这是有意取消隐式通道选择后的调用方调整，不应恢复旧隐藏 fallback 来让冻结版本通过。该完整场景尚未重新验收。

剩余：安装真机取消/超时/断连、不同 ROM、split APK、Host 突然死亡和跨进程设备所有权；permission-dialog 的固定允许标签流程；统一语义选择与等待/取消；iOS/Web target 与真实持久查询及真机同义闭环。当前不宣称整机/全 App/跨平台生产完成。
