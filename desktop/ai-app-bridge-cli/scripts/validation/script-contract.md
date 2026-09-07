# Script 公开入口契约验证

这是开发期真机集成测试，不会被 `node --test` 自动发现，也不会在 import 时操作设备。它启动显式指定的 stdio MCP 服务，经 `run(command: "script")` 启动真实 Node 子进程。

从仓库根目录执行；目标 App 必须已安装、已启动并集成可用的 Android Bridge。设备应由本次验证独占，输出目录必须尚不存在，父目录应位于项目忽略的产物目录。

```sh
node desktop/ai-app-bridge-cli/scripts/validation/script-contract.js \
  --server desktop/ai-app-bridge-cli/bin/mcp-server.js \
  --serial FYZLAU49X8OVQGJ7 \
  --package io.github.mobileaidev.notallyx.sample \
  --out build/ai_app_bridge_artifacts/bridge-contract-2026-09-07/new-run
```

替换 `--server` 可验证一个独立安装包中的 `bin/mcp-server.js`。替换 `--serial` 和 `--package` 可指向其他 Android native Bridge App；场景没有 NotallyX 选择器、数据模型或数据库依赖。参数化入口不等于其他 App、平台或安装方式已通过实测。

## 验证内容

运行 8 个 Script operation，包括中断和恢复，检查 17 项明确的合同：

- 当前公开入口发现 Script，设备状态与显式目标一致。
- 新树证据可用；两次截图的文件 hash 与签发 ref 一致。
- 执行完成、设备断言、代码断言分开统计。有效证据配错误谓词返回 `failed`。
- 缺失证据、篡改证据、另一执行的证据、错误证据流及动作之前的证据返回 `inconclusive`；重新读取后可通过。
- 在等待 Agent 时取消，子进程不能继续派发后续动作；下一条 Script 可执行。
- MCP 进程重启后，已完成和已取消的 operation 不能通过 resume 重放；`restartPolicy: none` 明确报告 `runtime_lost` 且不能恢复。
- 最后一个 checkpoint 之后已派发副作用，恢复返回 `ambiguous`，不会自动重复。
- Node 子进程退出、MCP 进程退出后，显式 checkpoint 可恢复到真实设备 provider；旧 observation 无效，必须重新读取。
- 关闭后复制 Host FactStore，连续重开两次，校验所有 envelope checksum、ID 和动作收据。8 个 operation 总计恰好 7 次 `launch-app`，没有恢复时重复派发；原始 store 的文件 hash 不变。

## 结果和范围

`report.json` 中的 check `passed` 表示**观察到预期契约行为**。负向用例的断言仍保留为 `failed` / `inconclusive`，没有改写成业务通过。

产物包括冻结的控制器与场景、实际 MCP 请求/响应、Host stderr、原始 `ctx.call` 返回值、截图、持久记录副本与校验结果、运行时 `bin/` 文件 hash、产物 manifest。退出码非零或 `report.ok !== true` 均表示本轮未通过。

脚本只进行读取和 `launch-app`。它不测试 App 的业务逻辑、不写业务数据、不安装 APK、不改权限、不重构 sample。树检查仅验证返回的可见节点，`maxNodes: 100` 不代表完整页面覆盖。

进程故障由 Node `process.exit(31)` 和 MCP `SIGTERM` 制造。此测试不证明断电、USB 物理断连、写入过程中强杀、正在执行设备动作时的取消、任意 JS 调用栈恢复、Python、Intent 全流程或 iOS 已通过。
