# 第三阶段 F：Native 输入回调与 SDK 真机故障

本轮在真实 Android View 上复现并修复了输入回调重入问题：编辑框的输入连接或选区回调切走焦点、移除编辑框后，旧 SDK 仍可能写入原编辑框并返回成功。修复覆盖 Intent 语义输入和普通坐标/焦点输入，不修改 NotallyX 业务代码。

主线程阻塞、已经开始执行时超时、焦点回调改文案、控件移动及遮挡也已有直接 SDK HTTP 集成验证。本轮不包含 Native 手势、Flutter 目标绑定或整机套件的验收。

## 修改与合同

- `AiAppBridge.kt` 在获得输入连接之后、设置选区之后分别核验原窗口、原 View 的挂载与归属、焦点及可操作性；语义输入同时复查观察引用。随后才调用该连接的 `commitText`。
- 回调移除编辑框返回 `native_target_replaced`；回调转移焦点返回 `input_focus_changed`。焦点请求已经发生，因此这些拒绝回执为 `dispatched:true, ambiguous:false`；不继续提交文本，也不向新焦点改投。
- 输入连接在成功/拒绝后均收尾。App 自定义输入连接内部及提交后的业务回调仍由 App 执行，不承诺业务事务原子性。
- 新增 `src/androidTest` 中的测试 Activity 和 13 个集成场景。测试通过 localhost HTTP 调用正式 SDK 端点，在 instrumentation 线程配置真实 View 回调和主线程阻塞，并直接读取 View 文本/焦点及点击计数。发布 SDK 无测试端点。
- 测试 APK 使用 AndroidX runner、targetSdk 35。检查过合并后的库 Manifest，仍只声明 minSdk 19，未强制宿主 App 的 targetSdk。
- 增加 `verify-device-native-input.js`，对已观察的 NotallyX 搜索页面执行 Intent 与 JS/Python 同义输入，保存调用、断言和归档。查询标题必须由调用者从独立数据库快照提供。

## 固定设备与安装物

