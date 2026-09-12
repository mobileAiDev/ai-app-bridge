# LocalSend 真实文件收发：Intent → Script

本轮已完成 Android LocalSend 与官方桌面 CLI 之间的双向实际传输、拒收和接收前取消。双向流程先用 Intent 探索，再固化为 Script，两个方向各三次同源回放通过。后续又完成实际传输中的接收端取消：Intent 完成，固定 Script 三次同源通过，独立核对实际文件增长、停止和完整残留字节。LocalSend 业务代码未修改。

这是固定文件业务验收；发送端传输中取消、断网恢复、其他设备/平台及整机组合仍需各自证据。下列耗时不能外推为全 App 回归耗时。

## 固定环境

| 项目 | 本轮绑定 |
| --- | --- |
| 上游 | LocalSend v1.18.2，`af0416be50770a97760f7070684bc667b759a15c`，由样本 `source.json` 固定 |
| 手机 | 已授权 OPPO PKR110，`b46093e6` |
| App | `org.localsend.localsend_app.bridge_sample`，versionCode 64 |
| 当前 APK SHA-256 | `96eae94329c2b08aeec008447af0c5ab5c1608ef95c37f0c603e2194278a2132` |
| 对端 | 未修改的[官方 CLI v1.18.2](https://github.com/localsend/localsend/releases/tag/v1.18.2)，macOS arm64，别名 `BridgePeer-20260911`，独立配置且未配对 |
| CLI 二进制 SHA-256 | `fc341cff20e9f9c61915039cd2a5ca53b2f0efffb1a37bc3335369d642dc9fa2` |
| 官方下载包 SHA-256 | `c375664d632a3065c135e712175fb336ceff1613e5e54ee3e04911db82e1b0fc` |

证据根目录为 `build/ai_app_bridge_artifacts/localsend-transfer-20260911-01/`，下文证据路径均相对此处。当前 APK 通过公开 `install-apk` 的 Intent 安装，安装后实际包哈希已核对。

文件清单 `transfer-files.json` 的 SHA-256 为 `214b60e7470ef53172f6cc7ebe7fcd4b37a6a69cadcbc9de78ca4904fe3f0a0e`：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `BridgeTransfer20260911.bin` | 2,097,152 | `91d3beb88a9b2f778a6c44a1c53b63d3c79931845a9aef84b3fb414610bd1938` |
| `Bridge传输20260911.txt` | 98 | `c5753d7d7b8e18c47177bf7fc6c7dfb5a841219321026554646b75d4d255a1b9` |

Android 目的目录为 `/storage/emulated/0/Download`，Mac 为夹具的 `received/`。复跑前只清理逐字节确认属于夹具的两个文件，原件保留于 `send/`。发送控制器另有明确的 `empty` 前提，不把不存在的文件算作旧接收文件。

文件管理曾被 OPPO 应用锁覆盖；用户回复“已解锁”后继续，没有绕过认证。通知申请通过 permission Intent 两次拒绝并核对 PackageManager，复跑前提是 `granted=false` 且含 `USER_SET|USER_FIXED`。全部回放前后的主题/颜色仍是 `system/system`，见 `settings-before.json` 与 `settings-after-all-scripts.json`；不声称权限标志和传输历史恢复原值。

## 业务回放

| 流程 | 独立结果 | 公共入口耗时 | 每次 Script 证据 |
| --- | --- | --- | --- |
| Mac → 手机 | 手机接受，两文件完成；实际手机文件逐字节相等 | 9.543 / 8.638 / 10.088 秒 | 12 个设备断言、2 个动作、3 张截图 |
| 手机 → Mac | Flutter → 系统选择器精确选择两文件 → Flutter 指定对端；实际 Mac 文件逐字节相等 | 32.244 / 31.554 / 32.051 秒 | 36 个设备断言、14 个动作、4 张截图 |
| 手机拒收 | 对端 `Declined`，手机回到接收页；`BridgeReject20260911*` 扫描为空 | 5.216 秒 | 7 个设备断言、1 个动作、2 张截图 |
| 发送端接收前取消 | 对端 `Cancelled`，手机明确提示发送者取消，关闭后回到接收页；`BridgeCancel20260911*` 扫描为空 | 7.538 秒 | 9 个设备断言、1 个动作、3 张截图 |

计时从 Script start 请求到取得终态，包含自动对端协调及独立校验，不含源码编写、构建、夹具预检和归档。八次通过的回放均无人工介入。`ctx.askAgent` 由确定性的本地控制器自动回答，用于驱动真实桌面对端或返回独立校验，没有要求人工作出决策。

固定源码 SHA-256：

- 接收：`663aefe013085820d5c2816e324dfdfd90dde206d31a0406a85246f0d423f86d`。
- 最终发送：`4c32d8f43befdc915bb4688f3ff2955432776b7122d79cc3b2e62b7ffacf36fa`。
- 拒收/取消：`0ca879201636559cc4200638d0210b6ffd0615ff67fd9d71daffa1e51758c6ef`。

源码、实际事件页、夹具和报告保存在各 `script-*/` 目录。独立校验器是样本的 `validation/transfer-oracle.py`；故意错误的清单哈希已被它拒绝，见 `oracle-negative-check.json`。该结果不冒充错误预期 Script 的运行证据。

## 修复的通用能力

**Flutter 后台引擎抢占界面通道。** LocalSend 的 `flutter_foreground_task` 创建后台 FlutterEngine。原 Bridge 在 engine attach 时覆盖全局操作回调，后台引擎停止时清掉它，导致文件已接收但点击“完成”报 `flutter_action_handler_absent`。插件现在只为绑定 Activity 的引擎注册界面操作通道，并在 Activity detach 时解除自己的注册。构建固定 APK 后，真实双向收发及同源复跑均能完成后续界面操作。未改上游的传输服务；多 Activity 引擎切换、旋转重建仍需各自实测。

修复文件：`flutter/ai_app_bridge_flutter/android/src/main/kotlin/io/github/mobileaidev/aiappbridge/flutter/AiAppBridgeFlutterPlugin.kt`。旧 APK 保留在 `installed-before.apk`，SHA-256 `0c3eecf348a5613ce8490a6d915fbb0889b867d5520481cae2b9209cd72056df`；反例 `receive-intent-02-done.json` 明确未派发且无歧义。

**Script 缺少精确 UIA 字段入口。** OPPO “全部文件”父容器的无障碍说明和子节点文本同名，便利文字命令同时匹配二者而报歧义，Intent `{text: ...}` 可以区分。新增公开 `tap-uia`，要求明确 package 和单一 `text`、`contentDescription` 或 `resourceName`，复用 Intent 字段选择和已有 UIA 原节点/原回执执行通道。CLI、MCP、Script 共用实现，目录现有 113 个命令。便利文字入口保留标签匹配语义，错误信息明确指向精确入口。

发送 Script 滚动后等待连续观察的列表几何一致，再进行下一次选择。`uia_tree_changed` 只在明确未派发、无歧义的读取失败时重新观察，并保留失败证据。

软件首轮 49 项中 48 项通过，一项新增测试漏写既有协议的 `exact/packageName` 字段；补全预期后，21 项精确选择、语义目标与入口检查全通过，见 `uia-selector-tests*.log`。干净安装包通过三入口精确 UIA 操作、原动作 ID 及跨入口控制检查，见 `precise-uia-package-02/report.json`，包含实际原生依赖编译。首次包检查的受控 ADB 未提供前台窗口，失败保留在 `precise-uia-package/`，修正的是验证夹具。

## 保留失败及归档

- 接收 Intent 02：实际文件正确，但后续“完成”失败，不能写成整个 Intent 成功。
- Intent 03：接收修复验证成功；后续文件列表未停稳，选择被 `uia_reobserve_required` 拒绝且未派发。新 Intent 04 随后完成真实发送。
- 取消 Intent 06：取消提示、关闭与文件不存在的证据已取得，但最终 complete 提交超过 180 秒总预算，终态 timeout。后续相同业务 Script 完整通过。
- `script-send-01`：初始观察超时，随后发现前台已是其他 App；无点击，没有认定前台变化的原因。
- `script-send-02`：UIA 文本/说明歧义，第四次动作调用未派发。最终源码改用精确入口，03/04/05 同源通过。

`archives-01/summary.json` 包含 18 份公开导出及副本离线验证：8 个 Intent（含失败、安装、通知拒绝），10 次 Script（8 次通过、2 次失败）。离线验证使用不可用 ADB，并把 Host FactStore 路径设为普通文件。通过 Script 的 50 个动作已核对原动作 ID、目标和执行凭据，26 张 Script 截图随录制归档保留。

归档完整性不改写业务结论。文件原件、独立 oracle、官方 CLI 日志及构建输入是同目录的外部证据，不冒充手机自动采证或归档内载荷。

## 实际传输中的接收端取消

此小节证据根目录为 `build/ai_app_bridge_artifacts/localsend-inflight-20260911-01/`。设备、APK 和官方 CLI 二进制与上表一致；对端使用独立配置和别名 `BridgePeer-InFlight`。输入为实际 1,073,741,824 字节文件，SHA-256 `2c06ade942ee3f17a048dd1064b2fab046a4bb95386d8bb41b68dc6711ac2af3`。每次 Script 前都核对已安装 APK、官方 CLI 和原文件哈希。

Intent 接受真实请求后，独立 ADB 读取先证明目的文件连续增长且未完成，再操作“取消 → 确认取消”。官方对端必须返回 `Cancelled by receiver (0 file(s) sent)`。校验器等待残留大小稳定，保存整个残留文件，逐块与原文件前缀比较，同时核对原件、实际文件及前缀哈希，并复查读取期间大小不变。成功 Intent 为 `localsend-inflight-receiver-intent-05`，23.030 秒，实际残留 304,185,337 字节。

据此编写的 `validation/localsend-transfer-inflight.v1.js` 固定 SHA-256 为 `862a5bd1e05f2c7ac397a90805365e6ba37dd2cd2afe598054243a8217696590`。三次使用相同源码、输入文件名及字节、APK 和对端；每次重复前只移除与上次独立证据及保存副本哈希一致的那个残留文件。

| 运行 | 公共 start 到终态，含独立字节读取 | 实际停止字节 | 结果 |
| --- | ---: | ---: | --- |
| `localsend-inflight-script-01` | 23.495 秒 | 305,950,014 | 通过 |
| `localsend-inflight-script-02` | 23.034 秒 | 282,739,038 | 通过 |
| `localsend-inflight-script-03` | 21.633 秒 | 253,435,817 | 通过 |

每次有 11 项设备断言、3 个原动作 ID、3 张截图，无人工介入；截图显示真实进度条、取消确认层及返回接收页。对端与独立 oracle 由控制器通过 `ctx.askAgent` 自动协调。传输量随取消时机变化，不把残留字节要求为固定数值。

同一 Script 的错误对端预期运行在 21.357 秒返回 `gate=failed`，0 个动作，独立目录扫描确认未接收文件。这是预期页面未出现导致的 Script 失败，不声称产生了 failed 业务断言；宿主 `completed` 仅表示 Script 已返回。对端请求随后由控制器取消，单独的清理 Intent 已关闭提示并确认接收页。

保留的原始失败包括：

- Intent 01 打开确认层时仍在传输，但确认前已发送完成；手机完整文件与源哈希一致。这是取消与完成的竞争，取消门禁失败，不能凭返回接收页判为取消成功。
- Intent 02 实际取消成功，但校验工具调用了 Python 3.9 不支持的 `hashlib.file_digest`，原 Intent 最终取消。修正工具后读取同一残留文件：308,396,025 字节完整前缀匹配；原失败不改写。
- Intent 03 确认取消时返回 `foreground_package_mismatch`，原回执明确 `dispatched=false`。没有推断是谁改变前台，后续恢复与成功运行分别留证。
- 目录 04 仅记录准备脚本使用不支持的 `Path.hardlink_to`；没有启动 Intent。随后显式改用 `os.link` 创建相同字节夹具。

`archives-01/summary.json` 的 10 份归档均经不可用 ADB、不可用 Host FactStore 的副本离线核验：6 个 Intent（含失败和清理）、4 次 Script（3 次业务通过、1 次负向失败）。三个通过 Script 的 9 个原动作凭据与 9 张截图已核对。独立字节、副本和官方对端日志另行保存。前一阶段外部清单所列 87 个文件已按原哈希完整冻结到 `localsend-transfer-20260911-01/external-frozen-01/`，包含当时的报告版本；后续文档更新不覆盖该历史副本。

这里取消的是 App 中的业务传输。接受请求的点击已完成后，后台传输仍会继续；本结果不等同于“取消 Script 会撤销已经启动的 App 业务”。没有修改 LocalSend 的残留文件处理逻辑，也不声称所有试验文件或传输历史恢复原值。

## 后续范围

接收端中途取消与独立部分文件关口已完成，停止重复本轮正向流程。下一项是既定 Wikipedia 的原生/H5 搜索、文章和阅读列表，再推进 VLC、Organic Maps，并组合已验业务为整机套件。发送端中途取消、断网恢复和各平台剩余基础能力继续保留，不能由接收端结果替代；Android LocalSend 也不能代替 iOS/H5 或其他 App 验收。
