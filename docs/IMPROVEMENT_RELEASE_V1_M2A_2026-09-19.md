# M2a 公共返回基础交付记录

日期：2026-09-19。基线：828b1e5。此提交是 0.4.0 的中间工作包，尚不可单独发布。

## 实现

CLI/MCP 的公共 run 必填 extract；null 显式保留本次原始结果。CLI 先解析公共 JSON 再解析业务参数，封套字段不进入设备参数。Runtime 在公共边界组装 execution/control/extraction/delivery/kind/value；客户端本地 status/stop、离线 verify 和公共错误使用同一结构。内部 Script/Intent/provider 调用沿用内部合同。

执行结果未知保持未知；原 value 和 _feedback 保留。保护 Script/Intent 的续跑与分页信息、当前待回答问题，以及普通采集的覆盖、窗口、epoch、水位和游标。Script 问题来自 supervisor 当前状态，不依赖过滤后的 events。MCP 不重复 _meta.history 或 structuredContent；CLI 退出码按 failureStage 判定。仓库内 CLI/MCP 测试及消费脚本已迁移。

extract schema 同时展示后续 regex/script/output 结构；本工作包对非 null 和 output 在派发前明确拒绝，不假装已实现。快照、提取、预算及其序列化边界测试继续进入 M2b/M2c。

## 验证

- npm test：1358 通过，0 失败，0 取消。日志 `/tmp/aab-m2a-full.log`。
- 新公共返回与 Host 定向组：13 通过，包含真实 tools/list、CLI null/无值 flag、JSON/text/bytes、未知执行、被事件游标过滤的真实待回答问题、采集控制字段；`/tmp/aab-m2a-controls.log`。
- NotallyX：首次 137/138 通过，唯一失败为测试仍期待不含 extract 的旧请求；修正后 该文件 5/5 通过，未重复运行其余已通过测试。日志 `/tmp/aab-m2a-notallyx.log`、`/tmp/aab-m2a-archive-migration.log`。
- verify:package：仓库外全新安装 tarball，受控 ADB，122 个命令，CLI/MCP/Runtime 及任务恢复、归档和关闭通过；产物 `/tmp/aab-m2a-package`。仍使用本机 native 编译；免编译交付归 M5。
- git diff --check 通过。

本机离线与受控执行器测试，不构成真机业务或其他系统安装验收。M1 复审闭环已在 828b1e5 单独提交。
