# 0.3.7 发布与项目更新记录

0.3.7 修复 Android Host 解析前台窗口时受焦点记录顺序影响的问题。K2 的“有效窗口 → null”和 YIC 的“null → 有效窗口”现在使用相同规则处理。行为修改仅位于 Host 解析器，其他 SDK 同步发行版本。

发行提交为 `b5ea61efe671c64b69111ea361ac5c8fbbee70e3`，不可变 tag 为 `0.3.7`。[GitHub 正式发布页](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.3.7)已公开。示例依赖及本记录通过后续提交更新，不移动发行 tag。

## 修复范围

- 读取全部焦点记录，跳过 `null`，保留既有焦点字段的优先级。
- 只有一个有效窗口时直接使用；多个有效窗口通过系统 `mTopFocusedDisplayId` 选择。
- 系统信息仍不能唯一确定窗口时，解析器返回 `foreground_ambiguous` 和候选窗口信息，不任意选择第一条记录。
- 包名匹配、窗口身份、控件有效性和操作派发检查继续使用既有路径。

本次没有增加多屏操作路由，也没有按动作拆分焦点校验。

## 公共渠道核验

| 渠道 | 结果 |
| --- | --- |
| npm CLI/MCP、Web SDK | 两个包的 `latest`、`next` 均为 0.3.7。重新下载的两个 tarball 与本地已验证包逐字节一致。 |
| JitPack | 0.3.7 构建状态 `ok`，提交匹配发行提交。Android SDK、Gradle 插件、六个可选测试模块及两个插件 marker 均可用；16 个公开 POM/二进制文件下载及依赖坐标检查通过。 |
| pub.dev | `ai_app_bridge_flutter`、`ai_app_bridge_test` 的公开最新版本均为 0.3.7；下载归档分别有 56、6 个源文件与发行源码一致。 |
| Swift Package | Git tag 0.3.7；使用干净源码副本完成根 Swift Package 的 iOS Simulator SDK 编译。 |

公共归档 SHA-256：

| 包 | SHA-256 |
| --- | --- |
| npm CLI | `8f285d57d26d04b06dacdb88c00954faf2790aa679980c09de572521388790fe` |
| npm Web | `635941f7861a20898b42d72ad54ea621a8e1f32d807810fea4e00782eb0b97c3` |
| Flutter SDK | `92afc51f8d8a712f05d15364d35e28b55cd22b81110f3506c2670cc33685efc4` |
| Flutter test helper | `69e1f55aa7af6f8e51e2581b4dadc2306a5e09b29f93ef9d167c5c03d2d7a44a` |

## 检查与真机结果

新增 15 项回归测试覆盖空记录在前、记录及显示区域顺序变化、系统焦点屏幕选择、多个有效窗口歧义、重复记录和包名校验。修复前 13 项失败；修复后新增测试与相关 CLI/Intent 测试合计 85 项通过。完整 CLI 检查 1328 项通过。

其他发行检查：Android 全模块 build/lint/Maven 本地发布检查通过；Flutter SDK 66 项测试和 analyze 通过；Flutter test helper analyze 通过，该包没有独立 test 目录；Web SDK 23 项测试及构建检查通过；根 Swift Package 的 iOS Simulator 编译通过。实际 npm tarball 的干净安装、native 编译、121 条命令和 CLI/MCP 共享 Runtime 合同验证通过。

| 真机 | 本轮验证 |
| --- | --- |
| K2 Mini / Android API 25 | 点按进入主页并返回收银台；输入 `bridge037` 后用新树与截图确认，再清空输入；启动核验返回正确前台包。 |
| YIC-R68P / Android API 30 | 相同步骤通过；原来首条焦点为 null 的 dump 不再误报。发布后当前 MCP 连接再次成功抓取 YIC 前台截图。 |

两台设备均核对了操作前后的购物车条目未变化，测试结束时设备占用均为空。验证使用 Host 0.3.7 和设备上已有的 SDK 0.3.6，业务 App 未重装，证明这次修复可由 Host 升级生效。具体设备标识、包名、原始 dump、操作回执、树、截图与版本信息保留在本地证据中。

