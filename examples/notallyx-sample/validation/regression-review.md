# 当前进展：R9 真实 UI 与完整覆盖复核通过

R9 真实归档已独立重算 59/59 个 UI 检查点，完整分母重建一致：143 用例中 7 passed、2 inconclusive、134 not_run；51 功能仅 labels.manage 完整通过，Full App 仍 false。14 phases /15 snapshot manifests，回归 187.172 秒；277 个本审查输入前后 SHA 不变。这里的数据库子结果仅作报告聚合，SQLite/WAL 全量重读由独立 DB 审查负责。

进入真机前发现的两个 P1（noop 输入被算冲突负例、不可用顶窗暴露背景）均已修复，离线 61/61 通过，真机使用了同一冻结版本。详细结果与复跑命令见 `.tools/business-app-migration-2026-09-07/r9-independent-ui-coverage-review.md` / JSON；源码审查见 `r9-independent-regression-review.md` / JSON。

以下 R5 与更早记录是历史独立结果，不是当前待办，也不回填为新增标签范围的通过。

# 回归链独立审查（R5 复审）

**结论：R5 的 27 个 UI 检查点独立重算通过，8 份真实数据库快照重新读取一致，436 份 artifact SHA 全部吻合。通过范围为两个文字用例、两个清单层级用例，三个组织流程仍为部分覆盖；全 App 通过为 false。** R1/R4 已发现的具体假阳性已针对性关闭；未把 Script 完成或自报 assertion 当作业务结果。

审查对象是 `run-regression.js`、`regression-script.js`、`ui-oracles.js`、`collector.js`、`oracles.js`、`report.js`。R5 以 `build/ai_app_bridge_artifacts/notallyx-migration/script-migrated-r5/frozen/` 和本轮真实证据为准。未操作设备、未运行 Gradle/全 npm suite，未修改被审查源码。原 Host FactStore 未打开写入；仅复制到临时目录后打开和重开，并核对原目录所有文件 SHA 未变化。

## R5 独立复核

目标为 `b46093e6` / `io.github.mobileaidev.notallyx.sample`，runId `script-1788748097468-800b99`。APK SHA 为 `8252b6c0a4d36ce1a38c4056ba2bb5becfa63ca18803e7dde42de3116cb80836`，Script SHA 为 `a45dff972a12e0281cc392f69595de7a781ba6f91e048e8901835d8cfe542006`，UI oracle SHA 为 `f6c89b3050a6a3eba86056c16742bccc5b844685ce00a3045100aa3ce1ea6e8c`。

`rerun-ui-oracles.js` 首先验证冻结代码、依赖和原始证据的报告哈希，再使用自身固定预期重新计算 27 个检查点：文字正常 5、文字重启 3、组织部分流程 3、清单正常 13、清单重启 3，全部 passed。每点仍验证可信 Host 发行的 tree→screenshot→tree、实际 PNG SHA、同 Activity、单调时间与前后独立业务谓词。

另外从 8 份原始 SQLite/WAL/SHM 副本重新解析数据，校验采集 transcript、文件 hash、Room schema 11，与各自 observed.json 完全相符。新清单 id=10 的最终序列精确为 Parent-A(parent, unchecked, order 0)、Child-A1(child, unchecked, order 1)、Child-A2-edited(child, unchecked, order 2)、Parent-B(parent, checked, order 3)。只有最后一项有 `checkedTimestamp=1788748144289`，在新笔记的手机创建/修改时间区间内，之后层级修改和重启均保持不变。重启前后整份 data 相等，创建及层级修改没有改变已有 notes/labels。没有用未持久化的 ListItem.id 代替业务标记与完整数组比较。

