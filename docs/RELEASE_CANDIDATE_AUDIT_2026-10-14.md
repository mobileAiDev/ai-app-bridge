# 0.4.9 发布候选审查与最终包验收

2026-10-14。最终安装包验收完成；公开发布与消费者升级尚未执行。
公开 Host 基线为 0.4.8（tag 对应 `ddf95d1e578a094f3b6c9aa4fcd80bbfc75ff9d2`），
候选基于 `87af91f44cf0070686c6bd3e3e695ef2423d6702`。本文取代本文件此前的
“修复和产品化进行中”状态，不改写历史实验的失败或推算。

## 结论与采纳边界

四项 Host 优化已从实验开关改成正式选项和普通默认行为。最终 npm 归档在仓库外
安装、在无私有实验变量的环境中连续执行，六组配对均更快，十二次业务账本均正确。
本轮可以交付这些收益和下表修复，不承诺一分钟穷尽陌生大型 App，也不把准备好的
脚本执行时间等同于模型首次编写时间。

| 采纳项 | 正式行为与保留的选择权 | 实际证据 |
|---|---|---|
| Android SDK 传输 | `sdkTransport:auto/direct/forward`；确认的原生 adb 可直接连接 ADB server，包装 adb 与显式端口保留 forward；变更不因失败自动换路重放 | 最终六次候选均报告 direct；包装器、server namespace、端点变化反例及全量回归 |
| 不可变能力复用 | 按实际路由和 runtime epoch 复用 schema；不缓存页面、焦点、坐标来冒充新观察 | 同业务源 A/B、端点/epoch 回归 |
| 参考前台信息 | 普通 auto 不采集仅作参考的前台信息，明确标注 notCollected；window/full 可显式要求 | 默认包流程；显式反馈回归 |
| 截图归属 | 默认轻量窗口查询，可显式要求完整 ownership；仍返回实际设备截图 | Native/H5/Flutter 截图与业务账本核验 |
| UIA 隐藏节点预算 | compact 默认筛选可见节点后才截断；可显式 `visibleOnly:false`，原 XML 保留；部分可见负坐标不误删 | 650 个隐藏节点挡住当前页面的反例、两类 XML、最终无 SDK App 流程 |
| UIA 焦点事实 | 设备观察输出 focusable/focused/selected；缺字段保持未知，不伪造 false；不改节点身份、binding 或 journal schema | 先红后绿、更新 JAR、NotallyX 输入精确核验、165 条终态回执后的正常重启 |
| 观察完整性 | Script/Intent 保留部分、未知和来源错误；iOS Flutter 不把一个源失败改写成整体成功 | 定向反例及 Host 全量；iOS 真正运行时覆盖仍受限 |
| 恢复与原路由 | 原始 Script spec 恢复；Flutter 复用 observedTree 时先持久化原路由；force-stop 按原 adb/server/serial 分组 | 独立审查复现的两处 P1 已修复，原动作查询/取消/强制关闭测试，三处真实 SIGKILL |
| HTTP 错误与提示 | Android 有界读取与严格 framing；明确未派发的已知拒绝保留原错误和简短提示，不变成 unknown/cancel；不把其他网络错误当未派发 | SDK framing 单测、Host 13 项边界与恢复用例、44 项相关串行回归、干净安装包 |
| 其他必要修复 | URL 原始字节保留、Flutter 部分观察、Web 找不到元素的观察/等待提示、样例改用设备时间/游标 | 各定向反例和完整回归 |

持久化 group commit、UIA 连接缓存、设备端版本化 UI 镜像、默认增量、录屏替代截图、
模拟器控制台截图和通用应用空闲判定未吸收为本次交付能力。原因和后续实验要求保留在
[逐项方案审查](OPTIMIZATION_PROPOSAL_REVIEW_2026-10-13.md)、
[追评审查](OPTIMIZATION_FOLLOWUP_REVIEW_2026-10-14.md) 和
[动态测试 App 实验](MEITUAN_SCALE_OPTIMIZATION_VALIDATION_2026-10-14.md)。
不以微基准或估计代替复杂流程收益，也不为凑版本引入未成熟的协议重写。

## 同一动态测试 App 的最终对照

设备为本轮自有 `emulator-5594`，Android API 36 ARM64，2 核/2 GiB。所有运行前后
锁屏位为 false，本轮测速期间由 `caffeinate -di` 防休眠；未用 K2 收银机。
两侧运行相同 APK（内含候选 Android/Flutter SDK）、相同业务脚本及后端，只有 Host
从公开 0.4.8 换成最终安装的 0.4.9，因此数字衡量 Host 收益，不是全部旧 SDK 与新 SDK
的总对照。App/SDK 已运行；不包含 APK 安装、首次冷启动或脚本编写时间。

