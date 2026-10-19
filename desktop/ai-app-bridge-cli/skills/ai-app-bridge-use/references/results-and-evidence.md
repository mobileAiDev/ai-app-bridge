# 响应提取与证据

以下细节按需读取；设备/App 操作的默认入口与例外以 [SKILL.md](../SKILL.md) 为准。文中的 `docs/` 路径相对已安装 CLI 发布包根目录，定位方法见 SKILL.md 的“按需参考”。

## 响应与提取

先看 `execution` 的原执行事实及 `failureStage`，再消费 `value`；Script 内部 `ctx.call` 仍按 `ok/result` 处理，不加 extract。`control` 保留续跑字段和采集覆盖；当前 Script 问题从 `control.pendingQuestion` 读取，即使 events 被游标过滤也可回答。

Script 恢复可用 `resume {waitMs:60000}`，回答问题可用 `decide {...,waitMs:60000}`，在同次调用拿到下一问题或结果；回复已带 result 时直接使用。控制回复默认只带最近一条事件和历史记录，`history.omittedBefore:true` 明确存在更早内容。审计历史从 `afterSequence:0` 和显式 `limit` 开始，用 `history.lastSequence` 续页直到 `hasMore:false`；审计事件则用最后一条 `events[].sequence` 和显式 `eventLimit`。`eventSequence` 是实时水位，只适合等待新进度，用于审计翻页会漏掉未返回的记录。

默认最终正文预算 96 KiB，可用 `output.maxBytes` 设为 16–256 KiB。提取失败或超预算不等于动作失败；存在 `control.source.persisted:true` 时，用 `response` 的 `operation:read`、原 `ref` 和新的 extract 重读，不重发原动作。未保存或留存已过期时没有可恢复的大结果，不捏造 ref。提取会减少交付内容，不承诺减少采集耗时。

`aab.response-tables/v1` 包含 `data/tables`：在各 `table.path` 处，用 `constants` 的公共叶子字段和 `columns` 对应的每行 `rows` 单元格构造对象，替换 null。路径都是 JSON Pointer；节点、空值、状态、顺序和重复项完整保留，不必再查原文。`aab.response-overview/v1` 的 `preview.ranges` 给出原偏移和完整记录/文本片段；只有确实需要未展示部分时，才使用 `value.read` 或自行 select 原始路径。原采集范围仍以 coverage/truncated 为准。

`aab.response-tables/v2` 还将重复长文本放在 `sharedTexts`：先把每项 `text` 填回它的 `paths`（指向整个表示的 `/data` 或 `/tables`），再按 v1 展开表格。`tables` 可以为空；`partial:false` 仍表示本次已完整返回，不需要补读。提取和保存的 ref 始终使用原始响应路径。

`aab.response-tables/v3` 在此基础上支持可选字段：展开共享文本、常量和行后，将每张表 `sparseColumns` 中各 JSON Pointer 的 `[rowIndex,value]` 对填入对应的零基行。只填写列出的行，未列出的字段仍缺失，不能补 null；所有控件、身份及状态仍完整。Script 内 `ctx.call` 保持普通对象。

反复观察同一页面时，可首轮用 `extract:{mode:"delta"}`，后续传 `base:上一轮control.source.ref`。`aab.response-delta/v1` 首轮 `mode:full` 给完整 `data`，后续 `mode:patch` 给针对前一份重建 data 的 RFC 6902 operations；检查 baseSha256/sha256。data 若为 `aab.response-columns/v1`，按各 table 的 rowCount、constants 和按字段路径索引的 columns 还原每行；保留展开前的 data 供下轮 patch 使用。新节点引用、状态和覆盖信息都保留，仍执行新观察。基线失效或差量不划算会给新完整基线，不阻断动作；不要把元数据变化或空 patch 等同于全 App 没变化。Script 内部直接处理普通 ctx.call 结果，无需差量。详见 `docs/RESPONSE_EXTRACTION.md`。

提取脚本只使用 `ctx.inputs = {kind, response, execution, control}`，返回严格 JSON；没有 `ctx.call`。保留实际断言需要的来源身份、时间和状态，不能将选出的几条成功记录当作完整覆盖。完整示例见 `docs/RESPONSE_EXTRACTION.md`。
## 验证与证据

按用户要求的结果选取本轮证据；动作回执、UI 变化、业务结果和证据覆盖分别判断，证据不足保留为 inconclusive。
`ctx.assert` 默认要求完整来源；只对已经返回的控件值或存在性作判断时，可显式 `coverageScope:"observed"`。它保留 partial/unknown 覆盖，仍验证证据身份和新鲜度；不能把未返回项目推断为不存在。
要保留可移交的过程文件，在 Intent/Script start 时设置新的 `recordingDir`；已有操作的保留记录可通过 `evidence` 导出。
`evidence export` 使用原 operationId 和对应 namespace（intent/script）；包含已记录文件需 `includeRecordedPayloads:true`。保存返回的 manifestSha256，交给离线 `evidence verify`。
归档校验只证明保留内容的完整性和覆盖范围；缺页、缺引用或已淘汰记录仍需如实报告，不能据此推断业务通过。
