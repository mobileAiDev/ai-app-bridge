# 命令生产化第三阶段 D：操作分支与嵌套合同

本阶段将 Intent、Script、Evidence 的公开操作分支与嵌套参数纳入同一份可发现、可执行的 schema，清理无效 policy 和重复入口，并修正 Script 持久恢复及自主 Intent 的调用预算边界。最终 **879/879** Host 检查、干净 npm 包、真实 MCP 合同验证及 OPPO 固定场景通过。

这完成了当前 Android 执行面的操作与参数合同关口，不代表 93 个命令全部达到生产验收。交付对象仍是 Bridge，本轮没有改样例 App 的产品功能；原四 App 完整覆盖、SDK 原子动作、跨平台、跨进程仲裁及压力门禁继续保留。

## 行为与接口改变

- 共享 `argument-schema` 校验公开 JSON Schema 的类型、边界、必填、互斥、操作分支和未知字段。注册表发现与实际校验复用 `execution-contracts`；原生、UIA、Flutter 决策还按当前观察的 provider 再校验。错误返回稳定代码和字段路径，如 `decision.action.selector.fuzzy`，并明确没有派发。
- Intent start 明确 goal、Android target 和模式。Autonomous 模式明确 agentModule、有限预算及动作 allowlist；require 使用明确 streams 和查询窗口，不能重定向目标。决策使用正整数 revision 和 provider 对应的 selector；终态决定不能附带动作。取消、超时和独立安装/权限核验语义继续保留。
- Script 只通过 `script` 提交 code spec，目标放在 `script.target`。语言为 javascript/python，source/sourcePath 二选一。policy 只保留实际生效字段；删除从未影响代码执行的 onFailure。源码检查调用结果与断言，未捕获异常使执行失败，暂停为显式操作。
- 删除 Script progress/intervene、Intent reobserve、spec/外层 target、语言缩写等公开同义入口。保留 status/wait 的进度读取和源码内 ctx.progress。Flutter 专家 payload 改为类型明确的 JSON 对象；CLI 单独负责 JSON 文本解析。Web 命令以 builtin 分支或显式 action 包装承载已注册的 App 动作。
- Script 恢复使用冻结检查点或完整调用者源码进行校验，不再拼接含 undefined 的输入，也不混合补齐两份程序。恢复 hash 继续覆盖源码、目标、权限、policy；已删除的 steps 检查点明确失败。
- 自主 Intent 的最后一次获准 Agent 回复可以执行或完成；耗尽预算后不会再发起一次调用。畸形回复不落 decision/dispatch marker，不派发，也不自动再次询问；保留 waiting_for_decision 供明确纠正。

以上包含破坏性接口调整，调用者应按当前 capabilities 更新请求。旧调用不会被静默映射，历史冻结证据未重写。公开说明见 [命令合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)，93 项机器合同见 [本阶段快照](audits/2026-09-08/command-contract-phase3d.json)。仓库与包内 Skill 已同步。

## 验证与证据

最终 `npm run check` 为 **879 项通过，0 失败、取消、跳过**，耗时 **18400.975416 ms**。日志：`build/phase3d-full-accepted.log`。新增验证覆盖分支互斥、字段路径、未知控制参数、类型/边界、JSON 业务值保留、编译输入隔离、非法 Agent 回复和预算最后一次调用。

实际 MCP 进程使用一个普通文件作为不可用 FactStore 路径，逐项提交 **49 类错误请求**，全部在存储打开、Provider I/O 和 Script 执行前拒绝。另通过真实加载的 Agent 模块和受控 ADB 子进程验证三个自主场景：最后一次回复完成、错误回复等待明确纠正、最后一次回复派发 keyevent 0 后停止，不增加 Agent 调用。这里的受控 Provider 不计作手机业务验收。

干净包目录为 `build/ai_app_bridge_artifacts/command-production-phase3d-package-final-2026-09-08/`。tarball SHA-256 为 **c7dc96f7fdcc9aa055e8e668a76bec650777e121bf5dae5dacfeeff9654ce4d5**。真实 npm install 与 native node-gyp 生命周期通过；两个 MCP 工具、93 个命令、结构化 Script 答案、权限四种结果、JS/Python 关闭收尾、Intent/权限取消与重启查询均通过。89 个非依赖文件与源码逐字节匹配；npm 标准化 package.json 单列排除，见 source-match.json。

