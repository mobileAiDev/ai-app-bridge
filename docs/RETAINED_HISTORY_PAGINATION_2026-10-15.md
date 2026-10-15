# 留存历史跨分区分页修正（2026-10-15）

状态：源码候选已验证，尚未发布。公开 0.4.15 仍存在本次误报；没有替换本机公共安装、重启默认 Runtime 或清理其历史。

0.4.15 已排除无关 network 分区对证据查询的影响，但未解决 action/ui 留存起点不同的情况。当前真实旧库中，ui 从 globalSeq 27354 开始保留，action 从 41268 开始保留。fresh inventory 的第一内部页只读到 32660，下一页携带的混合分区游标便因 action 的旧留存起点被拒绝。读取期间没有新淘汰，首 1000 帧的 CRC、commit、JSON 均有效。这是证据层 fresh retained-history 扫描方式的缺陷，不能称 0.4.15 已完整修复。

候选在证据读取层分别分页扫描 action/ui，按 globalSeq 合并；固定扫描开始时的水位，并核对整个扫描前后的所选分区淘汰计数。另一个分区尚未开始读取时若发生淘汰，也明确失败。readById 仍为一次带 actionId 的精确查询，已覆盖真实与分块记录回读。

以下合同保持：

- 全局游标、签名、范围绑定、storeId、native 磁盘格式、CRC 和大记录分块校验均未修改。
- 扫描期间所选分区新淘汰仍返回 cursor_expired；未选分区变化不冒充证据丢失。
- 非法页、gap、缺失或重复 continuation、逆序/重复序号仍明确失败，排序不能修复坏页。
- 归档仍检查源身份及全局水位变化、越界事实、容量和引用完整性，失败不发布部分归档。
- inventory 的 completeHistory 仍为 false，归档 priorHistoryComplete 仍为 unknown。缺回执不代表动作没有发生，不重放原动作。

验证结果：

- 相关既有与新增回归 211/211 通过，包括真正分块、损坏/缺块、跨分区旧起点、扫描期间新淘汰、固定水位、游标签名、JS/Python 恢复和归档。独立审查另保留水位注入反例的红/绿结果。
- 真实旧库：87 个 native 文件的源前/复制/源后 SHA-256 相同；SQLite 只读事务备份的 14899 条 projection 与 5 条 metadata 摘要同源前后相同。公开 0.4.15 在隔离副本重现失败；候选读取全部 14682 条 action/ui，与独立 projection 位置加原发布 C 引擎 readAt 的序号、顺序及 payload SHA 完全一致。6155 条 Script 对应 401 个原 operation，全部 inventory 分页成功；401 个 recovery 视图与原版单 ID 查询及独立事实对照一致。两个真实操作归档和离线 verify 通过。该旧库样本中没有缺 marker 的 retained receipt，相关负例由既有回归覆盖。
- OPPO 已完成业务验收后的私有 store：在 Runtime 正常停止、无 WAL 且原文件字节稳定的条件下复制，720 条 projection 对账一致。候选完整复现原 4 页、10 个 Script ID 的持久 inventory 与 10 个 recovery 视图；10 个操作全部归档并离线 verify（共 632 条 Script 事实）。停止 Runtime 后一个 liveStatus 从 completed 变为 null，作为非持久状态差异单独保留。
- OPPO 原未知动作 `script-1792074446769-10:action-1` 的原 marker、缺失 Host receipt、ambiguous=true 和 needsInspection=true 均保留。外部对原 action 的查询已 settled，原 operation 的 verify-only 续跑已 completed，候选不会因此补造 Host receipt 或清除原不确定性。本次副本验收没有操作手机或重跑业务。

这不是性能提速结论。真实旧库全量读取约 6.07 秒；旧版 792 毫秒是在第 1000 条后失败，不能作为成功流程基线。inventory 当前仍先扫描其他 namespace 再过滤，且公开分页会重复扫描；该成本留作后续独立性能工作。

证据根：`../ai-app-bridge-release-evidence/0.4.15-2026-10-15/local/inventory-diagnosis-runtime/`。

- `source-full-regressions.tap`：211 项完整结果。
- `real-history-v2/snapshot-proof.json`、`real-history-v2/acceptance.json`：真实旧库一致快照与公开版/候选对照。
- `oppo-history-v2/snapshot-proof.json`、`oppo-history-v2/acceptance.json`：OPPO 原业务证据副本、原 ID/未知动作与归档核对。
- `independent-review/INDEPENDENT_REVIEW.json`：独立审查与反例验证。
- `final-source-fingerprint.json`：本次精确源码、测试、文档及 hash。

最初独立原型的水位反例、快照工具对 standalone WAL-mode SQLite 的只读打开限制，以及副本验收脚本的 liveStatus、输出父目录和 recovery limit 对照准备错误均保留。通过结论来自修正工具参数后、可证明一致的副本，不使用失败或不一致副本作证。
