# iOS 原生复杂业务：FreeOTP Intent 与 Script

> 2026-09-11 接续：[Kiwix 原生/H5 阅读结果](IOS_HYBRID_BUSINESS_2026-09-11.md)。XCTest 授权已恢复，真实 H5 Intent 和连续混合 Script 已通过固定阅读流程；下文授权超时和 H5 未验收描述保留为 09-10 的历史记录。

本轮关闭的是 iOS 原生点击、输入、真实表单和保存结果的首条业务链路。FreeOTP 的 UIKit 流程已由公开 Intent 操作，再由公开 JavaScript Script 连续复跑。它不代表 FreeOTP 全功能、SwiftUI、WKWebView、Flutter 或整个 iOS 已验收。

## 目标与样本

- iPhone 17 Pro Max，UDID `00008150-001005143A32401C`，iOS 27.0 `24A435`。
- FreeOTP `c1209be7c2ea48f923b0046a9179a640db403968`，独立包 `io.github.mobileaidev.freeotp.sample`。
- WDA 14.1.1，独立 Runner `io.github.mobileaidev.aiappbridge.wda.xctrunner`。原生控件协议为 `aab.ios-native-target/v1`。
- Personal Team 可签名。样本接入仅涉及 Bridge 启动、Debug 签名、依赖路径与 iOS 27 必需的 Scene 启动适配；保留上游业务与许可证。
- 令牌均使用 RFC 4226 的公开测试密钥，无真实账号。预期由 Host 的 Node HMAC-SHA1 独立计算，再与手机实际显示比较；没有写入或伪造 Keychain 业务结果。

## 真实结果

完整证据根目录：`build/ai_app_bridge_artifacts/freeotp-ios-core-2026-09-10/`。

| 执行 | 结果 | 范围与原证据 |
| --- | --- | --- |
| Intent 01 | failed，保留 | 从首页打开表单，验证必填错误，填写发行者和描述。描述输入在手机完成，Host 的旧 5 秒 HTTP 期限提前返回；原任务完成回执证实手机已经输入。`native-intent-01/export/` 与 `description-original-result.json`。 |
| Intent 02 | failed，保留 | 重新观察已填字段，填写密钥，选择 HOTP/SHA1。提交前 WDA 报告前台变化，拒绝派发；紧邻截图仍是表单，原因未定，未假定为锁屏或自动改目标。`native-intent-02/export-02/`。 |
| Intent 03 | completed | 重新观察后提交，搜索和选择 FreeBSD 图标，保存令牌，实际生成 `755224`。`native-intent-02/export-03/`。前两次失败不能改写为一次无中断成功。 |
| 连续 Script | completed；17 passed，0 failed，0 inconclusive | 新建独立令牌，空表单错误、三个字段、HOTP/SHA1/6 位、图标筛选、保存、首次验证码、真实进程重启、持久计数器推进。`native-script-01/`。 |
| 错误验证码预期 | failed，符合预期 | 同一令牌下一次实际值为 `359152`，正确算法检查 passed；故意期待 `000000` 的新 UI 断言 failed。`native-wrong-code-01/`。没有用常量 false 冒充业务反例。 |

Script 主体为 **78,395 ms**；公开 start 到 terminal 为 **79,530 ms**，包括启动、生命周期调用和 5 张截图。此计时仅覆盖上述固定流程，包含重启，不能外推为全 App 或整机耗时。错误预期执行为 5,183 ms。

