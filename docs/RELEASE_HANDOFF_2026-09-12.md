# 工程收尾与发布交接

## 0.3.2：保留失败记录后重建

用户指定统一升级到 `0.3.2`，保留 0.3.1 的失败记录并以新版本重新构建。0.3.2 相对 0.3.1 仅调整各端版本、固定依赖与发行说明，按需发现和 skill 实现不变。

0.3.1 的 npm CLI/Web 已发布；Android JitPack 首轮 185 项 Release JVM 检查中的 184 项通过，`G8RecordOverheadBenchTest` 的 p95 ≤ 1 ms 断言失败，日志保存在 `publish-031-20260912-01/jitpack/first-build-failed.log`。同一源码单项本机复核通过，四种 record 的 p95 为 0.061542 / 0.144166 / 0.059209 / 0.026459 ms；该复核不能替代远端构建。阈值和执行实现均保留。

0.3.2 先完成 Android 公开构建，再发布其余渠道。新产物与实际查询记录放在 `build/ai_app_bridge_artifacts/publish-032-20260912-01/`。0.3.1 的证据、Git tag 和 npm 包保持原样；Flutter 0.3.1 未发布。以下按需说明与 Reader 验证结果继续适用于本补丁。

## 0.3.1：按需说明与 Reader 接入

本轮按用户要求统一 CLI、Android SDK/插件、iOS、Flutter、Web 为 `0.3.1`。核心改动是 CLI/MCP 精简命令目录、按 operation/platform/provider/action 读取合同，以及随包 skill 的按需文档指引。SDK 执行行为沿用 0.3.0，仅同步版本与固定依赖；中文 README 的旧 rc.1 接入示例也已更新。

Reader 使用公开 0.3.0 Android SDK/插件构建安装后，完成实际正文、目录、设置、返回书架和章节恢复的 Intent 验证；由观察形成的 Script 完成 42 次 Host 调用、22 项设备断言，终态耗时 19.005 秒，持久结果可读取。Native 点击关联的手机事件查询为 committed、gap=false。首次脚本的菜单状态错误和早前书源/前台中断记录保留，不归入成功。范围是这条已观察业务流程，并非 Reader 全 App 回归。

本机 `evidence-driven-qa` 缩为 20 行；本轮 Reader 未使用该 skill。`ai-app-bridge-use` 的本机、仓库与 npm 随包版本对齐，保留关键合同，细节按需查询。完整检查首轮 1264 项中的 1263 项通过；一处版本断言仍写死 rc.1，改为核对 CLI/Android 实际版本一致后，受影响 87 项全部通过。

打包、协议与公开发布记录统一保存于 `build/ai_app_bridge_artifacts/publish-031-20260912-01/`；外部发布成功以该目录的实际查询结果为准。Reader 原始记录位于其仓库 `build/ai_app_bridge_artifacts/reader-bridge-030/`。本次不重启既定全平台验收矩阵，原未完成范围继续保留。

## 正式版 0.3.0 与默认入口

用户已明确要求所有默认入口切换到新版。正式版 **`0.3.0`** 继承已发布并验证的 rc.3 实现；各端版本、Android 固定依赖和安装示例同步，Android/iOS SDK 自报版本也统一为 0.3.0。GitHub `main`、正式 Release、npm `latest`/`next` 和 pub.dev 稳定版均使用该版本。历史 rc tag、npm 包、构建与验收记录保持不可变。

本次不改变执行逻辑、不重开设备业务回归。源码/包差异、JitPack 构建、公开 npm/pub 包、默认分支与安装入口的实际核验记录保存在 `build/ai_app_bridge_artifacts/publish-stable-20260912-01/`。正式发行标签不改变原有业务验收结论，未完成场景仍沿固定清单交接。

## rc.3 发布更新

当前统一发行候选为 **`0.3.0-rc.3`**。[JitPack 的 rc.2 构建](https://jitpack.io/com/github/mobileAiDev/ai-app-bridge/0.3.0-rc.2/build.log)通过 G8 后，Lint 发现 `LocalServerSocket.use` 的隐式 `Closeable` 转换要求 API 28，而 SDK 保留 minSdk 19。rc.3 改用 `try/finally`：服务继续在 `try` 中接收连接，仅在循环退出或异常时关闭 socket，保持原有资源生命周期。版本和依赖同步为 rc.3。

本机完整 `clean build publishToMavenLocal` 通过（1 分 31 秒、100 个任务），包含 Android Debug/Release 各 185 项和插件 6 项检查。为兼容本机已安装 SDK 37，仅本次命令指定 Lint 9.3.2；没有改写仓库 Lint 配置、提高 minSdk 或屏蔽诊断。发布后的 JitPack 仍按仓库原配置独立构建。相关包、构建和远端验证记录位于 `build/ai_app_bridge_artifacts/publish-20260912-03/`。

以下 rc.2/rc.1 为原始发布尝试记录，其 tag 和已发布 npm 包保持不可变。当前接入统一使用[发行说明](../desktop/ai-app-bridge-cli/docs/RELEASE.md)中的 rc.3 坐标，原业务验收边界不变。

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
