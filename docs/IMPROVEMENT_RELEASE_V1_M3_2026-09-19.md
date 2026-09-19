# M3 交付及 M2 独立审核修复 — 2026-09-19

基线：`1018b60`。M3 实现完成；整体发布验收继续由 M4/M5 收口。

- Script JS/Python 异常保留类型、原始源码文件/位置、最多 20 帧且 8 KiB 的 stack、最近 8 KiB stderr 及截断标记；成功路径不交付日志。终态复用既有 checkpoint，重建 supervisor 后仍可读取。
- CLI/MCP 启动时固定版本、Node/ABI、代码指纹；不等首次请求才读盘。错误列出两侧身份；版本较低侧明确指出，同版本不同指纹不猜旧侧，不自动重启 Runtime。
- Android prepare 在 Gradle finalizeDsl 读取实际配置，按已选择 UI Automator 2.4.0 / Compose 1.8.3 的已知 AAR 要求检查 compileSdk 34 / 35 与 AGP 8.1.1。报告模块、variant、JDK/Gradle/AGP、实际/要求值和本次临时构建影响；不改消费者源文件或提升 compileSdk。没有增加兼容求解器或独立测试模块。
- Python 版本探测与语法预检均有 5 秒上限和 SIGKILL；异常退出、超时、spawn 失败清理本次 Script 目录。

## 审核修复

对固定 `828b1e5..1018b60` 分别执行 Standards / Spec 审核，确认并修复：

1. 合法调用方预算在业务参数校验失败前先保存。Host、MCP、真实 CLI 的 16 KiB 错误正文均受限，设备调用为 0。
2. 提取器等待主工作进程 exit 并关闭本端管道。用户脚本另起进程继承管道时，不能拖延主提取的返回或占用名额；不承诺进程树沙箱。
3. Python 版本探测不再无期限同步等待。忽略 TERM 的测试解释器仍被期限终止。

## 验证

- 8 个定向文件共 **67 passed / 0 failed**，包含两语言诊断/异常/源码定位、长日志/栈、终态恢复、spawn 失败清理、进程启动身份、CLI/MCP 预算、真实提取并发与管道反例、Runtime 入口和准备失败。
- 真实 Gradle 8.9 / AGP 8.7.0 / JDK 17.0.20，临时 Android 项目：compileSdk 33 在配置阶段拒绝；同项目 34 配置阶段通过。执行任务为 help，未构建或安装 APK。保留的[结构化报告](IMPROVEMENT_RELEASE_V1_M3_PREFLIGHT_2026-09-19.json)展示实际配置与影响范围。
- 日志：`/tmp/aab-m3-final.log`、`/tmp/aab-m3-gradle-preflight/gradle.log`、`/tmp/aab-m3-gradle-preflight/compatible.log`。
- 全套、最终 tarball、跨平台免编译安装和真机对照尚不计为通过，进入 M4/M5。
