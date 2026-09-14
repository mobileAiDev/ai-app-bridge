# 0.3.3 / 0.3.4 修复与发行交接

本次统一发布 CLI/MCP、Android SDK/Gradle 插件、iOS Git tag、Flutter 与 Web SDK。发行包确认可下载后再升级本机和消费项目；源码内的发行版本清单先随标签冻结。

## 0.3.4 追加修复

0.3.3 已完成各渠道发布和 npm latest/next 同步。重连本机 MCP 时确认一个新问题：MCP 的绝对 ADB 路径与 CLI 的 PATH 查找最终使用同一可执行文件，但原始环境字符串参与 Runtime 指纹，导致 `runtime_configuration_mismatch`。

0.3.4 按实际可执行文件路径判断 ADB 身份，支持 PATH、相对路径和符号链接的等价写法，并在启动时固定解析结果；实际选择其他 ADB 仍拒绝混用。缺少 ADB 不阻塞没有 Android 设备依赖的能力。本次 SDK 仅同步版本，设备执行行为沿用 0.3.3。

验证目录为 `build/ai_app_bridge_artifacts/publish-034-20260914-01/`：

- 真实 CLI/MCP 入口的新增回归先复现原错误，再验证双向连接、同一 Script 结果互读、不同工作目录、符号链接、重启后读取，以及不同 ADB 的派发前拒绝。
- 最终 CLI 全套 **1,287 项通过**；相关入口检查 29 项通过。
- 0.3.4 的实际 npm tarball 完成干净安装、native 编译及 CLI/MCP 共享 Runtime 协议检查；SHA-256 为 `726d24ae788db3eddabc484b2ef3e095eb6d50e1dd1c3ba27ef610ab33af735b`。
- Android release AAR 与 Gradle 插件构建通过，iOS native 示例 arm64 构建通过。Flutter dry-run 仅剩提交前工作树修改警告，冻结提交后再完成发布检查。
- 没有以本轮检查代替完整跨平台 App 业务回归。消费端将在公开 0.3.4 产物确认后继续升级。

## 修复范围

- Native 观察以当前 Activity 的窗口组为准，保留 Dialog/Popup，修正前进和返回时 Activity 与节点错配。
- Android 的 SHA-256 校验探测实际可用的 standalone、toybox、busybox applet；不依赖 ROM 名称或固定 PATH，也不降低 APK 和命令完整性要求。
- iOS 明确的未安装 App 启动拒绝及时完成所有权结算；未知结果保留原始 devicectl 文件，公开 reconcile 按原调用核对，不因 JSON 版本号差异误拒绝。
- 原安装缺少 commit 回调时，公开 `device-ownership cancel-install` 可按原 actionId 取消原 PM session；丢响应读取同一取消回执。只有明确未派发的取消任务允许显式重试，不重发原安装、不推断回滚。
- CLI `--version`、记录目录的创建/复用、字段错误提示、Script 起步的 capture.read 权限修正；明确 freeze 暂停整个 App 和升级后 MCP 必须重连的语义。
- Reader 回归脚本仅对未派发的 UIA 读取变化做有界重试；LocalSend 验证脚本移除已退役 batch 入口。
- 无实现的 Gradle 历史选项显式弃用，保留既有 DSL 编译能力，不把选项值当成功能已实现。

## 验证边界

真机修复证据保存在 Git 忽略目录 `build/ai_app_bridge_artifacts/issue-fixes-20260914-01/`：

- K2 Android 7.1.2 在没有 standalone sha256sum 的条件下，官方 install-apk/Intent 通道通过 busybox SHA-256 完成安装并匹配设备 APK 哈希。
- OPPO Reader 的 Search → Shelf → Search → Shelf 同链观察一致；原始阅读返回和前进反例均通过回放。没有宣称本轮重跑完整阅读业务。
- iPhone 的未安装 FreeOTP 启动得到明确拒绝，随后 Flexify 可启动且设备占用空闲；本轮没有重跑 iOS SDK/H5 业务矩阵。
- OPPO 公开取消以真实 PM session 和缺失原回执的故障注入验证，取消后系统记录 session 已销毁、占用空闲。两次普通重装直接成功，不将故障注入写成 OEM 弹窗复现。

发行检查保存在 `build/ai_app_bridge_artifacts/publish-033-20260914-01/`：

- CLI 全套 1,284 项通过；随后补充“取消尚未派发”的边界，并对安装、恢复、Intent 和公开合同重新跑相关测试。
- Android Debug/Release JVM 各 185 项、Gradle 插件 6 项、UIA 43 项通过；完整 build 通过。本机预览 SDK 的 37.0 解析问题用命令行 Lint 9.3.2 完成检查，没有关闭 Lint。
- 根 Package.swift 和其原始编译输入在干净目录完成 iOS arm64 编译；避免 Xcode 扫描本地下载的 SDK 与历史构建目录。
- Web 22 项通过；实际 npm tarball 在干净目录安装并执行 CLI/MCP 共享 Runtime 协议检查。
- Flutter pub dry-run 的源码检查通过；提交前的工作树修改警告保留记录，最终发布使用冻结提交。

本次修复关闭已确认且适用的问题。调试监听的鉴权评估、未复现的理论分支及完整跨平台业务矩阵不是本轮已经完成的验收结论，原审核记录继续保留。
