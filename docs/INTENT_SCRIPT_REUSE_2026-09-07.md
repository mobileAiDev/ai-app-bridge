# Intent 证据复用实验：采证与独立编写

后续双设备授权、v2 源码与正式重复执行见 [2026-09-08 记录](INTENT_SCRIPT_REUSE_2026-09-08.md)。以下保留最初交付时的状态和来源。

本阶段目标是验证“Intent 探索留证 → 新上下文编写 Script → 固定夹具重复回归”。截至 2026-09-08，探索、独立结果复核、证据冻结、公开文档补充和独立 Script 编写已完成；三次正向、错误期望和取消的手机试验尚未执行。原夹具手机不在线，正在等待接回原设备或明确建立新基线。

样例仍是 NotallyX，验证流程是已有的全局搜索。本轮未修改 App 业务代码，也未新增 App 功能。

## 已冻结的材料

- 目录：`build/ai_app_bridge_artifacts/intent-reuse-2026-09-07/writer-bundle-v1/`
- 入口：该目录的 `HANDOFF.md`；输入契约为 `inputs.json`。
- 文件：100 份，32,630,296 字节；每份文件的 SHA256 已复核。
- `manifest.json` SHA256：`2225727647760f6a3131789e512371413baed63f63d6b8cb5b1d3d925d43b490`。
- 独立复核：上一级目录的 `archive-review.json`、`final-data-oracle.json`。

包内仅含任务、公开文档、实际能力目录、固定业务预期、逐次输入输出、截图及持久证据。没有既有回归 Script、App 源码或原探索控制器。使用约束禁止作者读取包外实现和历史；这是实验约束，不是操作系统沙箱。

中途的 `writer-bundle/` 是导出助手误把 screenshot 能力查询当作截图结果时留下的未完成目录，没有冻结 manifest，不得用作交接材料。正式包是 `writer-bundle-v1/`。

## 真实目标与证据

设备：OPPO PGFM10，Android 16 / SDK 36，serial `FYZLAU49X8OVQGJ7`。
包名：`io.github.mobileaidev.notallyx.sample`。
实际 server：当前仓库 `desktop/ai-app-bridge-cli/bin/mcp-server.js`，不是全局已挂载连接器。

