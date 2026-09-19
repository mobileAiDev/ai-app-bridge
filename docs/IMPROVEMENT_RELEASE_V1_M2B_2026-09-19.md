# M2b 响应快照与读取交付记录

日期：2026-09-19。基线 dc63f8e；0.4.0 中间工作包。

新增 response read 公共命令及原样字节快照模块。复用既有 evidence store、checksum、FactStore 配额和归档，增加 namespace/kind=response；snapshotBase64 编码前上限 8 MiB，记录 envelope 上限包含 base64 和元数据开销。仅成功保存生成 ref，保存失败、缺失/淘汰、校验和或身份不符均明确返回。

读取的 execution 表达本次读取，control.origin 保留原命令执行事实，source 指向同一快照。读取不调用 provider、不再次保存封套。即时提取与自动保存触发在 M2c 的公共返回处理阶段接入；本提交没有把暂未实现的提取或预算描述为可用。

定向验证 response-store、evidence-store-g2、evidence-archive、command-production-contract 共 107 项通过；日志 `/tmp/aab-m2b.log` 和命令数变更后的复测 `/tmp/aab-m2b-contract.log`。包括真实 native FactStore 落盘、新进程公共读取、现有归档导出与离线校验、原内容/最终 feedback 保真、ENOSPC/写入异常、8 MiB 原始字节边界及超限、错误 ref、重复读取不增记录。第一次唯一失败是命令目录由 122 增至 123 后旧数量断言未更新，已修正。

无真机执行、无新存储后端、无新隐私处理；安装与完整公共提取链继续验收。
