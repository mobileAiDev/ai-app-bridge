# 备份 Script 与异常验证

2026-09-07。本轮已完成：备份 R8 与核心 + 备份联合 R9 的业务、结构 UI 和独立数据判定通过。最终看图发现导出附件计数错误，已在 candidate-v6 修复并完成真机导出补测；R9 原始视觉失败保留，不改写为通过。

设备 OPPO PGFM10 / Android 16 / `FYZLAU49X8OVQGJ7`，隔离包 `io.github.mobileaidev.notallyx.sample`。本轮 candidate-v5 APK SHA256：`b026feb4c44e6711e50735617ea25aa348ae066d4c5461307f15456621c43aad`；固定夹具 v2 SHA256：`8a539a938deb663d395ab771e7164103c6cfe0a67e305acb77f575fce3c397e2`。v5 覆盖安装前后完整业务 canonical 零差异，仍为 10 条笔记、11 个标签。

这轮把上一轮 Intent 验证的 ZIP 导出、取消、真实删除后恢复与冷启动流程编写为真实 Script，再加入损坏 ZIP、缺少数据库和密码分支。执行通过仓库公开 MCP server 和 Script SDK；没有用 FakeHost 或 batch 代替业务运行。当前已安装的外部 connector 版本未提供这套 Script 命令，尚需版本对齐；本次运行使用的 Host 源码已冻结。

## 本轮矩阵

| 页面/分支 | 操作与结果 | 独立证据 | R8 |
|---|---|---|---|
| 设置备份区 | 导入、导出入口可操作 | 同状态截图、前后树、Host 调用关联 | 通过 |
| 系统导出目录 | 经 OPPO 文件选择器进入专用 Documents 子目录，保存观察到的默认文件名 | UIA、实际 ZIP 回读 SHA、CRC、内嵌 SQLite 与导出前一致 | 通过 |
| 导入密码框 | 标题、输入、取消、提交与默认去重勾选 | 树与截图；自定义勾选需人工看图 | R9 六个弹窗已查看，默认去重均勾选 |
| 取消导入 | 返回设置且数据不变 | 停机后的全量数据库、偏好、附件清单 canonical 零差异 | 通过 |
| 损坏 ZIP | 拒绝，进度结束；再次打开选择器正常 | 明确错误 Toast、当前 PID 异常日志、DB 零差异 | 通过 |
| 缺少数据库 | 拒绝，页面恢复可操作 | 夹具成员清单、`No file found with name NotallyDatabase in zip file`、DB 零差异 | 通过 |
| 错误密码 | 拒绝 AES 夹具，页面恢复可操作 | 固定密码负例、App `Wrong Password` 异常、DB 零差异 | 通过 |
| 正确密码 | AES 备份读取后按默认设置去重 | 已查看成功 Toast：导入 0 条、10 个重复项；ZIP 解密内容比对与 DB 零差异 | 通过 |
| 永久删除后恢复 | 只删除指定清单，从本轮新 ZIP 恢复；仅该记录获得新 ID | 全量字段、其余记录、标签、偏好与删除前逐项核对 | 通过 |
| 冷启动 | 父子清单、顺序和勾选内容保留 | 新周期 UI、停机 DB，以及独立 epoch 证据读取 | 通过 |

R8 共 9 个业务阶段、104 次 Host 动作、45 UI 检查点和 10 份业务数据库快照，另执行 9 个只读 epoch 验证 Script。备份套件 **633.285 秒（10 分 33.285 秒）**，包含准备与基线恢复总计 **651.556 秒**。R8 与后续 R9 的控制器校验源码不同，保留各自归档，不能把它们当成同源码性能对照。

## 联合 R9 的最终结果

联合目录为 `script-core-backup-oppo-r9/`，核心 runId `script-1788775230770-5f0a68`，备份 runId `backup-1788775553474-5f90d7`。两个套件使用同一 v5 APK 和本轮真实交接的数据。

| 指标 | 核心 | 备份 | 联合 |
|---|---:|---:|---:|
| 业务阶段 | 18 | 9 | 27 |
| UI 结构检查点 | 76 | 45 | 121 |
| 业务数据库快照 | 19 | 10 | 29 |
| Host 动作 | 216 | 104 | 320 |
| 归档文件 SHA 复核 | 1,365 | 459 | 1,824 |
| 持久证据记录读取及再次重开 | 468 | 244 | 712 |
| 套件时间 | 322.253 秒 | 649.733 秒 | 971.986 秒 |

联合套件 **16 分 11.986 秒**；加固定夹具准备、结束还原与重新启动，总计 **16 分 31.239 秒**。29 个业务快照不包括控制器准备/恢复的额外快照。27 个业务 Script 加 9 个只读 epoch Script，实际是 **36 个 Script operation**。9 次当前周期验证通过，8 次明确拒绝上一周期混入；操作后日志读取 24–484 ms，中位数 391 ms。

核心产生的新清单交给备份测试，没有中间重置数据。笔记数为 10 → 12 → 删除后 11 → ZIP 恢复 12 → 还原基线 10，标签为 11 → 13 → 11。`joint-review.json` 从原始采集文件重读，确认套件交接 canonical 完全相同，最终精确恢复同一份基线；R9 结束后重新打开 sample。

