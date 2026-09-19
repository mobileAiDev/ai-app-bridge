# M2c 提取与预算交付记录

日期：2026-09-19。基线 41edaf5；目标 0.4.0。

公共 CLI/MCP/Runtime 与客户端本地路径已启用 regex、JS、Python 和 output.maxBytes。语义预检在派发前完成：固定相对调用方目录的源码、检查 UTF-8 字节、解释器和语法；不执行用户顶层代码。提取使用独立可终止子进程，复用 Script SDK、语言探测和 IPC；每个请求创建并清理自己的源码目录，活跃上限 2，不建立队列。

JS/Python 使用相同的 kind/response/execution/control 输入；拒绝非 JSON 类型、循环、非有限数字和越界整数，Python 在 json.dumps 前检查。regex 支持 JSON Pointer、命名/未参与捕获、Unicode 空匹配推进，最多 1000 匹配且超限整体失败。输入与输出 IPC 限额分开，包含换行。原执行事实不会被提取值覆盖。

非 null 和 null 超预算会尝试保存最终响应；ref 重读使用同一冻结字节，不执行 provider，不嵌套保存。保存失败独立报告，小结果仍可成功。预算按完整紧凑 UTF-8 正文计算：默认 96 KiB，16–256 KiB；控制区过大明确 controlComplete:false。提取失败/超时/崩溃/超限不带原文兜底、不重放动作。宽 capabilities 和机器 help 超限返回可执行的收窄示例。

## 验证

- 首次全套：1373 项，1371 通过、2 失败；一处旧测试未收窄 Intent schema，一处 IPC 终止时错误保留排队调用。均已修正，29 项相关回归全部通过（含两种语言的帧错误不再调用后续动作）。
- 提取/快照边界组：16 项通过；覆盖 JS/Python 类型矩阵、正则语义、throw/超时/进程退出/非法 stdout/大输出/stderr、原动作调用数 1、ref 重读、保存故障、序列化失败、bytes 范围、预算边界与 8 MiB 真实 native 落盘。日志 `/tmp/aab-m2c-boundaries.log`。
- 真实 MCP：受控保持两 worker 活跃，第三请求 busy 且提供 ref；释放后仅重读该 ref 成功。无设备调用。
- 冷启动测量：`scripts/validation/measure-extraction.js`，8 MiB 大文本与多节点 JSON，JS/Python，单路与并发 2，每组合 5 轮，共 60 个 worker。全部成功，最长 146.76 ms。OS/CPU/内存/Node/Python、样本 checksum、p50/p95/最大值与解析/提取/传输残差见同目录 M2C_MEASUREMENTS JSON。保留 2000 ms 默认值；仅本机参考数据。
- 已同步发现输出的消费测试与 verify:package；完整最终包及真机验收仍在 M4/M5，不能据此宣布可发布。

Script SDK 的有界诊断格式和通道捕获为共用实现，本包先供提取使用；完整 Script 状态/持久化诊断及旧 runner 清理归 M3。
