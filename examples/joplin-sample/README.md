# Joplin iOS 复杂业务样本

用于补齐 Bridge 的真实 H5 编辑提交、持久化结果与原生界面切换。采用[固定官方源码](source.json)，资源和 profile 配置位于 App 私有 Documents；实际数据库由 `react-native-sqlite-storage` 管理，须从真机确认文件位置，不能把资源目录当作数据库证明。预期通过 Intent 编辑并保存笔记，再由固定 Script 复跑，独立读取实际数据并验证重启后的内容。

2026-09-12 状态：暂停本样本接入，优先组合现有 App 的固定 Script，详见[当前顺序](../../docs/BRIDGE_NEXT_GATES_2026-09-08.md#2026-09-12-样本收敛与当前顺序)。保留当前准备结果，不继续重复签名尝试。

独立开发包已接入 Bridge，原始移动端资源、TypeScript、直接 CocoaPods 安装和未签名 iPhone arm64 构建均已完成。未签名构建退出码 0、耗时 266250 毫秒，记录为 `build/xcode-device-02-unsigned-result.json`；随后签名构建退出码 65，记录为 `build/xcode-device-03-sign-result.json`，尚未安装或取得本样本的真机业务验收。主 App 测试包不嵌入 ShareExtension，Debug 签名不请求 App Group 和远程推送权限。分享接收模块、编辑器、笔记和数据库实现保持上游代码，启动是否受权限限制仍须真机检查。分享扩展、远程推送与原 `joplin:` URL 不属于这个独立包的验收；不能把构建或 SDK 接通记为业务通过。

上游源码与构建产物放在被忽略的 `upstream/`、`build/`。源码来自 GitHub 固定提交归档。首次归档 SHA-256 和目标身份均记录在 `source.json`，重新下载的归档需先核对内容及来源。`ios-v13.7.5` 是已核对的官方 tag，不宣称为最新稳定发行版。

`integrate.rb` 校验固定原文件哈希后接入本地 SPM 包，设置独立 Debug 包名与 URL scheme，并从包内加载 JavaScript，支持后续脱离 Metro 的重启验证。接入只调整 AppDelegate 启动和构建组合，不修改上游业务代码。已存在接入报告时明确拒绝重复修改；前后哈希保存在 `build/integration.json`。

构建准备使用上游 `devbox.json` 指定的 Node 24.12.0 和仓库自带 Yarn 4.16.0。Node 官方归档已按 `SHASUMS256.txt` 核验，清单位于 `build/toolchain/manifest.json`。`upstream/.git` 是空的本地边界，用来防止构建工具读取父 Bridge 仓库或安装父仓库 hook；它不代表官方提交，源码身份以 `source.json` 为准。构建环境使用 `HUSKY=0`。

当前已执行的依赖安装为 `yarn install --immutable --mode=skip-build`，原 `yarn.lock` SHA-256 仍为 `d90b1157ff48ef93791259743d442a971f859fbe132b20c9bd1503894ce420b1`。随后只运行 `@joplin/app-mobile` 及递归工作区依赖的原始 `build`，不调用上游发布脚本。上游移动端 `podInstall.js` 会吞掉 Pod 安装错误，因此该 build 的退出码不能单独证明 iOS 依赖可用，必须另外确认 CocoaPods 和实际 Xcode 构建。

前序 Kiwix/freeCodeCamp 的 Run 按钮仍位于实际视口之外。2026-09-12 原生向上滑动后，可视高度由 830 增至 860，Run 的 top 仍为 913.984375；该旧缺口保持未通过。本样本新增业务证据不能改写 Kiwix 课程的原结论。