离线复核保存在 `core-archive-review.json`、`backup-archive-review.json`、`core-durable-review/review.json`、`backup-durable-review/review.json`。前者重新计算数据库与 UI，备份 reader 再从 ZIP 原件解读 SQLite；后者对关闭后的 Host store 副本逐条校验 checksum、关闭后再次打开，并确认原文件 SHA 未变。`core-visual-review.json` 保留四张三态标签弹窗的人工判断；`backup-visual-review.json` 保留全部 45 图的概览复核与下面这条真实视觉失败。

## 看图发现的 App 缺陷及 v6 补测

R9 的实际 ZIP 只有 `NotallyDatabase`，独立数据库也证明附件总数为 0，但 [导出提示](../../../build/ai_app_bridge_artifacts/notallyx-migration/script-core-backup-oppo-r9/backup/export/export-returned.png) 写着“已导出 12 笔记（12 附件）”。因此业务归档成功与 UI 文案正确是两项不同结论；v5 视觉结果保持 failed。

源码 `ExportExtensions.kt` 将 `databaseOriginal.audios` 的 JSON 行数作为音频数，每条笔记的空 `[]` 都被计成一项。现在先将各行解析为真实 Audio 条目，再计算总数并遍历导出，没有增加测试专用业务接口。

candidate-v6 APK SHA256：`ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。App 测试重新执行 **212/212**；SDK/Host 未改动。覆盖安装前后完整业务 canonical 零差异，新夹具 v3 SHA256：`d54ec5420f5b11a154b2165013750b870e6b81b82cf1a062ce4217d880749b51`。

`export-count-oppo-v6-r1/` 复用 R9 冻结的真实导出 Script，**57.200 秒**完成 9 次动作、3 个 UI 检查点、2 份 DB、实际 ZIP 重读以及重新启动。新 [导出提示](../../../build/ai_app_bridge_artifacts/notallyx-migration/export-count-oppo-v6-r1/export/export-returned.png) 为“已导出 10 笔记（0 附件）”，与独立数据一致；20 条持久记录关闭/重开校验通过。`visual-resolution.json` 关联原缺陷、APK、截图 SHA 与零差异基线。手机当前安装 v6，仍为原始 10 条笔记、11 个标签。

**完整联合计时属于 v5；v6 完成了受变更影响的无附件导出定向验证。** 未将 27 阶段自动追认为 v6 全量复测，也未据此声称非空音频附件已验收。

## 两个基础设施修复

**当前周期日志查询超时。** R3 在导出完成后，查询日志触发 HTTP 超时。独立端点请求约 10,049 ms 后返回 `capture_scan_deadline`，未获得完整覆盖。源码定位为当前周期查询从分区起点扫描大量旧周期 payload；当时历史库约 201 MB，不能以清库消除这个问题。

SDK 现在在持久库串行 writer 的 attach 时记录明确的起始 sequence，只让 `legacy-live` / `decision-window` 当前周期查询跳过不可能属于当前周期的旧 payload。显式 `connected-history` 和历史 ref 查询保留原有扫描范围；没有删除历史库。真实 mapped store 回归测试先失败，再验证当前周期不扫描旧 payload、新事实仍可读、旧 ref 仍可从历史视图读取。R8 的 9 次操作后日志读取为 14–509 ms，这只是本轮观察值，不是 P95 或普遍性能保证。

**跨应用调用的历史归属错误。** R7 的导出 Script 已完成，但独立 UI oracle 拒绝了文件选择器观察：`observation_not_bound_to_trusted_host_call`。派发目标实际为 picker，Host execution ledger 却统一记为拥有 Script 的样例 App。`script-ledger.js` 与 progress projection 现在对调用/动作回执采用显式参数中的实际目标；Script 生命周期事件仍属于样例 App。新增测试覆盖两者分离，未放宽 oracle 的包名核对。

## 证据与计时边界

每个 UI 检查点保留原始树 → 截图 → 新树，要求可见语义和位置相同、前台组件正确、PNG SHA 与返回值一致，并关联本次 Host 调用及强证据断言。原 App 用 native tree，系统文件选择器用 UIA；返回 App 时先确认真实前台，避免拿后台 App 树验证选择器截图。

导出文件从手机回读；独立 Python reader 检查 CRC、唯一数据库成员、SQLite integrity、Room identity、每条笔记/标签的真实字段。负例 ZIP 在电脑生成后逐文件推送并从手机回读 SHA。Java Zip4j 的 AES 成功解密和错误密码反证只证明测试向量，本次 App 成功导入还要求实际成功提示与持久数据校验。

异常日志必须属于本阶段进程 PID、设备端起始时间之后且为错误级别。取消、错误输入、重复导入均比较完整 canonical，不以记录数相同代替全字段相同。恢复只允许指定清单重新分配主键，其余记录和所有其他字段必须一致。

每阶段冷启动等待 capture 持久库 attached，再记录设备时间和 runtime epoch。业务操作完成后，在同一周期启动只读 Script，要求当前窗口真实 events refs 完整，并将上一周期查询明确判为 `runtime_epoch_changed` / `inconclusive`。这证明 attach 后所声明窗口的周期归属，**不证明从进程启动第一刻开始无丢失采集，也不把所有 events 视作某次业务动作的因果回执**。启动附着前的缺口和空证据不被改写为通过。

时间包含脚本动作、页面等待、截图/树、每阶段停机采集与重开、ZIP/数据库判定、9 次额外 epoch Script 以及源码核验。固定夹具准备/恢复另计；离线独立复核和人工看图不计在套件时间内。本轮扩大了检查范围，不与原 4 分 37.874 秒套件直接比较，也没有测量 Agent/model 探索时间。

## 已执行的门禁与失败记录

- 页面细节：为 9 个分支生成 45 个固定 UI 检查点；可见元素、唯一选择器、前台和截图同状态均为强制要求。默认去重勾选、自定义三态与 Toast 保留独立视觉复核。
- 流程：R8 导出、取消、真正删除、恢复及冷启动已完成；原始 10 条/11 个标签恢复成功。
- 异常：损坏 ZIP 的 Intent 已有真实拒绝和 DB 零差异；Script 已新增缺库、错误密码和正确密码对照。三个错误分支都重新打开选择器证明进度已解除。
- 审查：Host `npm test` **647/647**、Android SDK **114/114**、App **212/212**、验证工具 **74/74**。联合 R9 的离线归档、持久记录重开和基线交接复核均通过。结构 UI 自动判定通过后，独立看图仍检出了附件计数缺陷；v6 定向复测已关闭该缺陷。

失败原件全部保留在 `script-backup-oppo-r1` 至 `r7`：R1 辅助模块在临时执行目录无法解析；R2 过早接受后台 App 树导致截图前台不匹配；R3 历史扫描超时；R4/R5 附着前窗口不完整；R6 空 events 不能成为强证据；R7 跨应用 Host 目标归属错误。它们分别属于脚本编写、证据约束和 Bridge 缺陷，不能全部记作 App 业务失败，也不计入连续稳定运行统计。

Intent 新负例保留 `intent-1788772507570-3` 成功操作及其原始前后 DB。先前两个 Intent 操作的非法 action 字段和选择器参数错误也保留；缺库和密码分支是本轮新增 Script 实验，未冒充历史 Intent 已验证的流程。来源见 [backup-source-evidence-index.json](backup-source-evidence-index.json)：243 项原始证据 SHA 索引，路径指向本机归档，不是可独立分发的完整源证据包。

## 运行与复核

以下为当前 v6 / v3 夹具的执行入口，仓库根目录执行且必须使用新输出目录。R9 历史测量采用上文 v5 / v2 身份；本轮没有对 v6 再跑完整联合套件。仅适用于明确的 OPPO 与无附件/提醒/自动备份副作用的私有固定夹具：

```bash
node examples/notallyx-sample/validation/fixed-fixture.js run \
  --suite core-backup \
  --serial FYZLAU49X8OVQGJ7 \
  --apk build/ai_app_bridge_artifacts/notallyx-migration/candidate-v6/notallyx-backup-count-v6.apk \
  --fixture build/ai_app_bridge_artifacts/notallyx-migration/fixed-fixture-oppo-v3/fixture.json \
  --out build/ai_app_bridge_artifacts/notallyx-migration/script-core-backup-next \
  --zip4j-jar /Users/macbook/.gradle/caches/modules-2/files-2.1/net.lingala.zip4j/zip4j/2.11.5/4214e396e3891cb19eded3ce5e584cba9032fdc3/zip4j-2.11.5.jar
