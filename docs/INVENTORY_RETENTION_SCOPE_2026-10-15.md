# Evidence 留存查询范围修正（2026-10-15）

结论：这是 Evidence 读取层已有的分区范围错误，适合由 0.4.15 吸收。0.4.13 与 0.4.14 的相关五个 JS 文件逐字节相同；独立的当前版本库也能复现，无需旧 Runtime 或版本混用。没有打开、清空或修复正在运行的 FactStore，也没有操作设备。

## 原因和范围

`createSegmentedEvidenceAdapter` 的 writer 只把 observation/summary 写入 `ui`，其他 evidence 写入 `action`；大记录分块及 manifest 保持同一分区。原来的 reader 却没有选择分区，内部每页 1000 条，扫描全部八分区后才过滤 namespace。调用方即使没有传 cursor，reader 也会产生续页 cursor。

独立复现保存了 1001 条完整 Script checkpoint，再让无关 network 分区的 20 条记录淘汰 16 条。第一内部页成功，第二页被 network 的留存下界判为 `cursor_expired`，上层只剩 `evidence_read_failed`。Action 记录淘汰数仍为零。此机制足以复现现场响应；未读取 live 分区状态，所以不把 network 指定为现场已证明的具体分区。

底层无 partitions 的 cursor 是全局游标，严格检查所选分区缺口本身符合现有合同。修正仅在 EvidenceAdapter 的 `readById`/`list` 和 evidence archive 的读取处增加 `partitions: ['action', 'ui']`。没有修改签名、游标、C、SDK、磁盘格式或二进制。影响范围包含 Script/Intent/response 共享 evidence 读取与归档；不改变其他调用者的全局查询。

## 验证

- 原始独立复现及红测试已保留。临时候选先通过 6/6，再吸收相同三处参数修改。
- 正式源码的 8 个相关测试文件 **165/165 通过，0 失败、0 跳过，7.722 秒**。
- 新回归检查 1001 条 observation/summary/checkpoint 混合分页、20 KB 跨分段大记录重组、完整顺序、inventory/recovery、按 ID 读取、归档与实际 verify。
- 无关 network 留存变化不再阻断 evidence；默认全局分页仍报告过期；分页间注入的所选 `ui` 或 `action` 分区缺口仍明确失败；游标不能换范围使用；归档期间全局水位变化仍返回 `store_changed_during_export`，不生成成功归档。
- 既有回归同时覆盖 8 MiB response、分块丢失/篡改/重排、旧游标淘汰和恢复。独立代理完成只读审核，无阻塞发现。

这里的 ui/action 负控证明的是**分区级缺口**，并不声称指定 operation 的原记录已被淘汰。也没有重设计所选分区的保留历史合同：相关分区的缺口继续保守失败，不能被当成完整历史。未做新的设备或整段性能验收。

证据目录：`ai-app-bridge-release-evidence/0.4.14-2026-10-15/local/inventory-diagnosis/`，主要文件为 `diagnosis-result.json`、`reproduced.json`、`red-valid-reference.log`、`candidate-valid-reference.log`、`source-regressions.log`。最初候选日志里的 summary revision 是新测试夹具错误，已只修正夹具并保留原失败日志；正式实现没有因此增加逻辑。
