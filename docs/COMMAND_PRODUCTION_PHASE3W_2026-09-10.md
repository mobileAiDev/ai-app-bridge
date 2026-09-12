# 第三阶段 W：iOS 启动采证顺序

## 结论和范围

3V 真机发现的 SDK 启动采证丢失已修复。`start()` 返回后立即写入的日志和状态，与页面启动事件和网络采证一起进入原持久存储；样例 App 的启动调用、业务逻辑和 UI 均未修改。四类原始记录已在 App 冷重启后按原 `mobileFactId` 取回，载荷和引用保持一致。

整体生产验收仍未完成。Android 3O 固定矩阵继续冻结，iOS/Web Intent 与 Script 仍关闭。样例的网络记录是既有手工采证 `https://example.test/sample`，不代表真实 HTTP 交易；`sample:screen=home` 是 Bridge 采证持久化，不代表样例业务数据库持久化。

## 修改

- 生命周期在排队打开 C 存储前同步声明 opening。`MobileCaptureStore` 在 opening 期间保留不可变载荷快照，最多 256 条、1 MiB 的序列化载荷与身份字符串；查询只读原持久后端，不读待写队列。
- 挂载成功后，先按顺序向同一 C writer 提交所有待写记录，再开放后端给并发查询、交付接收回执。新写入不能越过尚未提交的启动记录。
- Swift SDK、HTTP 采证 POST 和 Flutter MethodChannel 共用异步 append。原有 SDK `record*` 调用形状不变；HTTP/Flutter 不提前制造成功回执，回执保留原后端 `mobileFactId`，`accepted:true` 仍不等于 `committed:true`。Flutter 结果回到主线程。
- 打开失败、禁用、队列溢出和停止都明确拒绝；停止清空待写队列，失效的挂载回调不能重放旧记录。未成功保存的记录保留 loss，既有历史 gap 不被本轮成功清除。
- `ios-status.capture` 增加 `pendingRecords`、`pendingBytes`。规范 Swift 源与 Flutter 镜像同步。

## 固定设备与实际结果

设备为 iPhone 17 Pro Max / iOS 27.0 / `00008150-001005143A32401C`，App 为 `io.github.mobileaidev.aiappbridge.iossample`。继续使用 3V 的签名环境和原数据容器。

| 检查 | 新证据 |
| --- | --- |
| 安装与第一次启动 | 公开 MCP 安装、启动、状态成功；原 PID 804 变为 850，epoch 为 `7EEF5609-3C15-46F6-AD1C-4FD75AC747F7`。待写计数和字节均为 0。 |
| 启动四流 | `iOS native sample launched`、`sample:screen=home`、`screen_ready` 和既有网络采证均按原源码产生，查询返回 committed。 |
| 本次启动窗口 | 时间下界来自安装前的手机 `ios-status.updatedAtMs`，不从结果反推；四流窗口均 complete、无 gap。未限定历史窗口的旧 loss 仍如实显示。 |
| App 冷重启 | 公开 `ios-launch-app` 终止并重新启动，PID 850 → 855，epoch 变为 `D925B174-D976-44DF-9053-C849E0C6DCB4`。新进程再次记录启动日志和状态。 |
| 原引用恢复 | 四个原 `mobileFactId` 均由新的 Host、App 进程从设备原存储读取。逐页游标推进，固定上界 9916；命中页载荷和引用与第一次读取深度相等。 |
| 异步 HTTP 入口 | 两个明确标记的日志/状态协议探针返回真实 accepted 回执，随后公开查询按同一引用读到 committed 原载荷；数字 actionId 被明确拒绝。 |
| 页面状态 | `cold-launch.png` 已人工视觉核对：Native Ready、输入框为空、WKWebView Ready；截图只是页面佐证，持久化结论来自原始记录读取。 |

产物目录：`build/ai_app_bridge_artifacts/command-production-phase3w-2026-09-10/`。原记录与引用在 `startup-originals.json`；完整分页链和实际命中在 `cold-originals-verified.json`；包二进制摘要在 `sample-binaries.json`。`checkpoint-01.json` 固定源码副本和证据摘要。3V 的 171 项历史产物摘要复核无变化。

## 受影响检查

- 29 项 Swift 检查通过：真实 C 持久存储、生命周期、源码镜像与 5 项新启动行为。覆盖启动四流、可变输入快照、重入写入顺序、条数/字节溢出、打开失败/禁用、停止和迟到挂载。
- 补齐身份字符串的字节计入后，只复跑 5 项启动检查与源码镜像检查，6 项通过，不累加成新的覆盖总数。
- Debug arm64 iPhone 签名构建、公开安装与运行通过；Flutter 的 17 个 Swift 源文件使用真实 Flutter iOS 框架和 Xcode SDK 完成 typecheck，无编译诊断。Flutter 真机 App 的启动链路仍需在后续平台验收中实测。
- 测试编写中的 4 次编译失败原日志保留，之后的通过结果在 `swift-startup-05.log`、`swift-startup-final.log`。`git diff --check` 通过。未提交、未发布代码。

## 本轮新发现与下一步

历史原引用查询仍从全局存储前缀分页扫描。固定上界 9916 的同一数据容器中，每条目标均用了 22 页：日志 59,171 ms、状态 57,969 ms、网络 58,150 ms、事件 58,233 ms。耗时由实际 MCP 请求与响应时间相减累计，包含设备发现、容器描述符核验和读取，不是纯 C 查询耗时。详见 `cold-query-timing.json`。

这证明恢复正确性，不证明查询性能达标。下一轮围绕这四个固定原引用降低扫描成本，保留原库、原载荷和未知结果约束；成功后停止该项优化，回到真机取消/Host 中断/焦点变化及既有 Web 关口。不得通过清库、重写记录、Host 缓存或缩小旧引用验证范围制造性能提升。