本轮 7 个 Script phase 的真实 Host 持久 envelope 共 **138/138 checksum 有效**：62 dispatch-marker、62 action-receipt、14 checkpoint；关闭再打开临时盘副本后，全部 evidenceId/checksum 仍一致。核验实现与 R5 冻结 host-code-manifest 的 SHA 相符。该 Script 路径没有 kind=observation 的持久 envelope，所以不能声称“138 份持久观察收据”；27 点的 81 份 UI 观察是另以 payload SHA 和可信 Host 发行链验证。历史 portable bundle 的旧 receipt 仍标记 not_verified，本轮新 receipt 通过不会改写旧历史。

R5 regression **73.535 秒**，全部 phase 与 Controller ADB 调用落在该时钟内；主采证、独立 oracle 与 artifact hash 核验包含在内。报告统计保持 143 用例中 4 passed、3 inconclusive、136 not_run；311 变体全部 not_run，396 原子槽只有 4 passed，51 功能无完整通过。R6/R7 尚未纳入本文件独立审查结论。

结果保存在 `.tools/business-app-migration-2026-09-07/r5-independent-ui-review.json`、`r5-independent-db-review.json`、`r5-independent-host-checksum-review.json`，实际 envelope 副本在同目录 `r5-independent-host-envelopes/`。这些是 R5 原始记录的离线复核，不是又一次真机执行。

## 原问题的关闭证据

| 原问题 | 修正与独立复核结果 |
| --- | --- |
| 全树标题与另一卡片正文/标签串证，同时对重复正文误报 | Script 与 Host oracle 均限定唯一标题所属 MaterialCardView 的 Note/标签。此前跨卡片负例在 R1 oracle 为 passed，修后为 failed。R3 的真实卡片检查重新验证通过。 |
| 非 Host 发行的 tree observationId、自填 payload hash 被当作独立证据 | Controller 直接从 MCP 取得 phase final，将可信 events/history 传给 UI oracle。oracle 对照 assertion 的 observationId/source/window/refs 与 call history 的 target/ref/hash，再自行重算业务谓词。把 tree ID 换成从未发行的值后，R3 返回 inconclusive。 |
| 同 action 就宣称截图/树同状态；不同 Activity、旧时间、互换 PNG 仍 passed | 每个检查点执行稳定 tree→screenshot→tree；验证三份 Host 收据、单调时间、Activity、前后可见业务/几何状态。截图采集时 Host 生成 PNG SHA，进入 screenshot ref 和可信历史，实际图片必须匹配该 SHA/尺寸。错误 Activity、倒退时间、替换为另一个真实 Activity 的 PNG、截断为 24 字节 PNG 头，即使更新本地文件 hash，均返回 inconclusive。 |
| public=true 时 collector 可能将保留的内部旧库当活动库 | reader 在解析偏好后明确拒绝 `dataOnExternalStorage=true`。在真实私有快照的离线负例副本中切换该偏好、同步所有采集文件 hash 后，返回 `external_storage_snapshot_unsupported`，没有获得可接受业务快照。 |

额外验证：缺少可信 Host final、伪造 screenshot 后的 tree 收据，也都返回 inconclusive。没有用 Script 自报的 assertion passed 代替业务判定；Host assertion 事件只作为 Host 确实发行该证据的证明。

本次离线探针：`/tmp/notallyx-r3-review.js`；完整结果：`/tmp/notallyx-r3-review-9UoFwu/checks.json`。4 个 phase 的 **11 个真实 UI 检查点重新验证通过**，8 类错误证据实验均被拒绝。报告列出的 **124 份 artifact 全部重新核对 SHA 一致**。负例仅在临时副本或本地读取替身上运行，没有修改真实 R3 文件。

## 计时与声明

R3 regression 为 **32.258 秒**。全部 phase 时间、Controller ADB 调用、数据库 force-stop/采集/前后 pidof 均落在该时钟内；源码终止时钟位于独立 oracle 与 buildReport 的文件哈希核验之后，因此主采证和判定没有漏计。最后 report JSON/HTML 写盘在计时结束之后。construction 的 124 ms 只表示冻结输入，不包含历史 Intent 探索、写码或调试；报告明确没有估算模型耗时/token。

