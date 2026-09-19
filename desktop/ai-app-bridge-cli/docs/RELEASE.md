# 0.4.0 改善版发行检查

源码版本、可发布验收、registry 发布和正在运行的客户端是四个不同状态。
本文件描述发行操作；源码中的版本号不代表 npm/JitPack/pub.dev 已发布。
当前实施与放行证据统一记录于仓库 `docs/IMPROVEMENT_RELEASE_V1_2026-09-18.md`
及各 M1–M5 交付记录。最终 A01–A16 对账未全通过前不宣称完整发布验收。

## 兼容与迁移

0.4.0 的外部 run 必填 `extract`，不提取显式 null；CLI `--extract null`。
返回公共封套含 execution/control/extraction/delivery，删除额外 `_history`、
`_meta` 副本。旧请求不自动补字段。业务 value 在 null 且预算内保持原值，
Script 的内部 ctx.call 仍返回 ok/result。Runtime 协议仍是 aab.runtime/v1。

调用方先核对 execution 和控制字段；提取失败后用原 source ref 调 response
read，不重放动作。详见 [公共提取合同与完整示例](RESPONSE_EXTRACTION.md)。
发现正文超预算时按 command/operation 收窄，不静默裁剪 schema。

## 发行资源

| 资源 | 源码版本 | 发行渠道 |
| --- | --- | --- |
| Desktop CLI/MCP | 0.4.0 | npm @mobileaidev/ai-app-bridge |
| 嵌入式 native store | 0.2.0 | 随主包 bundleDependencies，包括四个预编译 addon |
| Android SDK / Gradle plugin / executor modules | 0.4.0 | 同仓库 Git tag / JitPack |
| iOS Swift 包 | Git tag 0.4.0 | 根 Package.swift |
| Flutter SDK / test helper | 0.4.0 | pub.dev；Android 固定依赖同版 SDK |
| Web SDK | 0.4.0 | npm @mobileaidev/ai-app-bridge-web |

UIA bundle、WDA 14.1.1、iOS WDA 模板、Playwright helper 与三类范例随主包。
未改变代码的设备组件不需要仅为 Host 返回合同重新安装；需要测试新发行
设备产物时记录实际版本/包/序列号，不能用旧安装冒充新包验收。

## 发布前门禁

1. 固定审核提交，核对工作包和 A01–A16，保留失败与未验证项。完整 npm
   功能组与安静环境串行性能组通过，范例由文档读取实际执行。
2. 对 [Host 支持矩阵](INSTALLATION.md) 的四个 artifact 校验 checksum 和
   实际加载，运行 native tests 与全新 tarball 安装。正常安装和纯 MCP
   JS/regex 路径禁止调用本地编译器/Python；Python 回归使用单独环境。
3. 核对 npm pack 清单真实包含 addon、加载器、source read/worker 和文档，
   codeFingerprint 哈希实际选中的二进制。固定版本 npx 首次/重复启动、
   MCP 断连后 Runtime 存续、明确 stop/restart 与持久化恢复均有证据。
4. 核实实际 CLI 路径、MCP 启动版本/指纹、Runtime code/config/Node 身份，
   并检查受影响消费脚本的 extract/公共响应迁移。安装成功不替代入口更新。
5. Android/Swift/Flutter/Web 的发行清单和版本一致。需要时运行相应构建，
   真实设备证据和离线/受控 ADB 测试分开记录。三类实际任务对照保留来源、
   时间、目标和原始记录，不能将缺设备写成不适用。

## 对外发布顺序

在已授权的发布操作中，维护者先推送已验收提交和 0.4.0 tag，核实 JitPack
公开坐标成功解析，再发布依赖它们的 Flutter SDK/helper。Web npm 与主
CLI/MCP npm 分别发布，并核实 registry 实际返回的 tarball/checksum；设置
对应 dist-tag 和 GitHub Release。远端流水线成功与设备业务验收分别列明。
本地构建或 MavenLocal/path 替换不能证明公开坐标可安装。

客户端升级时退出旧 MCP 再重新连接。若是旧客户端碰到新 Runtime，先升
客户端；只有明确 Runtime 是待升级一侧时，在其任务结束后显式 stop。
同版本不同指纹只能说明构建或 Node 环境不一致，不能凭 hash 判断新旧。
