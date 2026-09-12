# 第三阶段 G：Native 手势、执行中取消与真实采证

Native `longPress/swipe/scroll` 已接入 SDK 的目标绑定和持续触摸执行。Intent 与公开 `native-gesture` 共用合同和执行端口，JavaScript / Python Script 可以直接调用这一能力。NotallyX 真机验证同时检查了 UI 变化、本次动作的手机事件、原始回执和独立业务数据库；没有修改样例 App 的业务逻辑。

本轮完成 Native 手势的固定场景与故障验证。Flutter 执行目标绑定、跨进程设备独占和其他平台/多 App 门禁继续按总计划推进，不能据此宣称整个体系已经生产就绪。

## 合同与实现

- 新增 `native-gesture`，公开入口当前为 94 个。MCP/CLI、JS/Python Script 和 Intent 共享严格的手势分支 schema。公开参数是 App target、selector、动作和对应的持续时间/位移/方向；payload 不接受原始 targetRef/actionId，由执行层绑定实际 SDK 引用并关联动作身份。完整快照见 [3G 命令合同](audits/2026-09-09/command-contract-phase3g.json)。
- Native 手势在 SDK UI 线程内核验实际 View、窗口和运行实例，再发送 DOWN。同一控件移动时使用执行时位置；控件被替换、语义变化或终点越出窗口时拒绝派发。Native scroll 必须明确滚动容器，边界返回结构化拒绝。
- SDK 按实际经过的时间安排 DOWN/MOVE/UP；长按保留 Android 原生长按回调的运行机会。DOWN 后触摸流归原窗口，内部子控件路由交给 Android；窗口/焦点/根布局变化则向原流发送 CANCEL。
- 持续手势有独立回复线程，SDK 监听入口仍可处理观察和取消。取消必须匹配 actionId 与 runtimeEpoch。排队取消/超时不能留下迟到 DOWN；动作已开始则等待实际 CANCEL 后释放占用。主线程仍被阻塞时明确返回 `dispatched:null, ambiguous:true`，SDK 保持占用直到实际收尾。
- Host 的超时或取消只向原连接、原运行实例发出一次取消请求，核验取消回执身份，不重放手势。App 的既有业务回调无法由 CANCEL 撤销；TCP 断开本身也不被声明为已经停止设备动作。
- 采证异常与触摸投递结果分别返回。Capture 回调抛错记录为 `evidenceError`，不会在已确认的 UP/CANCEL 后补发第二个终止事件。
- 公开 `swipe` 继续作为显式 ADB 物理坐标原语；绑定 Native 控件的手势走 `native-gesture`。系统 UIA 的窗口操作继续保留自己的明确 provider。

## 真机暴露的采证缺口

首次 Intent 手势已实际改变 UI，但自动采证返回 `unsupported_argument`。旧 observer 将 Intent 的 `streams` 控制字段传给单个 `events` 查询；另一条入口还携带了 `foregroundPackages`。本轮在入口分离控制字段与真实查询参数，并让测试经过实际公共参数校验。

手机保留历史中存在已知 gap。旧逻辑只从完整页保存 watermark，导致后续新动作仍无法越过已确认的历史缺失。现在允许保存 SDK 对 partial 页签发的 watermark，用它限定后续动作窗口；原 partial 页和 gap 仍如实保留，不将缺失历史改写为完整。Script 同样先读取实际历史结果，再从签发的边界核验本次 actionId 的完整事件窗口。

结构化采证错误新增 `field/message` 后，首次归档验证还暴露了写入端与核验端的元数据投影差异。现在双方共用 `capturePageMetadata`，只在实际存在时保留诊断字段。最终包既验证新成功记录，也离线验证了首次 inconclusive 记录。

## 固定环境与安装物