两台实机本轮均只有一个有效焦点窗口；多个有效窗口的选择与歧义分支由自动化测试覆盖。结果不代表完成支付、打印、扫码或多屏交互的业务验收。

## 本机 CLI 与 MCP

全局 CLI 已从公开 npm 安装为 0.3.7。新启动 MCP 的 `serverInfo.version` 为 0.3.7；当前 Codex 对话的实际 MCP 连接也与共享 Runtime `compatible:true`。

两者代码身份均为 `ae55592b1a9461edf3b9e6f85de09a11cdf8c545e543ff3a993f2ea4973d0e53`。Codex/Cursor 配置继续引用全局安装路径；本机验证环境为 Node 26.3.0。旧 Runtime 已停止，新 Runtime 保持运行。

## 同批项目更新

沿用 0.3.6 发布时的接入范围，以下项目的 Bridge 依赖从 0.3.6 更新为 0.3.7。

| 项目 | 本轮验证 |
| --- | --- |
| POS | SDK/插件共用版本更新；SIT、UAT Debug 构建通过。 |
| Reader | SDK、Gradle 插件更新；Debug 构建通过。 |
| MeasureDevice / measure-assist-android | SDK 更新；Debug 构建通过。 |
| MeasureDevice / protocol-lab-android | SDK 更新；Debug 构建通过。 |
| game-mirror-mapper | SDK 更新；Debug 构建通过。 |
| Legado | SDK 更新；AppDebug 构建通过。沿用原 GradleWrapperMain 入口处理现有 wrapper 的 CRLF，未修改 wrapper。 |
| vivo-site | 公开 npm 依赖及 lock 更新；npm check、Vite 构建通过，生产产物 Bridge 引用数为零。 |
| Web remote-smoke | 公开 npm 依赖及 lock 更新；安装及 check 通过。 |
| LocalSend 示例 | 公开 Flutter SDK 依赖及 workspace lock 更新；使用现有 Flutter 3.41.9 和 Rust 工具链构建 Android Debug APK 通过。 |
| Flexify 示例 | 公开 Flutter SDK 依赖及 lock 更新；iOS Debug 无签名构建通过。 |
| NotallyX 示例 | 源码依赖跟随当前 SDK；Android Debug 构建通过。 |
| Kiwix 示例 | 源码依赖跟随当前 iOS SDK；iOS 无签名构建通过。 |

LocalSend 最初缺少 Rust 的 PATH 环境，使用项目已有工具链后构建成功；Flexify 沿用上版验证方式，以单次 `IPHONEOS_DEPLOYMENT_TARGET=15.0` 构建参数适配本机 Xcode，未修改项目最低系统版本声明。

LocalSend 的上述构建完成后，并行工作加入了本地测试 helper 和相应测试依赖；这些变动原样保留，不属于本次版本升级或构建结论。

本轮接入修改只同步 Bridge 依赖，保留外部项目原有的业务改动与并行产生的测试改动，没有为这些项目创建 Git 提交。Courier、PDA 继续排除，Novel 继续暂缓。其他直接引用本仓库源码或本地 AAR 的示例继承当前版本，本轮未逐个构建其业务 App。

消费 App 已更新依赖并完成上述构建，本次未安装这些新业务 APK/IPA，也未部署 vivo-site。

## 本地证据

Git 忽略目录 `build/foreground-parser-0.3.7/` 包含修复前后测试日志、两台实机原始记录、树、截图和 `report.json`。

Git 忽略目录 `build/release-0.3.7/` 包含公共包完整性报告、JitPack 报告、CLI 实包验证报告、当前与新启动 MCP 的身份核验、依赖修改前后清单、构建日志和最终渠道状态。首次失败日志保留；LocalSend 最终通过日志为 `localsend-build-rust-final.log`，根 Swift Package 最终通过日志为 `swift-root-clean-build.log`。
