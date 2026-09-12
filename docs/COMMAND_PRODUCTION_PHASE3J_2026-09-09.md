# 第三阶段 J：跨进程设备所有权与 Flutter 未知回执恢复

本轮交付是 Bridge 的设备所有权机制，未修改 LocalSend 业务代码或 Android/Flutter SDK。已证明同一 OS 用户、同一共享目录内，不同 Host 进程和不同包名对同一 Android serial 的变更互斥；Host 死亡后的未知动作保持阻断，Flutter 可以凭原动作的有效 SDK 结束回执恢复。整套体系仍未达到生产就绪。

## 当前实现

- `device-ownership-store` 用 SQLite 的独占事务提供 OS 管理的文件锁，使用独立原子写入并同步的 JSON 记录派发状态。文件锁没有心跳过期；进程死亡会释放 OS 锁，但不会抹掉未知动作。锁文件不删除，避免不同 inode 上出现两个所有者。
- 默认所有权目录为 `~/.ai-app-bridge/device-ownership/v1`，与工作目录、包名、FactStore 路径和 npm 安装位置无关。测试显式使用同一个 `AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR`。不同 serial 可以并行；嵌套能力调用延续原所有者。
- 普通命令、Intent、JS/Python Script 复用这一所有权。Flutter 在派发前记录 actionId、runtimeEpoch 和原目标连接配置；ADB、普通 SDK HTTP、Native 手势也接入派发记录。不确定的结果不能被包装层的返回或 `finally` 当成已结束。
- 安装后台进程另有保留记录。它与同一安装 Intent 的系统确认页操作共存，一次 UI 调用结束不能清掉后台安装；取消后的本地 ADB 退出仍不足以证明手机安装流程结束。
- 新公开命令 `device-ownership` 接受 `operation:"status"|"reconcile"`、`serial` 和可选 `timeoutMs`。恢复过程取得独占权，只查询/取消原记录指向的 Flutter 动作；必须验证匹配身份的 `aab.flutter-execution/v1` 结束回执。没有强制清除、替换目标、过期清除或重放选项。

这项保证针对合作的 Host 进程和同一 serial，不覆盖绕过 Bridge 的 ADB 客户端、其他 OS 用户、跨主机控制，或同一手机的两个不同 serial 别名。验证环境为 macOS、Node 26.3.0；其他 Host 系统与 Node 版本仍需发行矩阵验证。

## 验证与制品

证据目录：[command-production-phase3j-2026-09-09](../build/ai_app_bridge_artifacts/command-production-phase3j-2026-09-09/)。源码变化、发布文件对应和证据哈希见目录内 `phase-changes.json`、`source-verification.json`、`package-source-verification.json`、`evidence-files.json` 与 `acceptance-summary.json`。

| 验证 | 结果与范围 |
| --- | --- |
| Host 全套 | 927/927，0 失败/取消/跳过，22710.409708 ms；`logs/host-all-final.log` |
| 所有权专项 | 12 项：独立管理器、五进程竞抢、不同 serial、空闲进程死亡、执行中 SIGKILL、未知阻断、原身份保持、错误/有效回执、过期 token、损坏记录、不可写记录、安装保留记录 |
| 实际 HTTP 接线 | 新增公开恢复测试走默认真实 provider 导出和 HTTP，不仅注入接口；`test/flutter-action-wire.test.js` |
| 干净 npm 包 | 安装及 native 编译、公开命令/权限/Intent/Script/退出合同全部通过，95 个入口；93 个非依赖发布文件与源码、tarball、干净安装逐字节一致 |
| 真机跨进程故障 | `device-final/report.json` 通过；原 Host SIGKILL、另两个 MCP Host、独立 CLI、Intent、JS/Python 的拦截与恢复 |
| 正常同义流程 | 三种入口各 11 次动作、22 项检查通过；Intent 29.433 s，JS 28.106 s，Python 28.186 s |
| 离线归档 | 9/9：首次与最终故障流程各 3 份被拦截操作归档，正常流程 3 份；禁用 ADB 与 FactStore 后验证搬移副本 |

