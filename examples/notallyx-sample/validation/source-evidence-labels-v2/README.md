# Labels 来源包 v2

这是历史 Intent 轨迹、截图及独立业务快照的可搬迁副本，用于 Agent 编写回归 Script。文件哈希和依赖完整性通过，不表示新 Script 已执行，也不表示 labels 功能的全部 normal/negative/restart 分母通过。

当前状态以 `../labels-evidence-source-index-v2.json` 的 `bundleState` 为准；只有最终明确来源收齐、生成 `freeze.json` 后才作为冻结版使用。`pendingMappings` 保留尚无来源的流程，不使用其他 Intent ID 填补。

- `index-original.json` 保留当前对应索引的原字节；`bundle-manifest.json` 使用 repository-root 路径基准。
- 每个 artifact 保留原 SHA、原路径、来源 Intent ID、角色和必要 JSON Pointer 依赖。
- 截图、DB/WAL/SHM、preferences 和 acquisition transcript 按原声明的 SHA 复制。原 JSON 中绝对路径属于历史记录；请用 manifest 映射解析 bundle 文件。
- v1 的失败 crash 与后续成功拒绝轨迹都保留。旧失败不得计为成功；Intent completed 与独立业务 oracle 含义不同。
- 不含 host-facts、APK 或无界扫描的活跃目录。新增轨迹范围在 `.tools/business-app-migration-2026-09-07/labels-source-v2-plan.json` 明确列出。

生成器：`.tools/business-app-migration-2026-09-07/build-labels-source-v2.js`。普通执行只更新本版本草稿，保护 v1 不变；最终明确授权录入 plan 后使用 `--freeze`。冻结后生成器拒绝覆写该版本。
