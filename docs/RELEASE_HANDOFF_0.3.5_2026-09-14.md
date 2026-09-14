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

发布顺序为冻结提交/tag、验证 JitPack Android SDK/插件、npm CLI/Web、pub Flutter，再从公开渠道升级消费项目与本机。发布成功回执和消费项目构建/安装记录将在本目录补齐；在回执齐全前不得把准备完成记为已发布。