最终 tarball SHA-256 为 `0620adca913650925fe32d8f96c4438b0f67f9f2863a1e71ad35ca1e57cd0d98`。手机为 `b46093e6 / PKR110 / API 36`，LocalSend 包 `org.localsend.localsend_app.bridge_sample`。继续使用第三阶段 I 的 SDK 与 APK，源码逐项未变，手机安装 APK 字节再次核验为 `0111928248585d4a1c21def8f70739525003c2ae16b59f70e3ed1c5bdf55fa68`，见 `sdk-reuse-verification.json`。本轮没有重新宣称已运行 Android/Flutter 全套测试。

## 真机故障的具体证明

公开 `tap-flutter` 执行原动作 `ownership-1788907262307`，真实手机从接收页进入发送页。显式 Host 故障代理转发一次 SDK 请求，记录实际 SDK 完成响应，但不向原 Host 交付响应。原 Host 存活时另一个包/Host 获得 `target_busy`；原 Host 被 SIGKILL 后，另一个 Host、重启后的 Host、CLI、Intent、JS 和 Python 都无法发送新动作，返回 `device_ownership_unresolved`。

首次恢复查询同样丢失响应，占用保持不变。代理恢复传输后，新的 Host 取得原 actionId/runtimeEpoch 的结束回执，解除占用；随后公开命令恢复接收页。手机同 actionId 的事件、独立新 UI、截图和 SDK 回执共同支撑结果。`FlutterSharedPreferences.xml` 的前后原始字节 SHA-256 均为 `4917a125543d01f51b35a36eabb92a416eadeae758ac75bbc99ee45942fe8b80`。这不代表整个文件系统或所有 App 状态恢复。

这是 **Host 响应丢失与崩溃** 的真机证据：手机上的动作已经完成，而 Host 尚未取得结束证明。它不能冒充真实 Dart 阻塞或触摸中取消测试。故障代理只替换该测试的转发发现和响应传输，其余 ADB 读操作转交真实 ADB；原始 wire 与适配器保留。正常同义流程使用普通 ADB，并继续使用同一个已经恢复的设备所有权目录。

正常流程仍为发送文本草稿、Unicode 输入、清空、取消、重开空编辑框、指定设置容器滚动及恢复、回到接收页。Intent 的 22 项为外部控制器检查，JS/Python 各有 22 项设备断言。三种流程全部结束后，再次通过真实 ADB 读取偏好文件，原始字节哈希仍相同，见 `preferences-after-all-flows.json`；发送页和最终接收页截图已人工复核，见 `visual-review.json`。这些短流程耗时不代表整 App 或整机回归性能。

## 保留失败

首轮真机验证正确拦截了所有入口，但恢复模块调用了未导出的 `bridgeGet`，未能恢复。改成实际导出的 `flutterCompletion` 端口，补真实 HTTP 接线测试；同一原动作已单独恢复并恢复页面，见 `device-first-recovery/`。随后从新干净包重跑完整故障流程通过。`device-first/` 保留原失败，不改记为通过。

新所有权使原来共享同一个假 serial 的独立单测互相影响。测试现在按测试文件分配明确命名空间，每项用例开始前只清理已释放 OS 锁的受控假设备记录。原先“响应丢失后释放租约”的断言改为保留未知占用，没有削弱生产阻断。并行 npm native 编译时，既有 10k 节点性能门禁一次 P95 为 24.079083 ms，超过 20 ms；该失败保留在 `host-all-fourth.log`，不改阈值。随后无并行打包的完整 Host 重跑通过，不能据此宣称所有压力环境达标。

## 下一关

继续完善 **Native 手势、ADB/UIAutomator 和安装的远端结束证明及恢复协议**。当前它们的未知记录会正确阻断新写入，但还不能全部通过公开恢复自动解除；`not_active`、本地进程退出、换一个 SDK epoch 均不作为完成证明。还需把详细结束凭据纳入各执行记录，避免仅靠设备最近一条所有权记录保存。

同一手机不同 serial 别名、其他 Host 平台/Node 版本、系统窗口/UIA、更多安装与权限故障、iOS/H5/Web 同义合同、原四 App 固定范围和持续运行/压力/性能验收仍未完成。总目标保持生产级全体系，当前结果只关闭已经取得证据的这部分关口。
