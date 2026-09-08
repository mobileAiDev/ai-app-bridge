# Intent 证据复用：双设备授权与固定源代码回归

后续已完成 [公开证据归档与再次真机复跑](EVIDENCE_ARCHIVE_2026-09-08.md)，当前控制器使用 `evidence export/verify`。以下保留本轮当时的验证事实与限制。

本轮延续 [采证和独立编写阶段](INTENT_SCRIPT_REUSE_2026-09-07.md)，验证已有搜索流程的证据能否交给独立作者，形成可反复执行的 Script。NotallyX 的业务代码没有变化。

结果：**PGFM10 上同一份独立作者源码连续三次正向通过，错误期望与等待决策时取消两个负例也按预期通过。** 五轮业务数据零差异，Host 持久动作证据重开核验通过。这完成了本搜索场景的“Intent 证据 → 独立 Script → 固定状态重复回归”关口。

## 设备与来源

用户已明确允许后续使用两台手机：PGFM10（`FYZLAU49X8OVQGJ7`）和 PKR110（`b46093e6`）。每轮先选在线设备、固定 serial，再核对实际 APK 与业务夹具。PKR110 的公开 status 实际返回 `OnePlus`，PGFM10 返回 `OPPO`；按真实字段核对身份。

最初在线的是 PKR110。先完整保存旧 APK 和 sample 数据，再安装固定 v6 APK，通过显式跨设备夹具复制工具迁移原有 10 条笔记、11 个标签与偏好。源证据保留原 PGFM10 身份，新基线来自 PKR110 的真实重新采集；字节与业务数据均独立读回比较，没有把旧 manifest 的 serial 改成新手机。