正向 Script 验证进程从 PID 1232 变为 1275，重启前后依次显示 `755224` 与 `287082`。这同时检验保存、计数器推进及重启后的业务读取。算法和固定向量来源为 [RFC 4226 Appendix D](https://www.rfc-editor.org/rfc/rfc4226.html#appendix-D)。

正向、反向均经公开 evidence export/verify。独立文件复核见 `native-business-audit.json`：正向归档 58 个载荷文件，包含全部 5 张 PNG；反向归档 5 个载荷文件，所有长度与 SHA-256 匹配。首版控制器的报告数组漏收了 assertion 事件，原报告保留；审计从原始 events 提取 17 项断言，控制器已修正。没有因此重跑业务。

正向源码 SHA-256：`1f8671f60cb38060525304aed65191838fce98b3accc0e0e06d9ecf401b1de85`。

正向归档 manifest SHA-256：`3f5bec844a83c2e23d012c2ddca790ce3d084e6edff548f64d70a7ca6fc85277`。

## Bridge 改动与验证

1. `ios-tap-native`、`ios-input-native-text` 与原生 Intent 共享精确 selector：accessibilityId、label 或本轮 elementId，可附控件类型。Runner 重新校验实例、原始标识、类型、可见性与可操作性；目标绑定 App PID、WDA session 和 Runner epoch。重复文案要求明确类型，未命名图标从本轮树选择，不保留旧坐标。
2. 平台严格区分原生 Intent 动作合同。iOS 当前开放 tap/inputText，不能提交 Android 的 back/keyevent/resourceId。Script 生命周期调用只注入该 operation 接受的目标参数。
3. WDA 受管动作 HTTP 等待预算改为该动作获准的期限，避免输入尚在正常执行时被通用 5 秒读取期限误判。原始失败和完成回执均保留，没有重复输入来掩盖失败。
4. iOS 截图返回实际文件的 SHA-256，Script 证据引用指向正确 outFile，导出包含实际 PNG。截图与附近 UI 树是两次观察，不宣称原子同帧，也不把 WDA 回执冒充 SDK 移动事件关联。

107 项定向 Host/合同检查通过，日志 `native-final-07.tap`。另外 6 项 devicectl 明确拒绝与未知结果检查通过，日志 `ios-install-limit-final-09.tap`。签名 FreeOTP 和新原生 Runner 均实际运行；没有重复 Android 已通过矩阵或存储容量专项。

## Kiwix 接续与剩余范围

Kiwix `c78d229dac2b836eaeeb7137c0852f54b10b2a7b` 已完成 arm64 构建、签名校验和真机安装，独立包为 `io.github.mobileaidev.kiwix.sample`。固定离线百科夹具见 `examples/kiwix-sample/fixture.json`，通过上游 Documents 扫描入口载入，不能把夹具复制当作导入 UI 验收。

安装实际触发免费签名三应用上限。旧 Bridge 演示 App 停止后备份 Library/Documents/tmp，共 34 文件、67,330,435 字节，再卸载该演示包，保留 FreeOTP 与 WDA。记录位于 `build/ai_app_bridge_artifacts/kiwix-ios-core-2026-09-10/`。

该拒绝也暴露 Host 把确定的系统安装失败误判为未知。现在只对匹配原 invocation、JSON 版本、系统错误链和免费 profile 限制的原始回复返回 `ios_free_profile_app_limit` 与 settled；超时、丢失、其他验证错误仍未知。旧占用通过已保存的原 MCP 请求/回复、设备、owner、pending ID 和时间窗口逐项匹配后一次性修复，见 `install-limit-original-recovery.json`，未重放原安装。这不是通用丢失 devicectl 回执恢复的验收。

下一业务仍是 Kiwix 原生书库、搜索、WKWebView 文章跳转、书签和实际持久化核对，随后完成独立 Flutter 复杂业务。H5 Intent 与 typed DOM 动作现已实现；真实复杂 H5、真实多 WebView 与跨 provider 切换仍未通过。FreeOTP 的编辑、删除、排序、QR 和设备认证也未在本轮验收。原四 App、LocalSend 真实收发、Python 同义流程与最终生产可靠性缺口继续保留。


## Kiwix H5 接线进展（同日后续）

Kiwix 的原生 Intent 已打开真实离线资料，并在 Search 输入 `Climate change`。
系统无线数据弹窗通过独立 SpringBoard Intent 点击 `WLAN Only`，原点击回执成功；
弹窗消失后旧 target 的后续观察失败，任务取消并保留原回执。
这暴露的是显式跨 App 观察衔接缺口，不能把该任务记为完整通过。
原生阅读任务在 USB 连接丢失后取消，没有重放已完成的搜索输入。
对应原始记录位于 `kiwix-ios-core-2026-09-10/native-hybrid-02/` 的
`permission-export/` 和 `reading-export/`。

重连后的截图确认 App 回到首页，资料仍在，搜索状态未保留。
WDA `runtime-restart-03` 因远端连接失效退出；`04`、`05` 均在 XCTest 初始化
报 `Timed out while enabling automation mode` 后退出。用户已确认开发者设置中的
Enable UI Automation 仍开启。没有证据证明它是锁屏或用户设置导致的问题，
也没有因此重复输入或把启动失败算作业务失败。

Bridge 新增 `IOSH5Bridge.swift` 和 Host `ios-h5-target.js`：

- `ios-h5-dom` 明确选取可见 WebView；多个候选必须指定观察所得 `webViewId`。
- 页面绑定 SDK epoch、bundle/PID、WebView、document ID 与 URL；元素以 WeakMap
  分配实例 ID，替换、跳转、history route 变化和 BFCache 恢复不能复用旧目标。
- `ios-h5-click/input/scroll` 已开放给 Script；`provider:h5` 的 Intent 共享这些
  命令并携带已提交观察中的原目标与 actionId。没有隐式原生/H5 provider 切换。
- 点击/输入先由 DOM 计算位置，再由 UIKit 命中检查，最后由 DOM 复核身份、
  位置和遮挡。无法映射的视口返回错误，不猜坐标。输入保留 focus 回调的变更检查。
- Expert `ios-h5-eval` 必须提交 `expectedPage`，新线协议统一为 `/v1/h5/action`；
  旧 SDK 在派发前返回 `ios_h5_target_schema_required`。Flutter 内嵌 Swift SDK 同步。
- 页面正文、控件数量和截断明确暴露；重复文本、不可见目标和扫描截断均不任意选择。

验证记录根目录为 `build/ai_app_bridge_artifacts/kiwix-ios-core-2026-09-10/`：

| 记录 | 实际范围 |
| --- | --- |
| `h5-host-02.tap` | 83 项 Host/Intent/Script/目标/schema/摘要检查通过；包括之前原生路径的相关回归。 |
| `h5-wire-03.tap` | 45 项 iOS 传输、原回执和公开命令检查通过。 |
| `h5-wire-final-04.tap` | 加入旧 SDK capability 拒绝后，34 项相关检查通过。 |
| `h5-geometry-05.tap` | 最后 6 项直接执行 SDK 中的同一段 JS，覆盖布局变更、替换、路由、重复/截断、遮挡、输入回调及公开 MCP Intent/Script。这里是 Host DOM fixture，不是真机网页。 |
| `xcode-build-h5-05.log` | 最后 SDK 版本在真实 Kiwix 设备构建目标上编译通过，codesign 严格校验通过。 |
| `h5-business-04/install-h5-sdk-05.json` | 公开安装成功，保留原 App 数据。 |
| `h5-source-05.json` | 7 个关键源文件的固定 SHA-256。 |

已请求用户在首页打开资料，作为 WDA 暂不可用时的人工测试前置；该操作不会计入
原生自动化通过。当前真实 H5 Intent/Script 阅读、跳转、收藏和持久化 oracle 仍待完成。
原生/H5 连续衔接、多 WebView 真机、原生遮挡真机、iframe/shadow DOM 和缩放场景
继续列为未验收；构建和 Host fixture 通过不替代这些业务证据。


17:44 的新启动 `runtime-restart-06` 捕获到明确的系统授权页面：
`Enter iPhone Passcode for XCTest — Enable UI Automation`。
截图为 `h5-business-04/automation-screen-06.png`。这比之前仅有的超时日志提供了
新的阻塞证据；已请求用户只在手机输入密码完成授权，未索取密码。
此前“手动打开资料”的测试前置请求被暂停，优先在授权后恢复原生自动化，
再由 Bridge 打开资料并推进混合业务。该次 Runner 已因 60 秒初始化超时退出，
须在授权完成后新建 Runner 会话，不能复用旧 session。
