# 第三阶段 R：iOS SDK 运行实例绑定

本批解决一个实际执行缺口：旧 iOS provider 的显式 URL 可以跳过设备和 App 核验，自动发现会扫描端口并把任意带 `debugBridge` 的服务当作目标。现在每次 SDK 请求都通过所选设备的 App 容器绑定运行实例。Android 固定矩阵继续沿用 3O 冻结结果，没有重跑样例套件，也没有修改样例业务。

## 已完成

- SDK 命令要求明确的 `deviceId/bundleId`。设备 ID 只按 CoreDevice identifier 或 UDID 核对；设备必须有可用的开发隧道、开发模式和 DDI 服务。显式 URL、转发端口也不能跳过这些条件。
- SDK 原子发布 `aab.ios-runtime/v1` 描述文件，包含 App、运行 epoch、PID 和 SDK 端口。Host 从该设备和 bundle 的 App 容器复制文件；旧格式、缺失、未就绪或错误身份在 HTTP 前失败。端口扫描及候选主机兜底已删除。
- 每次请求携带五项身份头，响应保留 `runtimeBinding`。控制请求先核验 status 的协议与身份，避免旧 SDK 忽略请求头后直接执行；SDK 在派发前再次检查，拒绝缺失、重复或不匹配的身份。描述文件发布失败时不准入。绑定是进程路由依据，不是身份认证。
- SDK 命令默认 30 秒总预算，覆盖设备发现、容器读取、预检和响应。子进程取消等待实际退出，HTTP 取消等待连接关闭；失败保留派发与不确定性信息。描述文件上限 4 KiB，HTTP 响应上限 8 MiB；HTTPS 保持证书验证，非法 JSON 不再包装为成功。
- Foundation 请求解析保留重复头供准入拒绝，限制请求头和载荷尺寸并拒绝无效长度。UIKit SDK 和 Flutter 内嵌副本同步。App 侧采证 POST 和 Flutter snapshot 接口保留原生产者合同。
- 命令 schema、公开合同和 npm 发布清单同步；新增模块已实际进入 tarball。

## 本批证据

原始输出位于 `build/ai_app_bridge_artifacts/command-production-phase3r-2026-09-10/`。

| 检查 | 结果与范围 |
| --- | --- |
| 首轮 Host 定向 | 137 项，136 通过、1 个新测试失败。失败因测试显式传入 `runtimeUrl: undefined`，正确触发严格类型拒绝；已改为真正省略字段。原失败日志保留。包含受影响的共享 I/O、Intent/Script 取消、Flutter 生命周期与命令合同；没有重跑 Host 全套。 |
| 最终绑定/采证/TLS | `host-binding-final.log` 32/32。真实 HTTP/HTTPS、本地受控 devicectl 子进程、正确容器参数、端点/旧协议/epoch/PID/端口拒绝、无控制 POST、响应变化、非法 JSON、超限、总期限、SIGTERM 抵抗子进程的实际退出和取消后连接关闭均通过。受控设备替身，不计真机。 |
| iOS CLI 相关 | `host-ios-cli-final.log` 5/5，覆盖发现、设备结构、签名错误、截图留存、不可用隧道快速失败。 |
| Swift 准入及镜像 | `swift-binding-01.log` 6/6，含实际磁盘描述文件替换、发布失败、重启身份拒绝、重复头和长度边界；副本逐字节相同。 |
| 实际 iOS 编译 | `ios-device-build-01.log`：arm64 Debug 样例编译成功，`CODE_SIGNING_ALLOWED=NO`，未安装到设备。 |
| Flutter iOS | `flutter-ios-typecheck.log`：使用真实 Flutter 3.41.9 iOS 框架，插件及完整内嵌 SDK 类型检查成功。 |
| 发布内容 | `package-content/report.json`：实际 npm tarball 的 99 个运行时文件与源码逐字节相同，解压到独立临时目录后，新进程可加载 SDK 命令合同。没有重复执行干净 npm 安装和全套发布验收。 |

发布内容验证首次因本机 Python 不支持 `tarfile.extractall(filter=...)` 而停止；在显式检查条目路径和类型后验证了同一个未变化的包。说明保留在 `package-content/validation-01-failure.txt`。测试重跑不累计成新增覆盖。

## 收口与下一关

本批软件退出条件已满足：SDK 请求不能绕过设备/App/进程核验，控制请求在错误端点前失败，Host 超时和取消有实际 I/O 收尾，拒绝和结果未知不伪装成成功，实际 iOS/Flutter 编译与发布内容通过。除非相关实现变化或出现反证，不重开本批验证。

本轮唯一设备清单 `ios-devices.json` 显示所知 iOS 设备仍不可用；该记录中的型号、系统和开发模式属于离线缓存，不能当作实时真机状态。接入通知已经发出，没有重复轮询设备。

下一关实现 iOS 端动作的准入、排队取消、执行中结束证明，以及按原 `actionId/runtimeEpoch` 落盘和恢复的完成凭据。WDA/native 的设备/App/语义目标绑定仍需单独接通。Host 的子进程和连接关闭不能证明手机端动作已停止，当前 SDK 直接动作也尚未接入跨进程未知结果占用；不能据本批结果开放 iOS Intent/Script。

设备接入后先证明公开存查、原引用与真实 App 进程重启，再完成最小三入口同义流程。Web、持续运行、其余设备边界及最终多 App/整机组合验收仍在总计划中；整体生产验收未完成。