- APK SHA256：`ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。
- PKR110 基线 snapshot：`3812eb2c-d0ae-436a-aefc-57b939682c64`。
- PKR110 转移记录：`build/ai_app_bridge_artifacts/intent-reuse-2026-09-08/transfer-baseline/result.json`。
- 原 APK 与业务快照：同级 `existing-sample.apk`、`existing-sample-snapshot/`。

PKR110 在第一次正式运行的前置检查之前断开；保留 `runs-v2/`，Script 启动数为零。随后 PGFM10 连上，直接按用户授权切换到它，重新核对原夹具后继续。PKR110 的夹具准备通过不等于该手机已经完成搜索 Script 回归。

## 独立作者与冻结

独立作者只用原冻结 Intent 证据、自身 v1 源码和新的公开设备 status 补充包，将身份校验参数化为 `ctx.inputs.device`。业务步骤、查询预期、定位、等待、逐页证据和取消点保持不变，父控制器没有修改作者源码。详情见 [v2 编写记录](../examples/notallyx-sample/validation/intent-search-authoring-v2.md)。

- [冻结 Script](../examples/notallyx-sample/validation/intent-evidence-search.js) SHA256：`1ea38097ca7607ed1380103946978e79e225cd0a956e7b4edc4bf55fe4187f77`。
- PGFM10 执行材料：`build/ai_app_bridge_artifacts/intent-reuse-2026-09-08/execution-bundle-v2-pgfm/`。
- 原始流程观察仍来自 PGFM10；当前手机的身份资料单独留证。没有重写历史观察身份或把开发实现提示提供给作者。
- 所有修订都保留原交付。正式三次通过必须来自同一源码、运行时、验证器、APK 和目标夹具，不累计不同验证版本的成功数。

## 实际暴露并处理的问题

1. **Host 事件缺少普通读取的关联字段。** `status`、`keyboard-state` 的 Script envelope 有 observationId/source/window，但原 `call_completed` 只有空 refs。补齐真实 `callId`、`observationId`、`source`、`window`、`coverage`，ledger 同步保存元数据。未伪造 capture ref，未改变设备断言语义。公开文档已说明这些字段。
2. **系统弹窗可能不在 App SDK 树里。** PKR110 准备时看到 USB 系统弹窗。关闭后增加每轮运行前的公开 UIA XML 核验；确认活动 UI 属于 sample，再启动 Script。准备助手最初把 UIA XML 当 JSON 解析失败，原 MCP 记录保留在 `dismiss-usb-dialog/`；验证器按真实 XML 合同读取。
3. **验证器对恢复列表作了错误假设。** 首屏的笔记恰好全都匹配正文，不能要求清空后出现“不匹配正文”的标题。改为先保存本轮首页的可读顺序，清空后核对其中两个实际锚点，且要求之前已观察到准确查询与空结果插图。只有旧唯一标题的过渡状态仍被拒绝。
4. **完整 bounds 不等于完整可读。** 独立视觉复核看到部分标题被 MakeList 悬浮按钮挡住。父验证器补齐祖先裁剪和列表外点击控件的遮挡判断；每页断言与跨页并集仍分开。

## 保留的失败记录

| 目录 | 结果与处理 |
| --- | --- |
| `runs-v2/` | PKR110 在前置 APK 检查前断开，未启动 Script |
| `runs-v2-pgfm/` | Script 执行结束 24.189 秒，84 个断言通过；父验证器因 Host 关联字段缺失拒绝，整体失败 |
| `runs-v2-pgfm-r2/` | 修复 Host 后 Script 执行结束 24.997 秒；父验证器的恢复列表假设错误，整体失败 |

上述两次手机执行都保留原报告，均不计入正式三次。第一次的独立图像复核实际查看 11 张关键图，原 174 份输入前后 SHA 不变，确认五个正文标题与各阶段可见结果；视觉一致没有覆盖整体失败。第二次仅用修正后的 oracle 做离线诊断，结果写入 `revised-oracle-diagnostic.json`，明确排除在重复运行计数之外。

## 正式验证

正式结果位于 `build/ai_app_bridge_artifacts/intent-reuse-2026-09-08/runs-v2-pgfm-r3/`，总 `report.json` 为 `ok:true`。执行入口为本仓库的 MCP server；全局已安装连接器与 Skill 没有被替换。

| 运行 | Script 终态 | 执行耗时 | 断言及独立结果 |
| --- | --- | --- | --- |
| positive-1 | completed | 24.101 秒 | 84 passed，0 failed，0 inconclusive；独立 UI 与数据核验通过 |
| positive-2 | completed | 23.912 秒 | 同上 |
| positive-3 | completed | 25.147 秒 | 同上 |
| wrong-expectation | failed | 5.697 秒 | 18 passed，1 次预期的设备断言失败；真实查询未改，仅替换期望，失败后未派发后续业务动作 |
| cancel | cancelled | 10.061 秒 | 35 passed；标题阶段完成后停在 askAgent，取消后无后续 Script 调用 |

三次正向中位数 24.101 秒；这是本搜索流程的 Script 执行时间，包含自动证据写盘，不含预先探索和编写。每次正向若计入实际 APK/初态核验、冷启动、UIA 与运行后数据库采集，为 35.386、34.951、36.095 秒。五轮及最终持久重开核验合计 144.821 秒。没有把准备、编写、失败调试或独立视觉复核的时间算进这个执行窗口，也不据此推算全 App 的耗时或通用倍速。

三次正向不需要 Agent 决策或人工手机操作。其各自的所有调用、21 张截图、逐页树与断言已落盘；五轮总共 77 张截图、276 次树读取。父验证器按 Host 事件中的调用/观察身份、载荷 SHA、动作窗口、截图文件 SHA 和前后稳定树关联材料，分别验证每页与五标题并集。

每轮前后都读取实际设备业务快照，与原固定 10 条笔记、11 个标签及偏好精确比较，没有忽略字段。MCP 退出后只读存储副本，两次重开得到相同的 82 条记录（36 个动作标记、36 个动作回执、10 个起止 checkpoint），checksum、动作先后顺序、目标、spec 参数与终态均正确；原存储文件 hash 不变。完整 UI/断言材料另存于运行目录，不能把它们全部称为 Host FactStore 持久记录。

另一代理实际查看正式运行的 13 张关键截图：positive-1 的各主要阶段、positive-2/3 的首页终点，以及两个负例的标题页。五标题并集、可读范围和恢复锚点一致；176 个复核输入文件 SHA 前后不变，215 项归档关联检查通过。报告为 `runs-v2-pgfm-r3/visual-review/review-r3.md`。它没有逐图查看其余截图或重新执行 SQLite/持久算法；这些由上述父控制器负责。最终汇总为同目录的 `completion.json`。

## 代码与交付检查

- Host 全量串行测试：`node --test --test-concurrency=1`，**654/654 通过**，0 跳过。日志 `.tools/intent-reuse-2026-09-08/host-tests-serial.log`。
- 验证工具全量测试：**133/133 通过**，0 跳过。日志 `.tools/intent-reuse-2026-09-08/validation-tests-final.log`。
- 首次并发 Host 全测有一个既有性能门槛失败：5k 节点 p95 为 21.296 ms，门槛 20 ms；保留 `host-tests.log`。串行重跑全部通过，没有调宽阈值或修改该性能实现。
- 源码语法与 `git diff --check` 通过。运行结束及全测之后再次确认，三轮记录的 runtime 文件 hash 与当前文件一致，作者源码 SHA 未变。
- `npm pack --dry-run` 确认 runtime 修改及三份公开契约文档包含在包中；没有发布 npm 包或替换全局 MCP/Skill。

## 再次运行

复现命令如下，输出目录必须另取新目录：

```sh
node examples/notallyx-sample/validation/run-intent-search-reuse.js \
  --server desktop/ai-app-bridge-cli/bin/mcp-server.js \
  --serial FYZLAU49X8OVQGJ7 \
  --apk build/ai_app_bridge_artifacts/notallyx-migration/candidate-v6/notallyx-backup-count-v6.apk \
  --fixture build/ai_app_bridge_artifacts/intent-reuse-2026-09-07/baseline/fixture.json \
  --source examples/notallyx-sample/validation/intent-evidence-search.js \
  --bundle build/ai_app_bridge_artifacts/intent-reuse-2026-09-08/execution-bundle-v2-pgfm \
  --out build/ai_app_bridge_artifacts/intent-reuse-2026-09-08/new-run
```

该场景覆盖唯一标题、正文跨页、无结果、清空和首页恢复。清空验证的是实际可见锚点；数据库零差异单独校验，不声称已经逐页遍历清空后的全部笔记。等待决策时取消不能替代动作执行中取消、物理断连或进程重启恢复。原公开证据导出、跨 App 套件与完整安装交付仍需要后续验证。

下一步优先把本次依赖开发助手整理的证据导出/归档过程变成公开、可校验的接口，再用同一源码在已备好夹具的 PKR110 完成另一台手机的重复验证。之后扩展另一个业务流程或 App，检验复用边界；无需为样例新增业务功能。
