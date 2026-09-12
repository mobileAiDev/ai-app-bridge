# 0.3.0 候选工程收尾与发布交接

## rc.2 发布更新

当前统一发行候选为 **`0.3.0-rc.2`**。首次实际发布已推送 `0.3.0-rc.1` tag，并将 CLI `0.3.0-rc.1` 发布到 npm `next`；从 registry 下载的包与本文最终 `d2ab5888…` 包完全相同。

[JitPack 的 rc.1 构建](https://jitpack.io/com/github/mobileAiDev/ai-app-bridge/0.3.0-rc.1/build.log)在 185 项 Release JVM 测试中发现一个未迁移的旧断言：`G8StressBenchTest` 对纯内存 `MobileCaptureStore()` 仍期望 `partial`，但当前合同明确返回 `unavailable`、`committed=false`。rc.2 修正此断言并保留全部容量、数量与堆增长检查，补充 gap 和无持久引用检查；各端版本、Android 固定依赖及公开安装示例同步为 rc.2。执行实现保持原有行为，Android 自报版本更新。

rc.2 定向 Android Release JVM 检查及 Gradle 插件检查通过；具体计数见 `jvm-checks.json`。本机完整 `clean build` 被旧 Lint 解析已安装 SDK 37 的 `37.0` 格式阻断，远端完整构建须由新 tag 的 JitPack 日志确认。CLI 包与已发布 rc.1 逐文件比较，仅版本清单、README、发行说明改变，157 个包文件中的执行/SDK 文件完全一致。

rc.1 的公开 tag 和 npm 包保持不可变。以下是 rc.1 工程收尾的原始证据；rc.2 的发布构建、包差异与远端查询记录放在 `build/ai_app_bridge_artifacts/publish-20260912-02/`。原有未完成业务验收范围不变。后续发布与接入采用[当前发行说明](../desktop/ai-app-bridge-cli/docs/RELEASE.md)中的 rc.2 坐标。

## rc.1 原始工程收尾记录

工程开发可以收尾，当前候选版本为 **0.3.0-rc.1**。E1–E5 的代码、依赖接入和公开说明已处理；后续执行既定业务验收，发现具体 Bridge 缺陷再回到开发，不继续扩展 App 或重复未受影响的矩阵。候选发布与正式生产验收分别记录。

## 本轮完成的修改

| 项目 | 最终行为 |
| --- | --- |
| E1 Script 最终结果 | 独立持久化结果及大小/哈希，再写终态引用；`script operation=result` 按 operationId 读取。结果不再塞进进度事件，内部完成 Promise 也只保留小回执。写失败、终态写入导致结果淘汰或校验失败不能报告完成。默认 1 MiB，策略最多 64 MiB，仍受实际存储容量限制；JS/Python 使用一致的 UTF-8 JSON 容量语义。 |
| E2 Flutter H5 | 绑定 runtime、adapter 注册实例、document 和 element；多候选拒绝隐式选择，注销重建/导航后的旧引用失效。观察使用独立调用 ID，最终动作保留原 Host actionId；仍走统一回执与取消合同。旧 JS 拼接 helper 和其专属测试已删除。 |
| E3 Intent 动作 | 预算 allowlist 直接派生动作 schema，包含已实现的 pressKey/setOrientation，避免公开许可与执行端漂移。 |
| E4 发布接入 | 根 SPM 补齐两个 C targets；Android SDK/Gradle 插件/Flutter/CLI/Web 使用同一候选版本。native store 保持 bundled 0.1.0。CLI 声明 Node >=26.3.0 <27，本机验证版本 26.3.0。 |
| E5 清理与说明 | 旧 FactCache 移到 test-support；有生产职责的 target-execution 保留。README、合同、双份技能、Script/证据说明已同步。24 个样本/验证控制器使用公开结果读取入口，业务断言保留。 |

调用方需要迁移两处：从 `script_completed.result` 改为独立 `script result`；Flutter H5 adapter 注册提供真实 `isVisible`，交互使用 typed selector/expectedTarget，专家 eval 提供 expectedPage。详细命令和发布顺序见 [发行说明](../desktop/ai-app-bridge-cli/docs/RELEASE.md)、[Script 合同](../desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md)。

## 本轮检查与证据

- CLI 全量代码检查执行 **1257 项**，首轮 1254 通过。两个过期测试夹具已修正：UIA 重名节点在原始 XML 中构造后统一生成引用；checkpoint 延迟写夹具提供完整持久读接口。第三项为并行负载下 10k 节点 p95 20.490 ms，保持原 20 ms 阈值单独复核通过。三个相关文件最终 **31/31 通过**，原首轮失败日志保留。没有把首轮记录改成全绿。
- E1 最终专项 **10/10**，包括 JS/Python 2 MiB 结果、真实 native mmap 重开、归档离线核验、默认大小边界、脱敏哈希、写失败及终态写入淘汰结果；内部调用方迁移 **52/52**。
- E2 Host/renderer/Script 检查 **13/13**，Flutter 目标与生命周期 **19/19**，定向 Dart analyze 及四份生成产物一致性通过；E3 **8/8**。FactCache 迁移相关 **79/79**。双份技能校验和 33 处本地文档链接通过。
- 干净 npm tarball 安装与执行验证通过，实际编译 bundled native store，公开 115 个命令；验证 CLI/MCP 共用 Runtime、断开重连、执行/权限/关闭合同。停止 Runtime 后，两个明确不同的 runtimeId 之间读取到同一 Script 结果与 resultRef。使用受控 ADB，没有执行真机业务回归。
- 根 SPM 的等字节隔离副本完成一次关闭签名的 iOS Simulator 编译/链接，三个 targets、arm64/x86_64 均成功，27 个源文件无漂移。当前 Xcode 的最低构建目标为 iOS 15，此次不能证明声明的 iOS 13 兼容性；没有声称远端 tag 或消费方 App 已验证。
- Android SDK AAR、Gradle 插件 JAR 和插件 marker 成功发布到隔离的本地 Maven 目录；POM/module、产物大小/哈希、版本和 Flutter 固定依赖一致，98 个源码输入无漂移。没有执行远端发布。

本机证据目录均受 Git 忽略：

| 内容 | 相对仓库根路径 |
| --- | --- |
| CLI 全量首轮 / 三个失败文件复核 | `build/ai_app_bridge_artifacts/engineering-closeout-cli-check.log` / `engineering-closeout-failed-checks.log` |
| 最终干净包与源码绑定 | `build/ai_app_bridge_artifacts/release-package-20260912-02/`：`report.json`、`packed-source-manifest.json`、`source-binding.json` |
| E1 最终专项 | `build/ai_app_bridge_artifacts/engineering-e1-final.log` |
| Flutter H5 | `build/ai_app_bridge_artifacts/flutter-h5-closeout-20260912-01/` |
| Android 发行产物 | `build/ai_app_bridge_artifacts/engineering-android-release/report.json`、`SHA256SUMS` |
| 根 SPM | `build/ai_app_bridge_artifacts/engineering-root-spm/verification-summary.json` |

已验证 CLI tarball SHA-256：`e4b1808541bdd42233fd14af14c0216bb84e90bb2a37791540079feac231ac59`。包内 157 个文件的树哈希为 `e77b514805024863e6b1316f5aa7d522ff1b78bdec64cbf7d4dad08de3d49dfa`；逐文件清单在上述证据目录。验证时旧 HEAD 为 `4da58fa`，候选包含其上的工程修改，应以最终提交及文件哈希关联包，不能用旧 HEAD 单独证明来源。

## 最终发布入口补录

从干净的 `git archive 2a9b4cc` 导出源码执行 `npm ci`，native store 实际编译成功；随后 `npm pack` 得到与上述完整验证完全相同的 `e4b18085…` tarball（157 个文件）。这证明包不依赖未提交的工作树文件。Android/Flutter/SPM 所需源码、wrapper 和测试 fixtures 的 tracked 状态及 JitPack 任务图也已核对；远端 JitPack 构建仍在维护者推送 tag 后确认。

按用户要求进一步核对 MCP 内置帮助，仅补齐 WDA 的 device/Runner/session 参数说明、Script 最终结果读取和运行时维护说明。最终 CLI tarball SHA-256 为 **`d2ab588806d65a15c31dd78a364a6fe125cc50194096a19341761d4ed8660b54`**。与完整验证包逐文件比较，只有 `bin/command-discovery.js` 和 `bin/mcp-server.js` 的帮助字符串变化；命令 schema、执行代码和 SDK 产物不变。实际解包后的 MCP initialize、两工具发现、115 个命令及 Script result/WDA 必填参数检查通过，没有启动 Runtime 或设备。证据在 `build/ai_app_bridge_artifacts/final-mcp-guidance-20260912-01/`。

最终 Flutter pub 发布预检在干净 Git 状态下 exit 0、**0 warnings**，Web SDK **22/22** 测试通过。日志分别在 `build/ai_app_bridge_artifacts/engineering-flutter-pub-final/` 和 `engineering-web-sdk-tests.log`。这次文字补录不改变 Flutter/Web/Android/iOS 的源码与已验证产物。

## 维护者接下来的操作

1. 推送最终候选提交与 `0.3.0-rc.1` tag，检查 JitPack 的 SDK 和 Gradle 插件坐标可解析；SPM 取同一 tag。
2. CLI/Web 可发布 npm 候选 dist-tag（例如 `next`）；Flutter 在 Android 公开依赖可解析后发布。native store 随 CLI 分发，无须先发布单独 npm 包。
3. 从刚发布的确切版本做来源/入口检查，再按发布策略推进。此处尚未执行 Git push、远端 tag 或 npm/pub 发布。
4. 业务测试交接沿 [工程审查的固定清单](ENGINEERING_CLOSEOUT_REVIEW_2026-09-12.md#交给验收-agent-的范围)：Wikipedia 最新 Script 和新四 App 组合尚未完整执行；原 iOS/跨设备剩余场景保留。只回传 Bridge 的具体代码/能力缺陷，环境或样本问题记录后继续，避免拖回重复验收循环。

当前具备候选发布条件；完整业务矩阵未通过前，不把候选版本标成已完成正式生产验收。
