# 公开证据导出与离线核验

上一阶段的固定 Script 复用结果已提交为 `13f5b75`（本地提交）。本轮完成公开 `evidence export/verify` 接口，并让真实回归控制器使用它读取持久证据。NotallyX 业务源码与独立作者的 Script 均未修改。

## 接口与证据边界

通过 MCP `capabilities {"command":"evidence"}` 发现能力，再经 `run` 调用：

```json
{"command":"evidence","arguments":{"operation":"export","namespace":"intent","operationId":"已有 operationId","outputDir":"/absolute/existing-parent/new-archive"}}
```

将返回的 `manifestSha256` 单独冻结，复制目录后调用：

```json
{"command":"evidence","arguments":{"operation":"verify","archiveDir":"/absolute/moved-archive","manifestSha256":"导出时返回的64位小写SHA256"}}
```

`namespace` 同样支持 `script`。完整契约见 [EVIDENCE_ARCHIVE.md](../desktop/ai-app-bridge-cli/docs/EVIDENCE_ARCHIVE.md)。

导出保留原始 Fact 外层身份、globalSeq 和 evidence envelope，核对 checksum、namespace/operation、外层绑定及内部引用顺序。manifest 保存来源 storeId、冻结水位、分区保留状态、文件 SHA、目标清单和缺失引用。分页错误、过期 cursor、记录矛盾或超限明确失败；输出目录独占创建，manifest 最后写入。

verify 只读 manifest 与 records，不打开 FactStore，不访问手机，不执行 evidence 中的 sourcePath。必须使用导出时另存的根哈希；哈希提供冻结一致性，不是生产者身份签名。

本接口的范围是 **retained-host-records**。当前保留记录的引用齐全，不等于历史从未淘汰；`priorHistoryComplete` 始终为 `unknown`。缺少内部依赖时保留 `partial`，已有记录矛盾时拒绝；业务结论为 `not-evaluated`，不从导出成功推断执行成功。

外部截图、手机 logs/network items、Script 完整调用结果/断言和内存事件仍不包含在这两份文件里。已有 refs 被真实列出，未据此伪造载荷。回归目录中的截图/调用证据与独立 UI/业务结果仍单独保存和核验。

## 新鲜 Intent 真机验证

设备为 PGFM10 / `FYZLAU49X8OVQGJ7`，包 `io.github.mobileaidev.notallyx.sample`。APK 与初态先独立核对；另一台已授权 PKR110 本轮未连接，没有声称覆盖它。

- APK SHA256：`ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。
- Intent operation：`intent-1788829495091-1`。
- 从实际首页打开搜索，输入既有唯一标题，观察正确结果，再清空并返回首页。所有动作通过公开 Intent，未修改笔记。
- 共导出 **36 条记录**：10 observation、10 summary、6 decision、5 dispatch-marker、5 action-receipt。
- manifest SHA256：`fe6a89328fe567c4b930b36967810edfbe091ffc4d61adc5cec87d9734435c1a`。
- 将归档复制到另一目录，在两个新 MCP 进程中核验。FactStore 路径指向普通文件，PATH 指向无可执行文件的目录；两次均通过，文件 SHA 不变。
- 原采证 MCP 退出后，再启动一个无 Intent worker 的新 MCP，经公开接口重新导出，records 字节与首次完全一致。
- 11 份实时 Intent 响应与归档观察 ID、revision 和 summary 逐一绑定；归档原始树独立确认唯一标题和首页恢复锚点。实际查看首页、标题结果和恢复后的三张截图；截图保存在归档之外，不把其序列关联称为原子采集。
- 前后业务快照与原固定基线精确相等：10 条笔记、11 个标签、偏好与附件范围均无差异，没有忽略字段。

材料根目录：`build/ai_app_bridge_artifacts/evidence-archive-2026-09-08/`。Intent 核验为 `live-intent/review.json`、`live-intent/reexport.json`，独立数据结果为 `initial-data-oracle.json` 与 `intent-data-oracle.json`。

## 冻结 Script 完整复跑

现有 [控制器](../examples/notallyx-sample/validation/run-intent-search-reuse.js) 每轮终态后调用公开 export 并保存返回的 manifest SHA；[持久审查器](../examples/notallyx-sample/validation/review-search-durable.js) 在原 MCP 退出后，通过两个新 MCP 离线 verify，再核对原动作/spec/events。已移除该审查器内部 `createFactStore` 读取副本的流程，失败时没有旧路径回退。

作者源码 SHA256 保持 `1ea38097ca7607ed1380103946978e79e225cd0a956e7b4edc4bf55fe4187f77`。三次正向使用同一源码、运行时、APK 与初态。

| 运行 | Script 终态 | Script 耗时 | 断言 | 公开归档 |
| --- | --- | --- | --- | --- |
| positive-1 | completed | 24.938 秒 | 84 passed | 22 条 |
| positive-2 | completed | 24.965 秒 | 84 passed | 22 条 |
| positive-3 | completed | 25.113 秒 | 84 passed | 22 条 |
| wrong-expectation | failed | 5.862 秒 | 18 passed、1 次预期设备断言失败 | 6 条 |
| cancel | cancelled | 10.357 秒 | 35 passed，取消后无后续业务动作 | 10 条 |

所有断言均无 inconclusive。正向中位数 24.965 秒；这是搜索流程的 Script 时间，不包含探索和编写，也不外推全 App 性能。完整五轮控制器，包括前后夹具核验、公开归档与离线检查，共 149.526 秒。

五轮总共 **82 条持久记录、36 个动作**，全部公开导出并在两个新 MCP 进程中独立核验。另存的 77 张截图和 277 次树读取仍由原 UI/Host 关联验证器检查，没有改成只凭归档 SHA 判业务通过。每轮初态和最终业务数据均与固定基线零差异。

最终 `script-runs/report.json` 为 `ok:true`；`durable-review/report.json` 记录 `method: public-evidence-export-verify`、`freshVerifierProcesses:2`、`archivesUnchanged:true`、`offlineFactStoreUnavailable:true`。运行结束后再次核对，所有记录的 runtime 文件 hash 与当前代码一致。

复现沿用 [上一轮命令](INTENT_SCRIPT_REUSE_2026-09-08.md#再次运行)，替换为一个新的 `--out` 目录；当前控制器会自动使用公开归档接口。

## 检查与后续

- Host 全量串行测试：**733/733** 通过，0 跳过；`.tools/evidence-archive-2026-09-08/host-tests.log`。
- 验证工具全量：**138/138** 通过，0 跳过；同目录 `validation-tests.log`。
- 新归档核心 76 项覆盖分页/水位、错误和缺失、篡改与路径、引用先后/目标、合法前台路由与 Script 目标覆盖。真实 MCP 集成测试和回归审查器测试分别验证公开入口及离线失败处理。
- `npm pack --dry-run` 已确认归档实现、依赖模块及公开契约文档包含在交付包中；语法与 `git diff --check` 通过。未发布 npm、推送 Git 或替换全局 MCP/Skill。

下一关仍是：在 PKR110 上复跑同一固定 Script，再将截图、手机 capture 载荷等外部材料接入带明确关联的完整证据包，最后扩展另一业务流程或 App。当前完成的是 Host 持久证据公开归档这一步，不把它作为全平台发布或全 App 回归覆盖完成的证明。
