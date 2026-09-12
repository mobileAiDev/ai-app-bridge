# 0.3.0-rc.1 工程收尾与发布交接

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

## 维护者接下来的操作

1. 推送最终候选提交与 `0.3.0-rc.1` tag，检查 JitPack 的 SDK 和 Gradle 插件坐标可解析；SPM 取同一 tag。
2. CLI/Web 可发布 npm 候选 dist-tag（例如 `next`）；Flutter 在 Android 公开依赖可解析后发布。native store 随 CLI 分发，无须先发布单独 npm 包。
3. 从刚发布的确切版本做来源/入口检查，再按发布策略推进。此处尚未执行 Git push、远端 tag 或 npm/pub 发布。
4. 业务测试交接沿 [工程审查的固定清单](ENGINEERING_CLOSEOUT_REVIEW_2026-09-12.md#交给验收-agent-的范围)：Wikipedia 最新 Script 和新四 App 组合尚未完整执行；原 iOS/跨设备剩余场景保留。只回传 Bridge 的具体代码/能力缺陷，环境或样本问题记录后继续，避免拖回重复验收循环。

当前具备候选发布条件；完整业务矩阵未通过前，不把候选版本标成已完成正式生产验收。