安装 APK 在采集初始夹具时通过实际设备 APK 字节核对，SHA256 为
`ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。
夹具 snapshot ID 为 `5d50312d-9d71-44dd-87b8-5f03272613f8`。

| 场景 | 观察与独立核对 |
| --- | --- |
| 唯一标题 | 改查原本在首屏之外的 `AAB-TEXT-script-1788752487009-10e9d2`；过滤后的标题变化、收起键盘的整屏与滚动检查均显示唯一结果 |
| 正文匹配 | `第一行中文`；按列表容器裁剪区域读取上下两页，5 个标题的并集与固定数据库预期相同，关键截图已由 Agent 视觉复核 |
| 无匹配 | `AAB-NO-MATCH-20260907-reuse`；查询文本、零标题和空结果插图同时出现 |
| 清空与返回 | 清空输入后恢复笔记结果；退出搜索并重新观察笔记首页 |
| 业务不变性 | 主探索后及补查后分别停止进程采集 DB/WAL/SHM/偏好；与初始夹具精确比较，10 条笔记、11 个标签、偏好和附件均零差异，没有忽略字段 |

主探索 `intent-1788783677284-1`：18 次观察、10 个动作、11 个决策。
补查 `intent-1788784724552-1`：11 次观察、6 个动作、7 个决策。
两轮合计 108 条持久 envelope，包含 29 observation、29 summary、18 decision、16 dispatch-marker、16 action-receipt；14 张截图，71 份公开调用输入/输出。两轮 ledger 均无缺页/缺口。所有动作回执无歧义；动作成功与 UI 结果仍分别判定。

关闭 MCP 后，在副本上各重开两次 FactStore；108 条记录的 checksum 均通过，两次内容相同，原持久文件 hash 未改变。原始树由开发助手从关闭后的存储副本提取，不能据此声称公开 MCP 已有完整证据导出接口。

## 本轮发现并处理的信息缺口

1. **输入成功后可能仍观察到旧列表。** 补查真实记录保留了旧首条笔记与随后正确过滤结果，交接要求按结果状态等待。
2. **可见标记不足以证明内容可读。** 收起键盘后列表发生偏移，一些 title 被固定搜索栏遮住，但 provider 仍标为可见。本轮按容器 bounds 与截图复核；没有将文档说明称为运行时修复。
3. **整窗口滚动可能没有滚到列表。** 默认向上滚动的起点落在固定控件中，未移动列表；从观察到的笔记节点发起手势后成功。失败尝试被保留，没有当作滚动通过。
4. **截图与 Intent 观察还需调用方关联。** `summary.screenshotId` 为空，截图另行请求，以时间与相邻观察 ID 关联；没有原子截图/树保证。
5. **公开编写资料不够集中。** 新增 `desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md`，补齐 ctx.call envelope、断言返回值、事件等待游标、终态返回值位置、多页证据边界及控制点。补充 native 手势与截图约定，并把三份契约文档纳入 npm 包。

## 验证与成本

主探索的起止墙钟为 9 分 22.429 秒，补查为 2 分 36.577 秒。这包含 Agent 阅读和决策时间；两轮 Intent 请求往返合计 9.524 秒，不包含所有独立截图/树调用。不能用任一数值替代 Script 回归耗时或宣称速度比。

探索期间手机操作无需人工介入，Agent 提交了 18 个 Intent 决策。独立编写经历一次连接中断，不能把中断跨越的墙钟算成持续编写成本；详见下方作者记录。三次回归耗时和两个负例结果尚不存在。

文档中的原样 JavaScript 示例已通过真实 MCP/Node/手机执行，设备树断言通过。首个临时控制器误读了不存在的顶层 `lastSequence` 和 `result`，出现重复轮询与结果处理错误；手机上的示例本身完成且断言通过。保留 `authoring-example/` 的失败控制器记录，纠正为 `eventSequence` 与 `script_completed.result` 后，`authoring-example-r2/report.json` 验证成功。这些不是搜索 Script 的成功次数。

`npm pack --dry-run` 确认三份文档被打包；本轮没有生产运行时代码变化，未重复执行全部 647 项 Host 测试或重建 App。全局 MCP 与 Skill 未替换。

## 独立作者交付与验证器

用户已授权继续，作者以 `fork_turns=none` 启动，只收到冻结包路径、任务边界和父目录代码规则。父控制器没有提供 App/Bridge 实现信息或修改作者源码。作者的资料清单、时间与接口假设保存在 [独立编写记录](../examples/notallyx-sample/validation/intent-search-authoring.md)。一次 transport/stream 中断后恢复同一作者；首次保留时钟为 `2026-09-07T12:50:20.387Z`，恢复时钟为 `21:17:27.895Z`，完成时钟为 `21:27:58.686Z`。首次阅读精确时间及中断精确发生时间不可得。

- 原交付：`build/ai_app_bridge_artifacts/intent-reuse-2026-09-07/independent-writer-v1/`。
- 仓库中的逐字节副本：[intent-evidence-search.js](../examples/notallyx-sample/validation/intent-evidence-search.js)。这是待设备验证的实验 Script。
- source SHA256：`3f9864d958843f4f189f761535cfcf7f34f185ce6eaafb47fc52cc24f6e50877`。
- 冻结清单：`authoring-freeze-v1.json`；父控制器重新核对了原冻结包 100 份文件和交付源码。
- 作者完成语法检查、29 份冻结 raw observation 的解释检查和 11 项局部数据检查；没有调用 Script 入口或操作设备。这些离线检查不计作重复运行。

作者通过原始树中的显式空字符串处理清空状态，用截图前后相同的新树排除过渡结果，按页提交设备断言，另用代码断言汇总跨页集合。键盘返回 schema 在冻结材料中缺失，作者只保存原始返回，由父控制器按当前实现另行复核。滚动末端仍依赖冻结布局的几何变化与可见卡片，不能视为通用列表末端接口。上述限制不通过增加 App 功能解决。

父控制器 [run-intent-search-reuse.js](../examples/notallyx-sample/validation/run-intent-search-reuse.js) 已实现三次正向、错误期望和 askAgent 处取消的固定协议；每次冷启动前校验实际安装 APK 和固定数据库，运行后精确比较业务数据。输出保留完整调用、Host 事件、截图 SHA、设备断言、每页独立 UI 检查及原始 Spec。MCP 关闭后在副本上两次重开事实存储，检查动作标记、回执和起止 checkpoint；这不是把全部 UI/断言证据称为 Host FactStore 持久记录。

另一名代理只读审查了父控制器，未读取作者交付或接触手机。发现并修正的误判包括：清空输入但旧列表未刷新、失败或取消控制点后继续动作、截图跨越过滤过渡、持久动作顺序不正确，以及 checkpoint 的 hash 字符串正确但参数或动作计数错误。新增针对性反例测试覆盖这些边界。

2026-09-08 完整验证工具测试 `node --test examples/notallyx-sample/validation/test/*.test.js` 为 **115/115 通过**，0 失败、0 跳过，耗时 22.354 秒。其中本轮新增 UI/控制器测试 12 项、持久复核测试 29 项。持久测试使用真实 supervisor 和证据存储协议，设备动作与存储介质为内存替身；它们不代替手机运行。日志为 `.tools/intent-reuse-2026-09-07/validation-tests-2026-09-08.log`。源码语法检查与 `git diff --check` 通过。

## 下一执行点与设备阻挡

`device-preflight-2026-09-08.json` 记录：ADB 仅连接 OPPO PKR110（`b46093e6`），原 OPPO PGFM10（`FYZLAU49X8OVQGJ7`）不在线。本轮仅列出设备，没有操作 PKR110，也没有启动正式试验。更换 serial 会破坏已冻结的身份、布局与夹具前提，不能自动替换。

接回原 PGFM10 后，从仓库根目录执行；输出目录必须不存在，已有失败目录应保留：

```sh
node examples/notallyx-sample/validation/run-intent-search-reuse.js \
  --server desktop/ai-app-bridge-cli/bin/mcp-server.js \
  --serial FYZLAU49X8OVQGJ7 \
  --apk build/ai_app_bridge_artifacts/notallyx-migration/candidate-v6/notallyx-backup-count-v6.apk \
  --fixture build/ai_app_bridge_artifacts/intent-reuse-2026-09-07/baseline/fixture.json \
  --source examples/notallyx-sample/validation/intent-evidence-search.js \
  --bundle build/ai_app_bridge_artifacts/intent-reuse-2026-09-07/writer-bundle-v1 \
  --out build/ai_app_bridge_artifacts/intent-reuse-2026-09-07/runs-v1
```

如果选择当前 PKR110，需要另建身份、初始夹具、布局证据与作者修订，再重新冻结并从三次正向起算。执行中动作取消、断连、跨 App、安装交付仍是后续独立关口。本阶段尚未证明独立 Script 真机稳定复现，也没有新的 Script 耗时结果。