三组 seed 实际选择了不同商家商品：正新鸡排汉堡、蜜雪冰城饮品、华莱士套餐。
两个延迟场景各使用这三种 seed 配对，基线与候选的先后顺序交替；每个场景每侧
各三次，共十二次。流程包含进入首页、按当前列表选商品、账号 OTP 决策交还、购物车、
创建待支付订单、H5 共享登录/空购物车、返回首页与 Flutter 酒店查询。
180 ms 组额外故意丢失创建订单响应，随后只查询原订单。未发起支付请求。

| 服务端情形 | 0.4.8 总时长中位数（范围） | 0.4.9 总时长中位数（范围） | 中位数降低 |
|---|---:|---:|---:|
| delayMs=0，正常订单响应 | 10.483 s（10.431–11.342） | 7.208 s（7.142–7.682） | 31.24% |
| delayMs=180，订单响应丢失 | 12.751 s（12.673–12.933） | 9.365 s（9.327–9.375） | 26.55% |

总时长包含测试控制器读取后端 OTP 并回填的决策往返，不含人工或在线模型等待；
OTP 交回后的中位数分别为
6.751 → 4.699 s 和 8.436 → 6.214 s。六个逐对收益为 26.02%–32.27%。
零延迟组也仍含渲染、截图、设备通信，不能叫“纯工具时间”；不简单减去网络延迟总和，
因为网络、动画、采集可能重叠。

十二次结果全部通过独立服务端账本：商品身份、数量、金额、账号、购物车、订单状态、
订单写入及查询次数、H5 共享会话和酒店查询一致。每次恰好一个订单 POST，没有重复写单。
最终 Script 源 SHA-256 为 `97362dbca3c5afc47612b264db631cf882d9fd8363eef0669a9c6af989bb2500`。

这是目前动态测试 App 的一个完整混合业务切片，不是对美团全部业务的覆盖。酒店结果
仍是明确的空列表 fixture；不能据此声称验收了真实酒店库存、预订、支付、取消退款。

## 连续执行、其他 App 和故障恢复

| 验证 | 最终结果 | 范围 |
|---|---|---|
| 单次 Intent | 14 条命令；工具内 3.904 s，CLI 提交至结果 4.066 s；10/10 独立核对通过 | 返回、重新打开 Flutter、输入城市和日期、观察日期错误、纠正后查询；新增一条正确查询，旧订单不变 |
| 无 SDK 的 NotallyX | 一次 Script 354 次内部命令、2 次外部 RPC；UI 共 84.042 s，含独立 DB 验证 84.173 s | 三轮各 30.330/27.372/25.831 s；创建、编辑、固定、归档/恢复、删除/恢复、强停重启；42 项检查和三份 SQLite 快照通过 |
| NotallyX 最终脚本恢复复测 | 337 次内部命令；UI 共 79.302 s，含独立 DB 验证 79.439 s；39 项检查和三份快照通过 | 三轮业务；Script 子进程在第一轮 checkpoint 后崩溃，同一操作显式 resume 完成；不混同下列 Host SIGKILL |
| Web Memos | JS/Python 共 185 次命令、83/83 断言、6/6 数据库记录；11.870 s | 创建、搜索、编辑、删除确认取消等；无动作失败、脚本补写或重新执行。运行时有其他功能测试负载，不作 Web 提速比例 |
| checkpoint 后 Host SIGKILL | 55/55 检查；诊断加恢复 1.579 s | 同一操作、原 checkpoint 继续 |
| 效果发生、终态写盘前 SIGKILL | 62/62；诊断加恢复 2.151 s | 原动作查询、显式对账、显式续跑；普通 resume 保留未知而不重放 |
| 终态写盘后、Script 回执前 SIGKILL | 61/61；诊断加恢复 2.042 s | 保留原证据和缺失回执事实；查询原订单继续 |
| UIA 正常重启审计 | 165 条已确认终态后正常 stop/start 成功；stop 后的 start 调用 1.957 s，新 epoch、同一 JAR | 无 force-reset 或手工 journal 修补；新会话计数为 0；不等同于断电耐久性测试 |

Intent 使用预先准备的本地 `agentModule` 连续给出决策，15 次回调包含 14 条命令和
完成判断，不包含在线模型逐轮推理。Flutter 重新挂载时，`wait-text` 记录了三次暂不可用
观察，随后在同一次等待中成功，没有补写脚本或重放变更。

checkpoint 场景由专用控制器发送 SIGKILL，另外两处由测试 preload hook 在真实写盘
边界触发；均核对实际 PID 和阶段，未修改产品持久化源码。178 项检查通过，旧证据逐项
不变，业务写请求不增加。不是断电测试，
也不泛化成 UIA ACK 丢失测试。原生 SDK、H5 和 UIA 的未知结果不会被静默当作成功。

## 保留的失败及正确归因