设备为已授权的 `b46093e6 / PKR110`，Android API 36，当前系统 brand 为 OnePlus。基线 HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`；工作区保留此前阶段的未提交修改，本轮未提交、推送或发布。

证据根目录：`build/ai_app_bridge_artifacts/command-production-phase3g-2026-09-09/`。最终汇总为 `acceptance-summary.json`，本轮变更与原有修改的区别记录在 `phase-changes.json`；`source/`、`sdk-source/` 保存对应源码，原始失败目录保留。

| 安装物 | SHA-256 | 验证范围 |
| --- | --- | --- |
| 最终 npm tarball | `1b179eca679199e72bbb6eb87d9e402b0707fff0013157805cc630709ac4c206` | `package-verified`：新目录 npm 安装、原生 node-gyp 生命周期及公开 MCP 合同；随后用该包执行真机流程 |
| SDK instrumentation APK | `cb6efbe531033c16fa04c6d7af56b80f7ec2e1b204146a3790169913717489ea` | `sdk-install-final/002-intent.json`：公开安装 Intent 与手机 base.apk 字节核验 |
| NotallyX + 最终 SDK | `50a0f8d6375237e0a95989e2029e892ed57af3a8449be68aa4e300a81556fb7f` | `notallyx-setup/002-intent.json`：公开安装 Intent 与手机 base.apk 字节核验 |

最终 tarball、干净安装目录与当前工作区的 96 个发布文件全部一致，见 `package-source-verification.json`。Android SDK 的 55 个源码文件也与验证后保存的哈希一致，连同 5 个构建配置文件冻结，见 `sdk-source-verification.json`。打包后仅继续补仓库验证脚本和根目录报告；没有改动已验收包的运行代码与包内文档。

## 验证结果

| 验证 | 结果 | 原始证据 |
| --- | --- | --- |
| Host 全量检查 | 898/898，0 失败/取消/跳过 | `logs/phase3g-host-check-verified.log` |
| Android 单元测试 | 140/140，0 failure/error/skip | `sdk-unit-results/`、`sdk-verification.json` |
| SDK 真机集成 | 28/28，50.966 秒；15 个新手势场景与 13 个输入/故障场景 | `logs/phase3g-instrumentation-final.txt`、`accepted-sdk-traces/` |
| Intent 手势 | 长按选中一条笔记、退出选择、明确容器滚动、已观察节点滑动；3 个动作均有本次手机事件 | `device-verified/report.json`、`intent-archive/` |
| JavaScript Script | 9/9 设备断言 passed，8762 ms | `device-verified/javascript-archive/` |
| Python Script | 9/9 设备断言 passed，8754 ms | `device-verified/python-archive/` |
| 真正执行中的 Script 取消 | 确认 DOWN 后取消，SDK 发出 CANCEL 并释放占用 | `device-cancel/report.json`、原始调用及 `archive/` |
| 独立数据检查 | 开始、正向结束、取消收尾后，全部 SQL 表与偏好内容一致 | `notallyx-before/`、`notallyx-after/`、`notallyx-restored-state/` |
| 离线归档 | 7/7 integrity verified；不可用 ADB、不可用原 FactStore，新目录公开 `evidence verify` | `offline/report.json` |

SDK 场景直接配置真实 View 并经正式 HTTP 端点执行，覆盖长按回调、当前几何、替换同名控件、越界/零位移、明确滚动容器与边界、排队超时/取消、执行中取消、错误运行实例取消、窗口切换、主线程阻塞、采证回调失败、无效 JSON 及半截空闲 HTTP 请求。原始 trace 从最终 instrumentation 的测试名和时间戳中选出，28 份均保存哈希；完整拉取备份为 `all-sdk-traces-verified.tar`。这些测试没有为发布 SDK 添加测试控制端点。

最终真机 Intent 为 `gesture-binding-1788894001479`；JS 为 `script-1788894011813-1`；Python 为 `script-1788894020897-2`。每种 Script 的 9 条断言分别覆盖初始列表、三个手势的本次 started/completed 事件、长按选择、退出选择、滚动与滑动的实际内容变化，以及恢复原列表位置。查询标题来自独立数据库的 note id 11，初始标题 top 为 482。上述约 9 秒只对应这个固定短流程，不能作为全 App/整机回归耗时。

执行中取消为 `script-1788894195461-1` 的 `action-1`，原定长按 8000 ms。控制器先从手机事件确认 started，再调用公开 cancel；本次 Host 从发起取消到收尾为 27 ms，SDK 触摸流总时长为 37 ms，实际仅有 DOWN+CANCEL 两个输入事件，`handledCancel:true`。本次没有进入笔记选择状态，取消后 `debugBridge.nativeGesture` 为 null。两个时长各取自对应时钟，仅描述本次观测，不是延迟承诺。

取消 Script 的归档包含其调用结果与 SDK 取消回执；控制器读取的手机事件页、截图是独立外部文件，随本轮目录及文件哈希保存，不能写成已包含在 Script 内的手机采证页。正向 Intent/JS/Python 的已录制手机载荷、调用及断言则随各自归档保存。7 份离线验证还包含两个安装 Intent 和首次 inconclusive Intent；归档完整性不改变执行/业务裁决，也不证明未查询历史完整。

独立偏好 SHA-256 始终为 `f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`；全部业务 SQL 内容为 `16090377a96644cacb5f82f11f257d7479573652efd4463d448a07676a11db21`，BaseNote/Label 各 11 条。已查看长按选择截图及最终恢复截图；App 回到原列表顶部且退出选择。原有 Flutter 锁文件保持不变。

## 保留的失败与迭代

1. 原先依赖 ADB 长按坐标的 Host 测试在迁移后失败；改为检查实际共享 SDK 引用与相对手势参数，最终全量通过。
2. 首次 `native-gesture-explore-3g` 的动作成功，采证却因控制字段泄漏失败，按 inconclusive 结束并保存 `intent-first-archive/`。随后 `capture-recheck` 又明确记录历史 partial gap，促成上述 watermark 边界修复。
3. `device-first` 中 Intent 动作及新手机事件已通过，但归档元数据投影不一致使 export 失败。统一投影后重新打包、执行及离线验证。
4. `device-second` 的 Intent 已通过；JS 验证脚本误从 `result` 读取 watermark，实际合同在 `evidence.capture`，因此该轮失败。修正验证脚本后，`device-third` 的工作区执行通过，最后以 `device-verified` 的干净包执行作为接受结果。
5. 中间包及早期 SDK trace 提取文件继续保留；最终接受的安装包、日志、trace 和各次失败通过上述路径明确区分，没有用后续成功覆盖早期记录。

## 下一关口

优先补 Flutter 的真实 Element/EditableText 绑定，以及点击、等待帧、写入之间的目标/焦点核验；随后推进跨进程物理设备独占。Native 手势的短流程和 SDK 故障验证已完成，其他 Android 版本、安装整体预算及故障分支、更多权限组、iOS/H5/Web 合同与真机、原四 App 固定范围、连续运行及压力/性能门禁仍需独立验收。
