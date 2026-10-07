# 0.4.4 发布与本机升级进度

冻结发行提交：`20a8c19780e7dcd5223bc3c44ade94a6f1a36a88`。
新 tag、main 和工作分支已正常快进推送；旧 tag 保留。

## 修复及放行证据

WindowManager 多行 `mAttrs` 将完整 `ty` 类型放在行尾时，0.4.3 会误报
`foreground_window_type_missing`。0.4.4 只为完整类型增加行尾边界，保留实际
owner/package/UID、Activity、进程及窗口生命周期核验和点击前守卫。

- 旧生产解析器加新回归先失败，修正后相关 109 项通过。
- 主仓库完整 Host 功能 1,402 项、串行性能 50 项通过。首轮完整功能回归
  有一项既有 iOS 取消测试失败，原日志保留；该文件独立 30 项及随后完整
  1,402 项重跑均通过，未为重跑修改该测试或 iOS 生产逻辑。
- Android build/lint/test 通过：SDK Debug/Release 各 194 项、plugin 8 项、
  UIA 47 项；UIA 归档及其源码 hash 一致。Swift iPhoneOS 无签名构建通过。
- Flutter 两包分析通过，SDK 66 项测试通过，helper 无 test 目录；两包
  在提交后发布 dry-run 均零警告。Web 23 项及构建通过。
- 最终 CLI 归档在仓库外安装、MCP/Script/提取/取消/持久结果/native prebuild
  及 npx 首次和重复启动验证通过。CLI 198 文件、Web 6 文件逐一匹配冻结提交。
- 已核对原真机 dump、同补丁源码和正式动作回执/截图：嘀嗒分身地图首页
  及“消息”“我的”登录入口响应通过；不声明账号登录或完整 App 验收。
  鲨鱼记账初始化退出仍属于 Duo 单独诊断。

## 公开渠道

| 渠道 | 0.4.4 当前状态 |
| --- | --- |
| GitHub tag / Release / iOS Swift tag 源码 | 已发布，tag 对应冻结提交 |
| Android SDK / Gradle plugin / 六执行器 | JitPack 首次构建成功；8 模块的 16 个公开 POM/二进制核验通过 |
| Flutter SDK / test helper | 已发布；公开归档分别 56 / 6 文件匹配冻结提交 |
| npm CLI/MCP / Web SDK | 待本次发布的安全密钥验证；尚未发布 0.4.4，latest/next 未升级 |

npm 登录已有效，但本次 publish 要求安全密钥/Touch ID。Mac 已锁屏，自动
解锁失败；两次发布认证等待超时，未把认证 URL、OTP 或凭据写入发行证据。
先由用户解锁，再重新弹出当前 publish 验证页。无需再次 npm login。
之后发布已受检的两个 npm 归档，升级 latest/next 并下载核对完整性。

## 本机与消费依赖

全局 CLI/MCP 已从冻结受检归档升级为 0.4.4，198 文件匹配归档。四个活动
Runtime 均已升级为 0.4.4 且 compatible=true：默认、独立真机、模拟器和
EOL 候选事实目录。它们均使用全局包，原 provider 配置 fingerprint、事实
目录及 profile 保留。内部 native store 保持 0.2.0。

新全局 MCP 的六项实际调用通过：null、regex、JavaScript/Python 提取、
预期提取失败和 Script runtime-status。此证据基于冻结受检候选归档，不能
代替尚未完成的 npm 公开下载核验。

旧 Codex Bridge stdio 客户端已关闭以重新加载新版；Codex 未自动重建连接，
当前原工具调用返回 `Transport closed`，需应用内重连 Bridge 或重启 Codex。
Runtime 不受此客户端关闭影响，新版 CLI 可继续调用。

“接续分身兼容性回归”已获通知，继续使用全局新版或保留候选事实目录的
新 launcher；原 0.4.3 候选源码与真机证据保留。remote-smoke 的精确 Web
依赖暂仍为已公开的 0.4.3，待 npm Web 0.4.4 公开后更新依赖、锁文件及验证。

## 外置证据与后续收口

证据目录：`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.4-2026-10-07`。
关键报告：`component-validation-report.json`、`candidate-matches-frozen-source.json`、
`device-evidence-review.json`、`package-release-verified/report.json`，以及
`publication/report.json`、`publication/version-matrix-final.json`、
`publication/jitpack/report.json`、`publication/runtime-upgrade-results.json`、
`publication/candidate-mcp/report.json`、`publication/connected-mcp-reload-result.json`。

完成 npm 后再运行公开包完整性检查和 `publication/global-mcp/verify.cjs`，
更新 remote-smoke、复核当前 MCP 重连及各渠道 latest/next，最后更新本页和
总报告。公开校验始终显式指定冻结提交，不以此后文档提交替代发行提交。
