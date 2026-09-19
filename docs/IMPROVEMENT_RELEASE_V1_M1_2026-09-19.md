# 改善版本 V1 — M1 交付记录（2026-09-19）

工作包定义见[整体方案 §5](IMPROVEMENT_RELEASE_V1_2026-09-18.md)：无缩进；文档/夹具同步；发现过滤与错误修正例；Intent/Script 当前可用范例。分支 `fable/improvement-v1-m1`，基线 `0005c1a`。本包遵守 0.3.9 检查点规则：不改已接受的输入/响应语义，不引入 extract、统一封套或发现硬预算；包版本仍为 0.3.8，是否对外发布 0.3.9 由用户决定。

## 1. 变更清单

### M1-a 公共 JSON 去缩进

| 文件 | 变更 |
| --- | --- |
| `desktop/ai-app-bridge-cli/bin/ai-app-bridge.js` | stdout 的命令回复、失败回复和 `--help <command>` schema 都改为 `JSON.stringify(v)`；help 文案说明结果是一行紧凑 JSON |
| `desktop/ai-app-bridge-cli/bin/mcp-server.js` | `toolJson` 去掉 `null, 2` |
| `desktop/ai-app-bridge-cli/README.md`、`docs/COMMAND_CONTRACT.md` | 说明 CLI/MCP 输出为一行紧凑 JSON |

结构和值不变，只有序列化空白变化。实测：深树夹具 `notallyx-backup-dialog-native-tree.json` 紧凑 289965 字节，缩进 1143164；`capabilities {}` 18895 / 23294；`{command:"tree"}` 1913 / 2898；`{domain:"webview"}` 3972 / 4623。

### M1-b 错误修正例与发现引导

| 文件 | 变更 |
| --- | --- |
| `bin/shared-kernel/argument-schema.js` | 抽出 `matchesType`；`oneOf/anyOf` 失败时先排除 JSON 类型不同的分支，再按共享判别字段（`sharedDiscriminator`，所有分支同一 `const` 属性）报出允许值；范围错误附该字段 `description` |
| `bin/shared-kernel/execution-contracts.js` | Intent `status` 用 `historyRead`（`afterSequence` = 上次 `history.lastSequence`，`limit` 限条数不限字节）；Script `status/wait/pause/resume/cancel/decide` 用 `scriptRead`（`afterSequence` = 上次 `eventSequence`）；`waitMs` description 给出继续等待的做法 |
| `bin/command-registry.js` | `unknownCommand`：`run` 收到 `capabilities` 时说明它是发现工具及 CLI 对应入口；其它未知命令指向 capabilities/`ai-app-bridge help` |
| `bin/command-discovery.js` | `unknown_domain` 列出真实 domain，并说明 android/ios/web 是 platform 过滤条件并给出 decide 过滤例；`capabilities {command:未知}` 附修正说明 |
| `test/command-production-contract.test.js` | 无判别字段的 Script target 现为 `missing_argument` / `target.platform`，断言随之精确 |

当前实际错误文本（`validateCommandArguments`）：

```text
missing_argument | script.target.platform | script.target.platform is required.
invalid_argument | script.target.platform | script.target.platform must be one of: "android", "ios", "web".
invalid_argument | script.target | script.target must be object or null; no implicit type conversion is performed.
invalid_argument | waitMs | waitMs must be <= 60000. Upper bound of one wait call in milliseconds. To keep waiting, call wait again with the same operationId and afterSequence set to the last eventSequence.
invalid_argument | limit | limit must be >= 1. History entries per page; it bounds entries, not response bytes.
invalid_argument | afterSequence | afterSequence must be >= 0. History page cursor: the previous response's history.lastSequence. Not an eventSequence.
```

`run {command:"capabilities"}`（CLI 实测）：

```json
{"kind":"json","value":{"ok":false,"error":"unknown_command","message":"capabilities is the discovery tool, not a run command. Call the capabilities tool (CLI: --help <command>) with an optional domain or command filter, then run one of the listed command names.","command":"capabilities","field":"command","dispatched":false,"ambiguous":false}}
```

`capabilities {domain:"android"}` 现为 436 字节，列出 execution、evidence、core、app、action、flutter、webview、ios、web、diagnostics、advanced，并给出 `{"command":"intent","operation":"decide","platform":"android","provider":"native","action":"tap"}` 过滤例。

合同影响：错误码、字段名和成功响应结构不变；变化仅在 message/description 文本，以及 capabilities 的 `unknown_command`/`unknown_domain` 响应新增 `message`。`intent-native-long-press` 等既有精确错误断言保持通过。