设备为用户已授权的 `b46093e6 / PKR110`，Android API 36，当前系统 brand 报告 OnePlus。基线 HEAD 仍为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`；本轮无提交、推送或发布。

本轮根目录：`build/ai_app_bridge_artifacts/command-production-phase3f-2026-09-09/`。

| 安装物 | SHA-256 | 已核验内容 |
|---|---|---|
| 最终 13 场景测试 APK | `c9189b40f5ee2fdd3b58786fa3f4606e0de3fbed15078f48f8f0780a8d2fbba0` | `install-acceptance/002-intent.json`：安装请求成功，手机 base.apk 字节一致 |
| NotallyX + 本轮 SDK | `86593148ed1b95740ab10a9e9fd60c7040dcdf3fe4a2d26b139a42883fdb6afe` | `notallyx-setup/002-intent.json`：安装请求成功，手机 base.apk 字节一致 |

NotallyX 验证使用第三阶段 E 的实际干净安装 MCP。执行前逐项比较该包与工作区的 89 个发布文件，全部一致；本轮后来仅更新了命令合同文档，Host 运行代码未修改。未把本轮算作新的 npm 发行包全门禁。

首次安装独立测试 APK 出现 OPPO 系统确认页。第一次控制器只轮询状态、没有作出决策，30 秒后关闭并取消 Host 安装进程，系统页面仍保留。原失败及清理回执保存在 `install-first`、`install-interactive/001-tap-text.json`。重新安装时通过 `intent observe` 得到真实前台、APK 名称及按钮，再按该 revision 提交观察到的按钮 resourceName。`intent-1788887272301-1` 在一次决策后完成，独立安装物核验通过。生产安装器没有加入按钮文案或 ROM 表。该确认页验证使用修复前的首个测试 APK，不混作最终 SDK 验证。

## 真实结果

| 验证 | 结果与证据 |
|---|---|
| Android 单元测试 | 134/134，0 failure/error/skip；`build/phase3f-instrumentation-build-repair.log` 及复制的 XML |
| SDK instrumentation | 13/13，20.087 秒；`build/phase3f-instrumentation-acceptance.txt` |
| 原始 HTTP 与独立 View 状态 | `accepted-traces/` 13 份；`instrumentation-report.json` 汇总 |
| NotallyX Intent | 两次 SDK 引用校验输入成功，查询结果标题精确命中独立数据库中的记录，然后清空 |
| JavaScript / Python Script | 各 3 条设备断言 passed：空且聚焦的搜索框、输入内容与唯一结果、清空；共 6/6 |
| 数据独立校验 | `notallyx-before/state.json` 与 `notallyx-after/state.json` 的偏好和所有业务 SQL 表相同 |
| 离线归档 | 6/6 通过；复制到新目录，以不可用 ADB 和不可用原 FactStore 调用公开 `evidence verify`，见 `offline/report.json` |

13 个 SDK 场景涵盖：排队 tap/input 超时后没有迟到点击/文本写入；触摸已经开始时超时明确返回不确定结果；焦点回调修改文本时不覆盖；输入连接/选区回调切走焦点时不写入；语义及坐标输入的编辑框被移除时不写入；同一控件移动后按当前位置点击；移动到其他控件下方时拒绝点击；正常语义输入/清空和正常坐标/焦点输入继续成功。

排队超时实测约 1503ms，返回 `dispatched:false`，解除主线程阻塞后仍无迟到动作。已经进入触摸回调时，约 1503ms 返回 `dispatched:null, ambiguous:true`，解除阻塞后点击发生一次。这验证的是准确区分结果状态，不是撤销已经开始的动作。

NotallyX 最终保留记录为 `notallyx-input-recorded/report.json`：Intent `input-binding-1788888153740`；JS `script-1788888155138-1`；Python `script-1788888155630-2`。两个 Script 分别耗时 494ms、508ms，范围仅为已打开搜索页上的两次输入及检查，不是全 App 回归耗时。最终空搜索框之后的完整列表恢复不在这三条断言内；收尾又读取了当前列表并退出搜索。

独立数据库中查询标题唯一对应 note id 11。前后偏好 SHA-256 均为 `f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`，业务 SQL 内容均为 `16090377a96644cacb5f82f11f257d7479573652efd4463d448a07676a11db21`；BaseNote/Label 各 11 条。查看了记录轮的搜索前、唯一结果和清空后截图，原图分别保存。

最终 Script 归档包含已录制的调用结果和断言；外部截图和独立 SQL 快照随本轮目录保存。离线完整性验证不代替业务断言，也不声称覆盖未查询的手机历史。

收尾已回到设置页并查看截图；`notallyx-restored-state/state.json` 再次确认偏好与业务 SQL 内容一致。所有本轮控制器、MCP 和 instrumentation 进程均已退出。原有 Flutter 锁文件未修改。

## 保留的失败

1. 第一次构建因未启用 AndroidX 失败；补了项目属性。测试 Manifest 的 targetSdk 被 Gradle DSL 覆盖，改为库测试 DSL 后验证实际测试 APK 为 35。
2. 最初 6 场景 5 通过，替换编辑框的测试预期 `native_target_replaced`，实际因新控件未布局而得到 `native_selector_not_found`。原实现此次没有错误写入，不能记作 SDK 误写。
3. 新增回调场景后，修复前 10 场景有 6 项失败。其中 4 项确实读到了不应写入的文本；另两项是上面的错误码预期，以及新增第二个编辑框挡住了移动后的按钮。保留原 HTTP/失败输出。修正布局夹具，并将遮挡另外作为明确拒绝场景；没有弱化写入断言。
4. NotallyX 首次复跑已通过，但归档未包含 Script 返回载荷与断言；保留在 `notallyx-input`。增加显式 recording 后重新执行和离线核验，以 `notallyx-input-recorded` 作为最终记录。

## 下一关口

继续 Native `longPress/swipe/scroll` 的 SDK 执行绑定与持续触摸的取消/窗口归属；Flutter 则需要真实 Element/EditableText 的稳定引用及帧间核验。当前 Native 手势仍由 Host 将目标转成坐标后走 ADB；Flutter 输入还会点击、等待一帧后向当前焦点写入，这两条路径未随本轮修复完成。

跨进程物理设备仲裁、安装整体预算及故障分支、更多权限组、iOS/H5/Web 合同与真机、原四 App 和长时间运行门禁继续保留。NotallyX 的这个短流程仅验证通用输入修复，没有替代上述目标。
