# 清单持久化验收合同修正

固定源码 `03ff809f058dbcabd5f0d20f114546686dfc9cb5` 的 `Converters.itemsToJSONArray` 只保存 `body`、`checked`、`isChild`、`order`、`checkedTimestamp`。`ListItem.id` 默认 -1，是内存字段；`children` 也是内存重建结构，两者均未写入 Room JSON。

因此不要求数据库里出现或维持虚构的任务 ID。验收仍逐项比较完整持久字段序列、每段文字的出现次数、顺序与父子分组，使用唯一 fixture 文字追踪指定任务。相同文字的重复项必须保留正确重数和位置，不能用去重后的集合比较掩盖丢失/重复。只有源码定义可空的 order / checkedTimestamp 可将 JSON 缺失与 null 规范为 null；不补造排序值或时间。

功能数 51、场景模板 143、覆盖槽 396 和 scenario/oracle ID 均不变。来源 Intent 字段仍为空；实际历史证据索引未修改。新版三个计划文件由 runner 启动时按实际内容计算冻结 SHA。