真机使用先前安装目录 `command-production-phase3d-package-2026-09-08/clean-install/` 的 MCP；其 tarball SHA-256 为 `611ed72c99d0b09d37e3883f242276d772bd7ec800050e08c879384d8b12b54e`。之后只修正两份 Intent 文档中残留的旧别名说明并重新打包；逐项比较两个 tarball 的全部普通文件，仅这两份文档不同，所有运行代码与依赖源码相同，见最终目录 phone-code-match.json。最终包另行完成干净安装及 MCP 验证，手机数据对应明确记录的前一个包。设备为已授权 `b46093e6` / PKR110（系统品牌字段 OnePlus），App 为 `io.github.mobileaidev.notallyx.sample`。

| 真机场景 | 结果 |
| --- | --- |
| Intent 打开主题、确认弹窗遮挡、取消并完成 | completed；后台“外观”点击被拒绝，等待后台文字按预算超时 |
| JavaScript 同义回归 | completed；6 项检查，2 次实际动作、1 次被拒动作；2247 ms |
| Python 同义回归 | completed；6 项检查，2 次实际动作、1 次被拒动作；2319 ms |
| 普通 Intent 观察后完成 | completed，终态已落盘 |
| 初次 UIA 观察进行中取消 | cancelled，Host ADB PID 95081 已关闭；一次样本取消响应 5 ms |
| 等待决策耗尽 1500 ms 预算 | timeout/deadline_exceeded，1609 ms 时查询确认 |
| 初次 UIA 观察进行中关闭 MCP stdin | 正常退出；Host ADB PID 95162 已关闭，重启恢复 cancelled |

三份语义操作归档及四份生命周期归档，复制到新目录后，均在不可用 Store 和 ADB 配置下离线核验为 verified。归档完整性不替代业务断言；独立偏好、数据库、截图和原始调用结果另行保存在本轮目录。

真机产物根目录为 `build/ai_app_bridge_artifacts/command-production-phase3d-2026-09-08/`：device-semantic、device-lifetime、semantic-offline、autonomous-contract 各保留独立报告。主题打开/取消前后偏好 SHA-256 同为 `f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`。生命周期前后独立读取的所有业务表规范化 SHA-256 同为 `16090377a96644cacb5f82f11f257d7479573652efd4463d448a07676a11db21`（BaseNote 11、Label 11，其他表一致）。APK SHA-256 为 `ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。

前后截图与弹窗截图已逐张查看，保持系统主题并回到同一设置页。以上短场景时间是实际单次样本，不是 P95、整 App 回归或总计划的 5–10 分钟门禁证明。

## 保留的失败与工作区边界

严格合同首次运行暴露了旧测试中的语言别名、显式 undefined、无效 package、terminal action 等输入，以及实际的检查点恢复问题。修正生产路径，并把正向夹具迁移到新合同；未知参数仍作为拒绝分支覆盖。

`phase3d-full-release.log` 保留一次子进程 ESRCH 断言失败（878/879）。单独复跑通过；检查发现测试的 ready 文件可能先创建再写 PID，父进程可读到空字符串并将其转成 PID 0。已用受控时间窗口复现这一假失败机制，证据为 `phase3d-ready-file-reproduction.json`；原失败未记录 PID，因此不声称能追溯证实其唯一原因。测试握手改为写临时文件再原子 rename，并验证正 PID，退出和迟到副作用断言保持严格。最终全量与干净包均通过；未用延迟探测或宽松断言掩盖退出状态。

分支仍为 `codex/script-intent-isolated-rebuild`，HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`。本轮没有提交、推送或发布。保留前序未提交工作与原有 Flutter 锁文件；锁文件 Git blob hash 仍为 `465ddc1692212151de90707ace54d232f3b16de6`。baseline、fixture-migration、phase-changes 和 acceptance-summary 保存在本轮产物目录。

## 下一关

先补 SDK 内原子语义目标校验：在同一 UI 执行边界检查目标、前台窗口和操作条件，再执行动作，让 Host 观察后页面变化不能导致错误坐标落到另一控件。以通用 Native/Flutter 行为、错误窗口、重复目标和不可编辑目标测试验收；样例 App 只提供场景。

随后继续跨进程设备独占、安装准备的总截止时间/故障、更多权限组、H5 等待合同、iOS target/持久查询/Flutter 关联、Web 生命周期与真实 iOS 最小闭环。保留 LocalSend、Wikipedia、VLC、Organic Maps 原完整矩阵，以及多设备、长运行、断连、硬退出和存储故障门禁。本阶段不宣称这些已通过。