### M1-c 文档与夹具同步

| 文件 | 变更 |
| --- | --- |
| `docs/INTEGRATION.md` | Android SDK/Gradle 插件、iOS Swift Package、Flutter 插件版本 0.3.5 → 0.3.8；历史发布记录不改 |
| `docs/TEST_PLAN.md` | 删除已不存在的 `smoke`；改为 Android Sample Validation，指向 `android-sample-capture-loop.js` 及逐条命令；说明无 Flutter 宿主时 `flutter-tree` 的预期错误 |
| `examples/notallyx-sample/validation/test/review-search-durable.test.js`、`review-public-archive.test.js` | Script target 补 `platform:'android'`；完成的 Script 运行现在多一条 `result` 记录（6 → 7）；`client.close()` 现在会发 `runtime stop`，transcript 断言按两次 `tools/call` 核对 |
| `examples/notallyx-sample/validation/run-backup-regression.js` | Script 请求不再混入平铺 target/`feedback`；`script.target` 带 `platform:'android'`；删除 schema 中不存在的 `policy.onFailure` |

### M1-d 当前合同下可运行的范例

| 文件 | 变更 |
| --- | --- |
| `desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md` | 新增 "Lifecycle: start, wait, result"：start → wait（`waitMs ≤ 60000`，`afterSequence` = 上次 `eventSequence`，`waiting_for_agent` 交给 decide）→ result 的 JSON 调用序列；同一回归场景的 JavaScript 与 Python 范例（观察、动作、断言、progress），围栏标记 `regression-example` |
| `desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md` | 新增 Intent 生命周期范例（start → decide act → status 分页 `limit` + `history.lastSequence` → decide complete），围栏标记 `lifecycle-example` |
| `skills/ai-app-bridge-use/SKILL.md` 及包内同步副本 | capabilities 是独立工具、有效 domain 列表、platform 不是 domain；紧凑 JSON；Script wait 与 Intent status 两种游标；指向上述范例 |
| `test/usage-examples-current.test.js`（新增） | 从文档围栏读出范例，在 fake 设备 runner / fake Intent adapter 上运行，断言完成状态、命令序列、progress 事件、历史分页 |
| `test/usage-surface-guidance.test.js`（新增） | CLI/MCP 紧凑 JSON 且解码等价；target.platform 精确错误；范围错误附说明；两种游标 description；capabilities/unknown_domain 引导 |

范例测试证明的是"文档范例与当前包合同一致且能跑通"，不是设备行为。

## 2. 测试证据

在 `desktop/ai-app-bridge-cli`：

| 检查 | 结果 |
| --- | --- |
| 新增/受影响定向测试 `usage-surface-guidance`、`usage-examples-current`、`command-discovery`、`execution-contracts`、`intent-native-long-press`、`command-production-contract` | 99 通过，0 失败（Python 范例实际执行，本机 python3 3.9.6） |
| `npm test` 全套 | 1347 通过，0 失败，0 跳过，47.5 s；基线记录为 1338，新增 9 项 |
| `node scripts/validation/verify-package.js <新目录>` | `ok:true`；仓库外全新安装 `mobileaidev-ai-app-bridge-0.3.8.tgz`（sha256 `5af1be14…c70161`），受控 ADB，CLI/MCP 共享 schema、122 命令、目录 18895 字节；共享 CLI/MCP 解析器已消费紧凑输出 |

在仓库根：`node --test examples/notallyx-sample/validation/test/*.test.js` 138 通过，0 失败（含修正后的 durable/archive 夹具）。

以上均为本机运行、未连接真机；`verify:package` 仍在本机编译 native store，免编译安装属于 M5。

## 3. 未做与边界

- `summary-transformer-g3` 的 p95 断言在本轮全套运行通过；隔离为串行性能组的修法未在 M1 处理，随 M4 验收矩阵一并做。
- `capabilities {command:"capabilities"}` 返回 `unknown_command` 加"省略 command 或传 domain"提示，未为该入口另做特殊分支。
- 依赖新 extract/封套的完整范例、Intent status 超预算的错误引导，按方案在 M2/M4 编写，不在本包。
- 历史阶段记录（`docs/COMMAND_PRODUCTION_*`、`RELEASE_HANDOFF_0.3.8`）保留原版本号与旧命令名，不回改。
- 预算、超时、并发参数在 M1 没有可校准项。
