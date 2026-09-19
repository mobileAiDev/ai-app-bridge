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
| `bin/shared-kernel/argument-schema.js` | 抽出 `matchesType`；`oneOf/anyOf` 失败时先排除 JSON 类型不同的分支；无分支接受全部已给标签时，取与已给标签一致最多的分支（`rejectedDiscriminator`），只对它们都拒绝的那个标签报字段和允许值；范围错误附该字段 `description` |
| `bin/shared-kernel/execution-contracts.js` | Intent `status` 用 `historyRead`（`afterSequence` = 上次 `history.lastSequence`，`limit` 限条数不限字节）；Script `status/wait/pause/resume/cancel/decide` 用 `scriptRead`（`afterSequence` = 上次 `eventSequence`）；`waitMs` description 给出继续等待的做法 |
| `bin/command-registry.js` | `unknownCommand`：`run` 收到 `capabilities` 时说明它是发现工具及 CLI 对应入口；其它未知命令指向 capabilities/`ai-app-bridge help` |
| `bin/command-discovery.js` | `unknown_domain` 列出真实 domain（含 ios、web），说明 android 是 platform 不是 domain，并给出 decide 过滤例；`capabilities {command:未知}` 附修正说明 |
| `test/command-production-contract.test.js` | 无判别字段的 Script target 现为 `missing_argument` / `target.platform`，断言随之精确 |

当前实际错误文本（`validateCommandArguments`）：

```text
missing_argument | script.target.platform | script.target.platform is required.
invalid_argument | script.target.platform | script.target.platform must be one of: "android", "ios", "web".
invalid_argument | script.target | script.target must be object or null; no implicit type conversion is performed.
invalid_argument | waitMs | waitMs must be <= 60000. Upper bound of one wait call in milliseconds. To keep waiting, call wait again with the same operationId and afterSequence set to the last eventSequence.
invalid_argument | limit | limit must be >= 1. History entries per page; it bounds entries, not response bytes.
invalid_argument | afterSequence | afterSequence must be >= 0. History page cursor: the previous response's history.lastSequence. Not an eventSequence.
invalid_argument | mode | mode must be one of: "supervised", "autonomous".
invalid_argument | decision.action.provider | decision.action.provider must be one of: "native", "uia", "flutter", "h5".
```

后两条是复核反例：`operation:"start"` 与 `action:"tap"` 本身合法，提示落在真正非法的 `mode` / `provider` 上，允许列表不含当前值。

`run {command:"capabilities"}`（CLI 实测）：

```json
{"kind":"json","value":{"ok":false,"error":"unknown_command","message":"capabilities is the discovery tool, not a run command. Call the capabilities tool (CLI: --help <command>) with an optional domain or command filter, then run one of the listed command names.","command":"capabilities","field":"command","dispatched":false,"ambiguous":false}}
```

`capabilities {domain:"android"}` 列出 execution、evidence、core、app、action、flutter、webview、ios、web、diagnostics、advanced（ios、web 既是 domain 也是 platform），并给出 `{"command":"intent","operation":"decide","platform":"android","provider":"native","action":"tap"}` 过滤例。

合同影响：成功响应结构不变。错误响应有三类变化：(1) 缺判别字段的 union 由 `invalid_argument` / 父字段（如 `script.target`）变为 `missing_argument` / 子字段（`script.target.platform`）；非法判别值由父字段的 generic variants 错误变为子字段的允许值错误；(2) message/description 文本；(3) capabilities 的 `unknown_command`/`unknown_domain` 响应新增 `message`。已选定分支内的精确错误（如 `decision.action.durationMs`）不变，`intent-native-long-press` 等既有断言保持通过。

### M1-c 文档与夹具同步

| 文件 | 变更 |
| --- | --- |
| `docs/INTEGRATION.md` | Android SDK/Gradle 插件、iOS Swift Package、Flutter 插件版本 0.3.5 → 0.3.8；历史发布记录不改 |
| `docs/TEST_PLAN.md` | 删除已不存在的 `smoke`；改为 Android Sample Validation，指向 `android-sample-capture-loop.js` 及逐条命令；说明无 Flutter 宿主时 `flutter-tree` 的预期错误 |
| `examples/notallyx-sample/validation/test/review-search-durable.test.js`、`review-public-archive.test.js` | Script target 补 `platform:'android'`；完成的 Script 运行现在多一条 `result` 记录（6 → 7）；`client.close()` 现在会发 `runtime stop`，transcript 断言按两次 `tools/call` 核对 |
| `examples/notallyx-sample/validation/run-backup-regression.js` | Script 请求不再混入平铺 target/`feedback`；`script.target` 带 `platform:'android'`；删除 schema 中不存在的 `policy.onFailure`；两处 `status limit:4096`（上限 1000）改为 `fullStatus`：`limit:1000` 按 `history.lastSequence` 逐页读到 `hasMore:false`，完整历史校验保留 |

### M1-d 当前合同下可运行的范例