- 用户确认的旧测试 APK“返回无反应”：自动与手动均失败，是测试 App 功能缺陷。
  本次冻结作者当前代码重新构建，Back → Home → Flutter 在十二次流程中实际通过；
  不把旧 APK 的失败计为 Bridge 派发失败，也没有为掩盖它绕过该页面。
- NotallyX 早期脚本有输入未就绪导致首字丢失、页面已切换前就选下一控件、抽屉动画中
  过早点击菜单的问题。它揭示 UIA 没报告焦点的产品缺陷，本次已修。验证程序现在等待
  可观测焦点、稳定布局与实际页面，输入后核对完整值。失败文件仍保留；最后三轮全部
  通过不抹去前面失败，也不把点击回执当成业务成功。
- Douyin 作者主页被后台 600 个节点挤出的现象已对应到本轮可见节点预算修复。两类 XML
  及 650 隐藏节点反例通过，但原真机本轮未连接，未宣称重跑了原 Douyin 作者页。
- 早期打包验收器仍期待默认前台探测，修正为显式 `feedback:window` 后最终包通过；
  不是依赖旧默认继续通过。旧失败日志保留。
- HTTP 相关并行测试曾触发既有等待用例超时，隔离及串行通过；最终完整 1,751 项功能
  回归也通过。Web/Notally 前期控制器与业务脚本缺陷分别记录，不混成产品成功率。

## 构建、包身份与审查

- Host：1,751/1,751 功能回归、50/50 性能回归，无跳过；最终干净 npm 安装的 native
  prebuild、npx、CLI/MCP、JS/Python、持久化恢复与关闭通过。
- Android SDK：debug 与 release 各 219 项；UIA 50 项、Gradle plugin 8 项。候选
  SDK/插件/执行器已向本轮隔离 Maven 目录预发布验证，未向公网发布。
- Flutter SDK：80 项测试与 analyze；test helper analyze；两份干净导出的 Pub
  publish dry-run 通过。原工作树 dry-run 的 dirty Git 警告保留，未当成依赖错误。
- Web SDK：38 项测试、构建、归档安装、六个发布文件三方一致和上述 Memos 实测。
- iOS：77 项共享 Swift 测试与通用 iOS 无签名构建通过。仍无 iOS 设备/模拟器复杂流程
  运行证据；Android/Web 的通过不能替代这一项。
- 两轴 Standards/Spec 审查覆盖本轮执行、观察、恢复关键路径，独立发现的原路由 P1
  均先复现后修复并复核；不声称仓库每行代码均已人工审核。
- CLI 全部 223 个发布文件（205 个 CLI 文件、18 个 bundled FactStore 文件）在源码、
  tarball、独立安装目录中逐文件 SHA-256 一致，发布清单无增删。npm 仅给两个 bin
  增加执行权限。UIA manifest 的 12 项源码、JAR、四平台 native prebuild 均一致；
  22 项发行版本声明为 0.4.9。

实际设备、业务与恢复证据使用 `package-final` 安装包；收尾只更新包内
`docs/RELEASE.md` 的验收状态，再生成 `package-release` 并重新通过干净安装验收。
两个归档的文件清单相同，逐文件比对确认仅此发布说明不同，其余 222 个文件字节一致，
包含全部执行代码、UIA JAR 与 native prebuild。因此旧包执行证据适用于最终包的相同
执行内容；旧包、旧验收与逐文件对照均保留。

最终归档：

- CLI `mobileaidev-ai-app-bridge-0.4.9.tgz`：
  `ec828a94e653bed51c9b360650de24771318100a84a0ec5011f3507dd54f53fe`
- Web `mobileaidev-ai-app-bridge-web-0.4.9.tgz`：
  `475a82cc476e74708e6e493970ac0380e2f1ed7766381e9428b7042c1d030382`
- UIA JAR：`260d631a2ddfd61ac5a031ac36983a4bd9bb3adc46c12a62feb57cf36ca8a60c`
- 动态测试 APK：`f4e8f5bfe98990aa048dd4e3219958cc9811d4ff74dcaa54cfc4945e96e1d975`

Flutter 测试消费者因公开 0.4.9 尚不存在，隔离副本编译引用本次 Android AAR，宿主明确
使用候选 SDK project；产品公开依赖仍为统一 0.4.9，未写入临时 Maven 地址。此连接方式
单独留有 manifest，不冒充公网安装通过。

证据根目录：
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/release-readiness-2026-10-14/`。
主要索引：`matrix-analysis.json`、`runs/*/summary.json` 与服务端账本、
`intent-final/summary.json`、`recovery-final-summary.json`、`uia-restart-final/summary.json`、
`notally/final-navigation-normal/report.json`、`notally/final-source-crash/report.json`、
`web-final-1/independent-verification.json`、`package-final/report.json`、
`cli-final-package-parity.json`、`package-release/report.json`、
`release-package-parity.json` 及 `logs/`。
发布后仍须核对公网归档和各消费者的实际解析结果。
