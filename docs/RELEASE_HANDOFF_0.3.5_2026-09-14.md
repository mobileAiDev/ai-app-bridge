# 0.3.5 修复与发行交接

本版修复 Android UIA 原回执启动审计、Android 7 UIA/权限观察、iOS 隧道探测和失败启动所有权结算。各 SDK 同步 0.3.5。渠道发布、样本安装和业务验收分别核验；不声明 115 条能力均已完成跨平台真机业务验收。

## 修复与设备证据

- OnePlus b46093e6 / API 36：原 nodeRef 回调在 journal 审计时误读 target.nodeRef，改读原绑定 ref。旧 epoch 的 31 条终态回执已保留，对账后显式创建新 runtime。正常 stop/start、死亡进程恢复、旧引用拒绝、回调和 SDK 计数验证通过。
- K2 Mini KM16232B40184 / API 25：采用 API 25 可用的文件 API、POSIX 持久化与对应系统 Binder 方法，保持 OS 锁、原子重命名、fsync 与原始回调，不加入 dump 或坐标回退。同样的 UIA/Script 计数和死亡恢复验证通过。真实权限 Intent 的拒绝动作匹配系统弹窗和 PackageManager USER_SET；H5 Intent 与三轮连续 Script 通过。
- 收银机 YIC-R68P / API 30：UIA runtime 启动及 80 节点观察通过，未改动收银 App、业务数据或执行支付。
- iOS：list 快照未就绪时对唯一选中设备执行 details，再以相同 UDID 核验。原 CoreDevice 4016 failed JSON 公开 reconcile 成功。另修复本轮出现的 XCTest 自动化确认超时占用：启动前保存原测试调用与结果路径；原初始化失败可结算，旧 ios-setup 回执与保留的 Host action、XCTest 结果共同对账。无 lock 删除。
- cancel-install 在设备空闲、无待处理安装时返回 install_action_not_pending / recovered:false / dispatched:false。K2 已实测，不声称取消了已 commit 的安装。
- Python assert_(dict)、完整证据要求、freeze/thaw 和 iOS 恢复合同已补充。失效 View 身份保护、缺失 Script 结果及部分采集拒绝未被改成虚假的成功。

## 检查

- Android UIA JVM、SDK Debug/Release AAR、Gradle 插件构建通过；根 Swift package arm64 编译通过；Web 单测与实际 Chrome 控件契约通过。
- 增补 WDA 后 Host 全套 1299 项：低并发运行 1298 项通过，唯一性能项为 10k 节点 p95 20.83975 ms 超过 20 ms；该原样性能测试单独运行 8/8 通过。并发 Xcode 构建时的超时失败保留，未放宽断言阈值。
- WDA 初始化失败、同设备原始结果恢复和不匹配拒绝等针对性测试 24 项通过。
- 实际 npm tarball 完成干净安装、native 编译和 CLI/MCP 共享 Runtime 验证。首次打包遗漏新 WDA 模块，被该验证发现并修正；以最终发布目录中的 report.json 与归档哈希为准。

## 业务和发布记录

本轮详细证据位于 Git 忽略目录 build/ai_app_bridge_artifacts/uia-035/。保留 SUMMARY.md、BUG_RECHECK.md、COVERAGE.md、ISSUES.md 及原回执、截图、录制和独立存储检查。原 grok-validation-034-20260914-150831 报告作为历史原件保留。

Reader 当前完整 JS 业务脚本已完成 23 个断言；其 SDK 升级安装后的版本复核单独记录。Kiwix 从手机上的 0.2.11 重建并安装至 0.3.5；原生与 WKWebView 连续业务脚本 script-1789376263916-1 完成 27 个断言，耗时 99.615 秒。旧示例在重启后假定自动显示书签列表，本版改为明确打开列表；数据库独立读取确认保存结果。

发行提交为 `e7253a1e52d841d73d6e5904c42eb43484753447`，tag `0.3.5` 与源分支已推送，main 已推进到发行提交，[正式 GitHub Release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.3.5) 已创建。npm CLI/Web 的 latest 与 next 均为 0.3.5；pub Flutter 与 JitPack SDK/插件均已发布并从公共渠道核对。公共 CLI tarball SHA-256 为 `c42138015fe7182cea7bc1bebe199a9be32c1739d4655f25502606c449ead0c4`，公共 Flutter archive 为 `2edb46cbc784e852b34a0de30957978e86ef8b891dff37e0011cf9736db54107`。

本机 CLI、全局依赖和新启动的 MCP 已升至 0.3.5；新 MCP 与 CLI 读取同一个 compatible Runtime。旧默认 Runtime 使用公开 stop 结束，未删锁。未声明既有 Codex MCP 连接已自动热升级。

## 后续业务结果

- NotallyX 已官方安装并实读 SDK 0.3.5，核心 7/7 通过；14 阶段、15 个数据库快照、59 个 UI 检查点、160 次 mutation。完整目录仍有 134 个 scenario、311 个 variant 未跑，总报告 ok=false 保留。
- Flexify 按公开 pub 0.3.5 构建并官方安装，live SDK 0.3.5；Script 完成 16 个断言，独立静止 SQLite 13 项和旧行保护 6 项通过，精确结果为 2 组、14 次、625 kg。两次 Flutter CLI 的 VM Service 转发失败均保留；使用该 Flutter 版本规定的 LLDB 初始化运行确切 App PID 后完成业务。启动准备不算 Script 时间，结束后停止本次 App 和调试器。
- Memos 注入 Web SDK 0.3.5，JS 15 个断言、Python 13 个断言通过；独立 SQLite 各 12 项检查通过，覆盖创建、编辑、取消删除和旧笔记保护。登录示例按实测 English UI 使用 Sign in。页面 checkbox 仍与保存的 `[x]` 内容有差异，任务勾选渲染不计通过。
- Reader 依赖文件已升级至公开 JitPack 0.3.5，Debug 构建通过。POS 依赖已升级至 0.3.5，SIT/UAT Debug 构建通过，未安装收银 App。两处消费项目原有业务修改未混入 Bridge 提交。
- Wikipedia 0.3.5 新 APK 已通过官方 Intent 安装与哈希验证；LocalSend 已解析公开 Flutter 0.3.5 并构建 APK。OnePlus 在 Wikipedia 安装后再次离线，Reader/LocalSend 新版安装和这三个 App 的新版 live SDK/后续业务仍待设备继续。不能用旧 SDK 业务结果替代。

Wikipedia 与 Android 组合控制器现在可接收显式冻结的 manifest/suite 路径，便于升级 APK 后保留旧样本历史；安装包哈希、脚本/校验器哈希、业务和时限检查均保留。Web remote-smoke 依赖已升级到公共 npm 0.3.5。

四份本地报告与 `release-status.json`、`consumer-versions.json` 已补齐。自然安装中途取消、未执行的静态风险专项和全部 115 条能力组合仍未验收，不能据本次发布标记全量跨平台独立通过。
