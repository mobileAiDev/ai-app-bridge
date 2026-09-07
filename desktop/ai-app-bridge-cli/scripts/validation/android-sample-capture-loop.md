# Android sample 的 UI → state → 自动 network 闭环

固定包名 `io.github.mobileaidev.aiappbridge.sample`；必须显式传 `--serial` 和新的 `--out`。脚本不自动安装、启动、清理数据或选择设备。先由执行者准备真实 sample 的 `DebugBridgeNativeTestActivity`，并确保 SDK 的持久后端已正常 attach。

操作前严格检查手机 status 的 `debugBridge.version === '0.3.0-rc.1'`、`capturePersistence.persistent === true`、`lifecycleState === 'OPEN'`，以及当前原生测试 Activity。自动捕获来源字符串核自 Android `AiAppOkHttpAutoCapture.kt` 的 `source = "okhttp-auto"`。

```sh
node desktop/ai-app-bridge-cli/scripts/validation/android-sample-capture-loop.js \
  --serial <已核对的设备序列号> \
  --out .tools/implementation-2026-09-07/sample-loop-1
```

执行通过真实 MCP stdio 客户端启动真实 JS Script child：

1. 当前树读取唯一 `Native counter: N`。读取手机 status 的 `updatedAtMs` 作为新的 `sinceMs`，不假定主机与手机时钟相同。读取完整 state 基线，保存手机签发的 watermarkCursor/epoch；基线可以为空。
2. `tap-text Native Increment`，指定 `appLocalAction: true`、`feedback: off`。以本轮基线 factCursor/epoch/sinceMs 轮询 `native_test.screen` 的 `action=increment` 且 `counter=N+1`，另取新树核对精确文本 `Native counter: N+1`。两条证据分别做设备断言。
3. 在相同 mutation revision 中独立做三个负例：动作前旧树应为 `inconclusive`、缺少真实 evidence 应为 `inconclusive`、有效新 state 搭配错误 counter 期望应为 `failed`。期望的负例失败单独报告，不能当成正向业务结果通过，也不能只按脚本 completed 判定验收。
4. 再读取手机时刻和 network 基线，点击 `Run OkHttp Auto Capture`。仅轮询只读 tree 等待 `OkHttp auto capture: HTTP 200`，不使用可能干扰动作窗口的 wait-text。使用基线 factCursor/epoch/sinceMs 查询真实 `source=okhttp-auto`、GET、本 App 实际 port 对应的 `/v1/logs?limit=1`、HTTP 200 且无 error 的网络记录，单独做 network 和 UI 断言。

输出保留原始 MCP transcript、Script 每次观察返回、Host refs/窗口/cursor、正负 verdict、新树及两张截图。截图使用显式外部输出路径 `counter-after.png`、`network-after.png`，不会随着 Script 临时目录删除。输出目录非空时拒绝覆盖。

MCP 的 Host FactStore 隔离到本次输出的 `host-facts` 目录，缓存 profile 固定 `64mb`，不会写入用户默认 Host store。

此 harness 只验主 UI/state/network 链。重启后的稳定 ref、clear 后失效、断连重连及保留窗口压力由主任务在外部继续验证。它是验证资产，不是生产 Host 的手机 payload 缓存，也不能据此宣称任意 App 已完成验收。

所有后续查询保留原 baseline 的设备 `sinceMs`，避免游标扫描又把启动前的显式 gap 算入新窗口；不能用主机时间补这个字段。report 顶层提供 `refs.state`、`refs.network`、`beforeEpoch`、`afterEpoch`、`expectedStateCounter`、`expectedNetworkUrl`、`positiveAssertions`、`negativeAssertions` 供外部生命周期脚本读取。当前手机协议的条目只有 `id`，对应 ref 的 `captureId`；harness 严格按 stream + captureId + epoch + target 选出唯一真实 `mobileFactId`，不按数组第一项猜测，也不向原始 payload 伪造字段。