| 文件 | 变更 |
| --- | --- |
| `desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md` | 新增 "Lifecycle: start, wait, result"：start → wait（`waitMs ≤ 60000`，`afterSequence` = 上次 `eventSequence`，`running`/`finishing` 继续等，`waiting_for_agent` 交给 decide）→ result 的 JSON 调用序列；同一回归场景的 JavaScript 与 Python 范例（观察、动作、断言、progress），围栏标记 `regression-example` |
| `desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md` | 新增 Intent 生命周期范例（start → decide act → status 分页 `limit` + `history.lastSequence` → decide complete），围栏标记 `lifecycle-example` |
| `skills/ai-app-bridge-use/SKILL.md` 及包内同步副本 | capabilities 是独立工具、有效 domain 列表、platform 不是 domain；紧凑 JSON；Script wait 与 Intent status 两种游标；指向上述范例 |
| `test/usage-examples-current.test.js`（新增） | 从文档围栏读出范例，在 fake 设备 runner / fake Intent adapter 上运行，断言完成状态、命令序列、progress 事件、历史分页；慢持久化用例：`result` 记录延迟 700 ms 时循环观察到 `finishing`，此时 `result` 为 `result_not_ready`，终态后读取成功 |
| `test/usage-surface-guidance.test.js`（新增） | CLI/MCP 紧凑 JSON 且解码等价；target.platform 精确错误；`mode`/`provider` 反例只在值非法时点名；范围错误附说明；两种游标 description；capabilities/unknown_domain 引导 |

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

## 3. 复核修正（第 2 个提交）

Codex 对 `0005c1a → 5cd32af` 的审核给出 4 项 P2，全部核实成立并修正：

| 意见 | 核实 | 修正 |
| --- | --- | --- |
| union 提示指向合法字段：`operation:"start", mode:"wrong"` 提示改 `operation`；`action:"tap", provider:"wrong"` 提示改 `action` | 复现一致。原 `sharedDiscriminator` 取所有分支共有的第一个 `const` 属性，不检查当前值是否已被接受 | 改为 `rejectedDiscriminator`：取与已给标签一致最多的分支，只报它们都拒绝的标签；两反例现分别得 `mode must be one of: "supervised", "autonomous"` 与 `decision.action.provider must be one of: "native", "uia", "flutter", "h5"`；`platform:"windows"`、缺 `platform`、已选分支内的 `durationMs` 错误不变。反例进入 `usage-surface-guidance.test.js` |
| domain 文案自相矛盾：ios、web 实为合法 domain | 复现一致 | `unknown_domain` 文案改为"android 是 platform 不是 domain"，两份 skill 同步 |
| Script 等待范例遗漏 `finishing` | 源码核实：`finishRuntime` 先置 `finishing` 再持久化 result，此间 `result` 返回 `result_not_ready` | 文档与测试循环改为 `running`/`finishing` 继续等待；新增慢持久化用例（result 记录延迟 700 ms）断言观察到 `finishing`、期间 `result_not_ready`、终态后读取成功 |
| NotallyX 备份入口两处 `status limit:4096` 超过上限 1000 | 核实 `pageLimit = integer(1, 1000)` | 改为 `fullStatus` 逐页读取；离线探测（`limit:5`，8 页，39 条历史/事件）与单页完整读取序列完全一致，`hasMore:false`、`gap:false` 校验保留 |

交付记录中"错误码、字段名不变"的表述已按上文"合同影响"更正。

修正后证据：定向 6 个测试文件 101 通过 / 0 失败；NotallyX 138 通过 / 0 失败；`npm test` 全套两次：第一次 1348 通过 / 1 失败（计时基准，见下），第二次 1349 通过 / 0 失败，44.9 s。

Codex 对固定提交 `5cd32af → e11d680` 再次分规范/方案两轴复审：union/domain 的离线反例通过，finishing 的代码与新增用例符合合同。两份 skill 中遗漏的 `finishing` 续等说明已补齐。NotallyX 当前事件与历史各保留最多 256 条，固定 `limit:1000` 可以取得保留内容，原历史 gap 校验仍有效；heartbeat 只进入事件流，不能将小 limit 样本理解为两流分页总是完全同步。此次复审没有复跑 M1 全套或连接真机；上段测试数字仍为实施方记录，正在实施的 M2a 另行验收。

## 4. 未做与边界

- 计时基准在并发全套中不稳定：本轮一次全套 1348 通过 / 1 失败，失败为 `p8-handshake-bench` 的 JS 握手 p95（210.9 ms，门槛 150 ms），Codex 独立复测时失败的是 `summary-transformer-g3` 的 p95（20.62 ms，门槛 20 ms）；两文件单独运行均全部通过，与 M1 改动无关（改动不在握手或摘要路径）。隔离为串行性能组的修法随 M4 验收矩阵一并做。
- `capabilities {command:"capabilities"}` 返回 `unknown_command` 加"省略 command 或传 domain"提示，未为该入口另做特殊分支。
- 依赖新 extract/封套的完整范例、Intent status 超预算的错误引导，按方案在 M2/M4 编写，不在本包。
- 历史阶段记录（`docs/COMMAND_PRODUCTION_*`、`RELEASE_HANDOFF_0.3.8`）保留原版本号与旧命令名，不回改。
- 预算、超时、并发参数在 M1 没有可校准项。
