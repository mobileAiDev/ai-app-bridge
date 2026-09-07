# Script / Intent 隔离重建计划（历史归档）

> 状态：历史 tombstone，禁止执行。
>
> 当前权威任务书：`docs/SCRIPT_INTENT_RUNTIME_CAPTURE_MASTER_PLAN.md`
>
> 手机存查子计划：`docs/MOBILE_CAPTURE_STORE_UNIFICATION_PLAN.md`

本文件原正文已经移除，避免搜索命中旧阶段、旧 DSL 或旧并发结论后误实施。历史内容仍可从 Git 历史读取，但不得作为当前产品合同、测试 Gate 或实现指令。

## 仍然有效并已迁入总计划的原则

1. Legacy、Intent、Script 是三条隔离执行链。
2. LegacyDispatcher 只隔离和转发现有命令，不承载 Intent/Script 业务。
3. Legacy live 主响应与执行路径保持兼容；批准的 intentional delta 必须单列。
4. Script/Intent 不交叉 import，也不调用旧 Batch、LegacyDispatcher 或 MCP。
5. `page-summary` 是对已取得语义树的内部纯转换，不是顶层 MCP command，也不负责多路采集。
6. 不引入 UiA2 server、instrumentation、ADB reconnect、kill-server 或每步 ADB 健康探针；现有 UIA provider 不在禁用范围。
7. 无新鲜证据不得给出通过结论；ambiguous mutation 不自动重放。

## 已失效内容

以下旧结论全部失效，禁止从 Git 历史复制回生产：

- YAML/JSON fixed steps 是最终 Script 格式；
- 禁止 JavaScript/Python；
- 旧 Phase 0–18、G4–G8/S17 执行顺序和首条实现指令；
- 任意 Script 都能从 checkpoint 跨进程恢复；
- 把同 serial/different package 的 Legacy 并发直接套到新 Script/Intent 前台 mutation；
- 把 Intent 探索、代码生成、Script 回放或报告组装固化成产品命令。

## 当前执行入口

实施代理必须完整阅读总计划和 CaptureStore 子计划，只执行总计划第 17 节给出的当前首条指令。不得执行本文件中的任何历史 Phase；本文件也不定义验收 Gate。