```

`--suite core` 只跑原核心套件；`--suite backup` 需再明确指定基线中受控清单的 `--note-title`。所有请求范围成功才还原基线；失败先保留数据与证据。还原只涉及 sample 私有 DB/WAL/SHM/偏好，不删除各轮 Documents 导出证据或回退系统 URI 授权，四文件替换仍不是掉电原子事务。

备份离线复核使用 [review-backup-regression.js](review-backup-regression.js)，读取冻结 oracle，重算全量 DB、从 ZIP 原件重新解出并读取 SQLite、重核 UI/Host 绑定、9 个 epoch 证据与三个异常进程窗口，不直接相信保存的 passed 字段。

## 下一步范围

先补 App 自身设置密码并导出 AES、关闭去重、带附件/提醒与混合文件夹的恢复、缺附件和部分坏记录、系统选择器取消和权限拒绝，再扩展整机多 App 编排。

完整 App 的 **143 模板、311 参数化变体**保持原定义；当前核心分母仍为 7 passed、4 partial/inconclusive、132 not_run，311 变体未验收。本轮备份是单独的窄夹具证据，没有满足完整备份模板的所有接受点。整个 App / 整机验收仍为 false。

历史计时和结果见 [固定夹具与跨应用验证.md](固定夹具与跨应用验证.md)、[批量与备份验证.md](批量与备份验证.md)。本轮原始产物统一位于 `build/ai_app_bridge_artifacts/notallyx-migration/`，测试日志位于 `.tools/notallyx-backup-script-2026-09-07/`。
