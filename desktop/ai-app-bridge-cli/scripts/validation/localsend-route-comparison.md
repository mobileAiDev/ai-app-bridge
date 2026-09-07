# LocalSend 三种交互方式对照

本工具比较**当前工作区**的既有 batch、普通 Node.js 循环调用 MCP run、Script 子进程 ctx.call。它不是已发布版本基准，不含模型决策循环，不推算模型往返时间、token或费用。

运行时必须明确传入serial及固定debug包：

```sh
node desktop/ai-app-bridge-cli/scripts/validation/localsend-route-comparison.js \
  --serial ACTUAL_SERIAL \
  --packageName org.localsend.localsend_app.debug \
  --out /absolute/path/to/new-output-directory
```

未运行设备前可以用相同参数加`--plan-only`输出计划；该模式不会启动MCP、编译OCR或操作设备。`--rounds`默认3且至少3；每轮轮换顺序，让三种方式各占一次第一、第二、第三位置。

所有方式使用同一11步：接收首页wait → 截图+flutter-nodes → tap-flutter-text打开“通过链接接收” → wait独有说明 → 截图+flutter-nodes → tap-flutter-text“返回” → wait首页且独有说明消失 → 截图+flutter-nodes。准备阶段先读取当前节点；只有确认处于该已知弹出页面时才点击返回，否则遇到陌生页面记录失败，不进行盲目恢复。

外部共享oracle用Flutter节点与截图Swift Vision OCR共同判断：打开时“在浏览器中打开其中一个链接：”出现；返回时此说明消失，“通过链接接收”和独立的“接收/发送/设置”标签齐全。截图同时须可读为PNG、前台包匹配并保留SHA256。OCR错误/空结果是inconclusive，不算通过。Script的completed或自报passed不参与业务判断。可加`--negative-oracle`故意使用错误打开标签；工具仍保留正向oracle与负向oracle结果，仅当真实正向通过且错误期望被拒绝时，负例验证才算成功。普通运行也记录这一负例，不多操作设备。

报告`report.json`保留每次尝试及全部失败。分别报告准备耗时、执行wall、OCR/oracle耗时、对应真实MCP请求数；MCP初始化和OCR编译单独计入setup。执行wall包含传输、等待、设备工作、原始结果落盘以及Script状态监控；batch一次回传保存全部步骤，JS与Script逐步保存结果，所以文件落盘次数的差异也已包含其中。实际请求逐条写入`mcp-transcript.jsonl`，没有估算模型成本。失败尝试仍在统计中；MCP请求timeout后停止整个对照，避免未知执行尚未结束时继续操作设备。

三种模式使用同一个 MCP 进程，Host FactStore 固定隔离在输出目录的 `host-facts`，统一使用 `64mb` cache profile，并将这两个条件记录在报告中。

Script 状态查询固定 `waitMs:1000`、单请求超时 10000ms，并可被进度事件提前唤醒。这会增加真实 MCP 请求数；这些查询不是模型调用，不能作为模型费用或模型往返次数。三次 Script 尝试均使用相同配置。

每次目录保留步骤定义、准备状态、原始返回、Script输入/运行快照、PNG、OCR原文、外部oracle输入与结果。OCR是Mac本地验证工具，不是产品或Android新增功能。安装环境需Node、macOS/Xcode命令行工具及当前设备所需的ADB连接。

纯oracle测试（不操作设备）：

```sh
node --test desktop/ai-app-bridge-cli/test/localsend-route-comparison-oracle.test.js
```
