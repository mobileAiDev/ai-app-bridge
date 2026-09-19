# M5 最简 MCP 安装交付

实现提交 `b6a0bdb`。主包版本和文档打包清单随 M4 迁移提交；本报告记录的是
已包含这些迁移的 0.4.0 tarball 实测。未发布 npm、Git tag 或其他远端资源。

普通用户只需受支持的 Node 和一份固定版本 MCP 配置。FactStore 作为内嵌
Node-API 扩展随包交付，不需要独立服务、Python 或编译器。Python 仅用于
明确选择 Python 的 Script/extract。主包 Node 范围仍为 >=26.3.0 <27。

| 目标 | 实际测试环境 | native 测试 | 完整 tarball / npx / MCP |
| --- | --- | --- | --- |
| darwin-arm64 | 本机 macOS 27、Node 26.3.0 arm64 | 8/8 | 通过 |
| darwin-x64 | 同机 Rosetta、Node 26.3.0 x64 | 8/8 | 通过 |
| linux-arm64-glibc | Debian 12 ARM VM、glibc 2.36、Node 26.3.0 arm64 | 8/8 | 通过 |
| linux-x64-glibc | 同 VM 的 Rosetta、glibc 2.36、Node 26.3.0 x64 | 8/8 | 通过 |

二进制编译目标为 macOS 13.5 / Linux glibc 2.28、Node-API 8；没有冒称
在最老系统版本或物理 x64 主机实测。Windows、musl 不属于本次支持矩阵。
Linux 环境没有编译器；所有平台的安装和纯 MCP 路径进一步用拒绝执行的
Python/编译器入口验证。Python 功能回归在单独的正常环境运行。

四套完整验收均真实执行全新 tarball 安装、安装 lifecycle、预编译加载和
checksum、123 条命令发现、CLI/MCP 公共解析器、两语言 Script、归档及重启
恢复。额外的 npm exec 首次/再次启动使用独立 npm cache、只有 MCP 配置，
运行 JS Script、regex/JS extract、source ref 重读，并验证 MCP 断开不会
结束 Runtime。整个包测试使用受控 ADB，真机证据单列于 M4。

loader、install、Runtime 启动指纹和打包验证均使用同一选中 artifact。
缺文件、损坏 checksum、不支持平台显式失败，不回退到源码编译或其他存储。
开发者显式构建与四目标复现命令见 [PREBUILDS](../native/segmented-fact-store/PREBUILDS.md)。

独立 Standards 复核指出首次 npx 阶段失败时未停止本次 Runtime；已改为只有
首次阶段成功、准备复用时才保留。Spec 复核指出安装指南漏进主包 files；
M4 已补入，实际 tarball 和真实 Codex MCP 客户端均已读取当前合同。

四份报告的环境、路径、tarball/native checksum 和结果摘要见
[结构化证据](IMPROVEMENT_RELEASE_V1_M5_2026-09-19.json)。不同架构打包的压缩包
hash 可不同；macOS 两包逐文件内容 hash 已核对一致，不能把压缩包 hash 当作
跨环境源码指纹。最终候选包在 M4 放行报告指定。
