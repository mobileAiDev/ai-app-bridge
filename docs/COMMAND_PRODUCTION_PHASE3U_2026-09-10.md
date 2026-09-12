# 第三阶段 U：WDA 原任务取消与持久恢复

本批关闭 WDA 写响应未知后无法恢复的具体缺口。公开输入、点按、滑动和 session 创建/关闭统一提交受管动作；排队取消可以在 UI 线程忙碌时生效，已提交事件只能由原 XCTest 回调证明结束。完成记录写入真实分段存储，Host 重启后按原身份与目标恢复占用，不重放动作。

Android 固定矩阵继续冻结。本批没有 Android、Swift SDK、Flutter 或样例业务改动，没有手机扫描或操作。只查了一次本机模拟器设备和运行时清单，两者均为空；这不是 iOS UI 验证。iOS 设备接入通知仍待回复。

## 实现与公开合同

- 仍为 98 个公开命令。复用 `ios-execution`，增加严格的 `kind:wda` 分支；SDK 与 Runner 参数不可混用。机器合同见 [3U 快照](audits/2026-09-10/command-contract-phase3u.json)。
- Runner 控制请求不经过 UI 队列，动作准备与事件提交仍在主线程。排队动作必须取得执行许可；排队取消不产生副作用。原事件已经提交时保留占用，取消禁止后续步骤，原回调结束后才结算。
- Session 创建/关闭与触摸、输入共用一个执行槽。删除旧 session 写路由和旧 Host swipe 组装函数，阻止公开路径绕过受管执行；保留必要只读 WDA 路由。
- Runner 以 `aab.wda-completion/v1` 保存原 Runner、operation、App/PID、session、actionId 和 runtimeEpoch，使用真实 C 分段存储同步提交。写盘失败保持占用；重试取消只重存已经结束的同一结果。真实磁盘按 64 条/2 MiB 分页读取，游标固定提交上界和查询范围，无内存结果替代。
- Host 在派发前持久保存原身份与执行目标；同一物理 UDID 的跨 App、设备别名操作共用占用。恢复必须匹配原目标及已提交记录，新服务进程的 epoch 不能代替原 epoch。缺失、淘汰、错误或未提交凭据均不能释放占用。
- `ios-input` 从原来的多次 Host 写入收敛为一次逻辑动作。Runner 对同一明确编辑器依次执行点击、可选一次 select-all/delete、空值观察、输入；每个事件检查 App/PID/session、编辑器及许可，键盘事件检查焦点。没有替代输入端点或多种清空重试。
- 固定 WDA 14.1.1 的准备副本包含 8 个 Bridge 原生源文件，并复制发行包中同一 C 存储核心；记录源文件摘要。node_modules 上游 WDA 不被修改。

完整参数和恢复用法见 [公开合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#ios-wda-execution-and-recovery)。

## 验证结果

证据目录：`build/ai_app_bridge_artifacts/command-production-phase3u-2026-09-10/`。以下按不同检查计数，重复构建不增加覆盖。

| 检查 | 实际结果 |
| --- | --- |
| Host 定向检查 | `host-wda-execution-01.json/log`，44/44。包括 WDA 目标 13 项、新恢复 4 项、项目/子进程 7 项、原 SDK 执行 4 项、共享参数合同 16 项。受控 devicectl 子进程、真实本地 HTTP、文件副作用和实际 Host SIGKILL；不是 iPhone 操作。 |
| 原生执行与存储 | `native-execution-01.json/log`，实际编译并运行 Foundation + C 存储，8 个软件场景以及独立进程冷读。覆盖主队列未处理时取消、已取得许可后未知阻断、原回调结算、排队期限、无效/过大结果、分页游标、实际 ENOTDIR 写盘失败与恢复、不重放。 |
| 原生绑定 | `native-binding-01.json/log`，针对改为线程安全读取的身份重新执行实际磁盘绑定检查，通过。执行核心未改变，没有重跑已通过的执行场景。 |
| 实际 arm64 Runner | 最终 `wda-arm64-build-03.json/log` 通过；包含新控制路由、XCTest 事件回调和实际 C 存储。使用正式默认测试 bundle ID，关闭签名，未安装；这只证明编译链接。 |
| 发行包 | `package-content/report.json`，103 个运行文件及 8 个 WDA 源文件逐字节一致；实际 tarball 在干净目录安装，node-gyp 生命周期通过，新进程从安装依赖准备 Runner。新增了从发行依赖复制 C 源码的构建路径，因此本批执行一次这项发行验证；不重跑 Android 或完整 Host。 |
| UI 环境 | `simulator-availability.json`，无可用设备或运行时。没有下载模拟器运行时，没有把历史配对设备当作在线设备。 |

发行包 SHA-256：`0af7b112407ea7a9ca56cc7e58cd6a4a316ff922c7a7f793c7afe38f60ab6285`。

保留初次 `wda-arm64-build-01` 的真实失败：编译器没有正确的事件合成回调声明。核对固定 WDA 原码使用的 `(BOOL, NSError *)` 回调后加入精确本地协议；第二次构建通过。最后清理旧 session 写入口、调整线程安全身份读取并在事件许可前重查编辑器，第三次只重建受影响的 Runner。未重复 44 项 Host 或原生执行场景，未把失败日志改成成功。

## 限制与停止条件

1. 已提交给 XCTest 的事件没有主动中止保证；取消后等待原结束回调。回调永久缺失时保持未知占用，不以 Runner 空闲、重启或本地请求结束释放。
2. XCTest 键盘事件使用当时的焦点。提交前的编辑器/焦点检查不能原子阻止 App 在进行中的事件里切换焦点。真实输入、清空、触摸和焦点回调行为仍待设备验证；不把编译或模拟 HTTP 结果称为 UI 通过。
3. 完成记录证明该执行回调结束，不证明业务成功，也不代表任意业务代码启动的异步工作全部结束。缺失或淘汰的原记录不能恢复。
4. 本批不开放 iOS/Web Intent/Script，不完成 install/launch 的独立结果、多 WKWebView、全平台和整机验收。

上述 WDA 软件关口到此冻结；源码未变且没有新反证，就不再重复回归。下一项独立开发是 Web 生命周期与存查合同，先检查真实路径和已有证据，再处理具体缺口。iOS 真机项目等待已发出的设备接入通知；不重复扫描或发送接入问题。

全局只按[固定剩余关口](BRIDGE_NEXT_GATES_2026-09-08.md#固定剩余关口与停止条件)推进。每一项必须有缺口、证据和退出条件；旧阶段段落、测试数字和样例功能数量不另行产生任务。整体生产验收仍未完成。