报告声明准确：`core.ok=true`，但总报告 `ok=false`、`fullFrozenScopePassed=false`。143 个用例中 2 passed、3 inconclusive、138 not_run；396 个原子覆盖槽中只有 2 passed；51 个功能没有任何一个达到完整通过。三个部分组织流程没有被升级成完整用例通过。

## 保留的证据边界

- APK 在 Controller 开始时通过安装包真实字节 SHA 核验；snapshot 继承该次身份。运行中仍需要设备/安装独占，当前没有每次快照重新核验 APK，也不是设备签名证明。
- “同状态”具体指截图前后的 Activity、可见业务字段与几何状态一致，并且截图字节绑定采集时 Host 收据。它不是手机端原子图像/树快照，不能保证采集间隙绝无瞬态变化，也不等于逐像素视觉正确性或 OCR 验收。
- 数据库 oracle 仍是 Host 停进程后读取真实 SQLite/WAL/SHM，并校验 transcript/hash/schema；公共目录和加密数据库是明确不支持的采证范围，不能用本轮私有明文快照证明这些功能。
- portable bundle 与 list 不属于历史 R3 的结论；R5 新增范围按本文 R5 段落单列，不回填到旧运行。

历史 R1 复现保留在 `/tmp/notallyx-regression-review-j8TiUn/review-reproductions.json`，对应旧冻结证据位于 `build/ai_app_bridge_artifacts/notallyx-migration/script-migrated-r1/`。旧问题已关闭，不应继续把旧版假阳性结论套用到 R3。

## R4 已勾选清单条目修复复核

独立读取 R4 `list-create/calls.jsonl` 的最后真实树：Parent-B 位于 `CheckedListView`，仍为 `id/EditText`，但 `editable=false`、`focusable=false`、`alpha=0.5`；其余三项位于 `MainListView`，三个属性分别为 true、true、1。同条 `Content` 中存在 MaterialCheckBox。树没有输出 checked/isChecked，selected 也不代表勾选，因此布尔勾选结果仍由独立数据库完整 items 数组验证。上游 `ListItemVH.updateEditText` 的实现与此真实树一致。R4 失败原因是旧 Script 错误要求四项都可编辑，不能记为业务保存失败。

修复后的 Script 与独立 UI oracle 将预期 checked 绑定到对应分组、同条 Content 内的 checkbox、实际编辑/焦点/透明度属性，并保留四条唯一正文、顺序与缩进校验。用真实 R4 树验证通过；单独改变 checked 条目的 editable、focusable、alpha，令未勾选条目只读，替换分组，伪造 checkbox 类名或移走该条 checkbox，七类负例均拒绝。

复核另外发现并关闭一个假阳性：截图后的树仅改变上述三个属性时，旧 stateKey 忽略它们，Host 只重新计算截图前业务条件，因此仍 passed。现 stateKey 包含这些属性，Host 也对前后两树各自重新计算业务条件。使用真实 Host 本地发行、但 child 自报 condition=true 的离线负例，结果已由 passed 变为 `inconclusive/ui_changed_during_screenshot`。复核 UI oracle SHA 为 `f6c89b3050a6a3eba86056c16742bccc5b844685ce00a3045100aa3ce1ea6e8c`。

探针 `/tmp/notallyx-r4-list-review.js`；修前结果 `/var/folders/15/h64hzjtj6pv23qdjs3wz624c0000gn/T/aab-r4-list-review-tw2hJ3/review.json`；修后结果 `/var/folders/15/h64hzjtj6pv23qdjs3wz624c0000gn/T/aab-r4-list-review-U3Uskn/review.json`。本项只读源码与离线验证，不代表 R5 真机结果。Overview 检查点目前验证目标卡片内四个正文标记；层级与顺序由 editor 检查点和数据库精确数组覆盖，不能声称 overview 已完成逐像素视觉验收。
