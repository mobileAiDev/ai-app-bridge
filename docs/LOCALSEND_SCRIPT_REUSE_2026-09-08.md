# LocalSend 冻结证据到 Script 复用验证

本轮沿[后续关口](BRIDGE_NEXT_GATES_2026-09-08.md)验证第二个复杂 App 的复用能力。LocalSend 仍是 Bridge 的验证样本，本轮没有改动其业务逻辑或重新打包 APK。

最终冻结的 v1.0.5 已通过核心流程、三次同源完整正向、错误预期、等待控制器时取消、独立设置检查和公开归档离线核验。**通过的是这些明确的 UI、控制和外部设置关口；完整手机采证验收仍为 inconclusive。** 三次完整正向的 `events/state/logs` 当前窗口请求均发生超时，没有取得这些手机业务载荷；该问题没有被 UI 成功或归档完整性替代。

## 固定输入与独立编写

- LocalSend v1.18.2，源码提交 `af0416be50770a97760f7070684bc667b759a15c`，独立包 `org.localsend.localsend_app.bridge_sample`。
- OPPO PGFM10 `FYZLAU49X8OVQGJ7`，APK SHA256 `19276549d5d7a7dddb4d98d2d825b79516562016117a1d84de99c4f1299d0219`。控制器在每次运行前重新读取手机安装文件的哈希。
- 初始 Receive、设置滚动在顶部、主题与颜色 System、持久化 locale 缺席、没有选择文件。控制器通过 `settings-oracle.py` 在 Script 外独立读取实际偏好设置。
- 新上下文 `localsend_evidence_script_author` 仅从冻结的 Intent 载荷、截图、公开契约编写；不访问手机、不读取先前样例 Script、业务源码或原对话。输入文件、哈希、读取范围与试跑后的修订记在 `examples/localsend-sample/scripts/authorship.v1.json`。
- 原交接清单哈希 `4065fa0de414fbcc1c6dd00f028c101af8de366f5fc9de04a0d9d72d96f71efe`。本轮追加完整 Send 树与截图，追加清单哈希 `ea2349456f9fa342631f7c930f0971e5b346b9455beae81a0de63640133abe67`；没有覆盖原清单。

追加的完整 `flutter-tree` 中可见 `SendTab` 和 `DevicePlaceholderListTile`。脚本可以反复验证当前页面的空发现占位分支。该分支不证明网络已隔离，也不证明发现协议能发现所有在线设备；“未选择文件”仍是另一条单独断言。

## 执行与独立结果

源码、core/acceptance 两份场景清单与控制器分别位于 `examples/localsend-sample/scripts/` 和 `examples/localsend-sample/validation/run-evidence-reuse.js`。每次运行保存公开 MCP 请求响应、全部事件页、Host 录制载荷、断言、截图和设置读数。控制器在源 Host 退出后复制归档，在新 MCP 进程中禁用 ADB 并使 Host FactStore 路径不可用，使用导出回执中的清单哈希公开核验。

设置检查通过明确的 `askAgent` 节点交给控制器：控制器读取真实偏好设置，按独立固定预期判定，保存文件并带哈希返回。正向运行不等待人工回答；这些自动控制器等待计入时间。外部设置结果不伪装为 `ctx.assert` 的手机证据。

时间采用现有 `p9-timings` 的 Host 事件分类。`activeMs` 与 provider/evidence 等子项有重叠，不能相加；`businessWaitMs` 只计明确的 wait 命令，不涵盖 JavaScript 的轮询间隔。墙钟时间包含截图、轮询和外部设置检查。core 的 5 分钟与 acceptance 的 10 分钟阈值只对应各自冻结清单，不能换算成全 App 或整机耗时。

当前 Host 的 `rollingSummary.decisionWaitMs` 表示尚未回答的问题，终态会归零，不能当作累计等待。控制器另外按实际 `agent_question_created` 与 `agent_decision`/取消终态的时间戳配对，保存 `observedControllerWaitMs`。本轮没有把旧聚合值当成“零等待”，也没有调整运行时计时实现。

### 最终冻结矩阵

源码 SHA256 为 `e193188913c89c76cd30769e09c70887cec74c2df5bed60475cf8937a29aa985`，两份场景清单均为 v1.0.5。源码、清单、编写记录、README、Host 运行时代码在矩阵期间均未改变，每次安装 APK 哈希都与固定值一致。结果保存在 [matrix-3/report.json](../build/ai_app_bridge_artifacts/localsend-script-2026-09-08-matrix-3/report.json)。失败版本的通过次数没有沿用。

| 运行 | 墙钟耗时 | UI 断言（通过 / 失败） | 手机采证 inconclusive | 动作数 | 控制器结论 |
| --- | --- | --- | --- | --- | --- |
| core-1 | 1 分 23.009 秒 | 65 / 0 | 3 | 14 | 核心 UI、恢复、归档通过 |
| positive-1 | 4 分 46.432 秒 | 145 / 0 | 9 | 30 | 完整场景 UI、设置、恢复通过 |
| positive-2 | 4 分 42.315 秒 | 141 / 0 | 9 | 28 | 完整场景 UI、设置、恢复通过 |
| positive-3 | 3 分 42.386 秒 | 141 / 0 | 9 | 28 | 完整场景 UI、设置、恢复通过 |
| wrong-expectation | 0.478 秒 | 1 / 1（预期失败） | 0 | 0 | 错误设备名被识别，未执行动作 |
| cancel | 1 分 23.643 秒 | 39 / 0 | 3 | 6 | 检查点取消，取消后无新调用或设置改动 |

正向三次的中位数为 4 分 42.315 秒，均低于冻结完整场景的 10 分钟阈值。墙钟包含失败采证请求的等待时间，没有从成绩中扣除。它不是整个 LocalSend、整机回归的耗时，也不是与含人工分析的 Intent 探索进行同条件对比。

每次正向都有三次真实偏好设置变化检查，矩阵合计 9 次；所有 6 次运行的前后偏好设置均精确相同。独立复核还检查了实际许可证正文、初始与最终 Receive、设置四项的原始边界，以及 core/三个正向分别 27、65、63、63 组真正推进的 SDK 快照：每对原始节点、可操作边界、滚动边界和 viewport 一致，SDK 时间戳推进。每个 App 坐标点击的实际源节点完整位于 viewport 内。

6 份公开归档都在源 MCP 退出后复制，在无法访问 ADB 或原 Host FactStore 的新 MCP 中核验成功。公开归档不会自动收集外部控制器写的设置文件，本次公开导出的载荷中也未找到设置控制器的完整回复。因此，[独立设置与 MCP 事件证据包](../build/ai_app_bridge_artifacts/localsend-script-2026-09-08-matrix-3/portable-settings-and-events-review/report.json)另外携带 21 份读数、基线和 6 份完整执行事件文件，使用复制后的文件复核目标、实际值、检查点时间与公开 MCP 决定中的文件哈希。这些事件是本次控制器另存的公开 MCP 返回，不宣称由 Bridge 公开归档自动携带。新复核清单 SHA256 为 `5f6e16ae8819034e19a271a14a51e3302067df6afc7b2dcafbac61d83f3fd7f6`；最初只携带设置读数的 `portable-settings-review/` 也保留，没有覆盖。

取消后另以 Intent `intent-1788848086822-1` 恢复 Receive，重新读取的偏好设置与原始基线精确一致。恢复操作保存在 `localsend-script-2026-09-08-restore-6/`，归档 SHA256 `468fb804173088520af5d8c46c0dde3e00861958959e6dbdc3b41e0d36a17fc7` 已单独复制、离线核验；它不计入 Script 时间，也没有改写取消结果。最后的恢复操作仍观察到手机 capture unavailable，未将其清空或修饰。

最终复核中，core 的 3 次动作后读取返回 `capture_gap`；三个完整正向各有 9 次动作前 `events/state/logs` 读取返回 HTTP timeout，取消试验另有 3 次。这里请求已带 `sinceMs` 当前时间下界、`limit:200` 和 `view:decision-window`，不能仅称为“无界历史查询慢”。没有拿到完整动作前游标的场景保留为 `after-unavailable`，不捏造动作后页。三个完整正向的手机 item 数均为 0，归档保存的是失败返回、UI、截图和外部设置结果；Rust 网络与真实传输证据也未取得。超时根因尚未定位，不能直接归因于历史 gap 标记或网络故障。

## 保留的失败与暴露的缺口

第一次试跑保存在 `build/ai_app_bridge_artifacts/localsend-script-2026-09-08-pilot-1/`。源码哈希 `9478dde634c818bcd3f91b658be751404300736947d52f6043443e6cc7667648`。链接页、Send 占位分支和文件选择取消通过后，手机事件查询返回 `decision_watermark_required`。执行返回 `completed`，但流程及 UI 结论为 `inconclusive`，未执行设置修改。17.460 秒是这个失败试跑的时间。

失败归档哈希 `49a4fb7d8bba40d1c605c5c9169d047010d360651e008098d330d284083e7397`，复制后的离线核验通过。该结果只证明失败证据可携带与检查，没有改判失败试跑。随后通过独立 Intent 恢复 Receive，保留恢复动作与归档。

公开 `SCRIPT_AUTHORING.md` 原来没有说明动作前采证游标。已补充每个流先读取当前窗口、保留 mobile watermark、再以同一 target/epoch/cursor 查询动作后证据的契约。相关 Host 契约测试 31/31 通过；真机验证还须看修订后 Script 的实际返回。

第二次试跑保存在 `localsend-script-2026-09-08-pilot-2/`，源码哈希 `458a557715282131be3a5934227f73340080551cc4c16b33544941650a108620`。三次独立设置检查均通过。第一次设置滚动后，短暂的树只含 PageView 和导航栏；脚本误把连续两次相同的过渡树当成内容移动完成，在下一次滚动前找不到内容锚点而明确失败。该次没有继续发出不确定的滚动，失败的原始树和稍后已恢复内容的树均保留。修订后只有目标可见或出现唯一的当前可滚动内容锚点才继续。失败归档哈希 `5d35028c69ce98e9b0fd6e01f79687d21951ec2d23a23a0b909effa81c7cc392`，已离线核验。

第三次试跑保存在 `localsend-script-2026-09-08-pilot-3/`，源码哈希 `dae6bfcd784b5640687f1b8d484e7a47ca857dc8848b133f3593c8b435799578`，用时 93.889 秒。设置和进入 About 已通过；第二次 About ADB swipe 的回执成功，但其后 10 秒的内容与几何保持不变，脚本明确失败而未重试。归档哈希 `39eb71dd1d447fb05e7f94171db068531fe6203720db809032ac0cd0ee154595` 已离线核验。同一页面随后用公开 Intent `scrollBy` 实际向下移动，证据在 `localsend-script-2026-09-08-restore-3/flutter-scroll-probe-manifest.json`。物理手势无位移的具体根因没有被回执证明；修订候选选择已观察到的 Flutter 滚动接口作为主路径，不自动切换执行路线。

第四次核心试跑 `localsend-script-2026-09-08-pilot-4-core/` 用时 52.523 秒，56 条 UI 断言通过，设置与许可证正文、逐级返回、设置滚动位置恢复通过；3 条手机采证断言仍为 inconclusive。这是核心场景的单次试跑，不计入完整场景的三次连续验证。

完整矩阵第一次尝试 `localsend-script-2026-09-08-matrix-1/` 的第一个正向运行在 135.297 秒内完成，Script 自报 121 条 UI 断言通过、9 条手机断言 inconclusive，三次独立设置读数符合预期。但控制器从归档原始树独立检查发现，恢复时“设置、主题、颜色、语言”四项位置整体比初始偏移 5.061754683 个逻辑像素。因此该次明确失败，没有继续运行后续矩阵，也没有算作正向通过。初始标题 top 为 86.095238，恢复检查及随后两个树读数均为 81.033483；原始对照保存在 `settings-geometry-comparison.json`。归档哈希 `83b64612c1f694880d9d12385e72cc152f7c31a5188bc8161ceb93ae9910925e` 已离线核验。独立作者据此将“项目可见”加强为“四项实际边界回到本次初始值”，控制器的 0.5 逻辑像素容差未放宽。

追加 Send 探索与四次夹具恢复的归档也分别复制至 `localsend-script-2026-09-08-probes-offline/`，在禁用 ADB、Host FactStore 不可用的新公开 MCP 进程中全部核验通过。失败尝试和恢复过程的证据均保留。

第二次完整矩阵 `localsend-script-2026-09-08-matrix-2/` 使用源码 `0c0fa510b5d25654402f7001fb1d4e8294aab68f816962e4bd117eb617c6eec6`，三个 acceptance 正向分别在 156.405、191.886、163.216 秒通过 UI、设置读数与精确滚动恢复。随后 core 在 37.810 秒失败：返回 About 后，脚本读取到两次同一个 SDK 转场快照，将部分出屏的返回按钮用于点击，最后仍在 About；错误预期和取消没有运行，该矩阵整体失败。

该 core 的公开载荷序列 126、127 拥有不同 Host observation ID，但 `result.updatedAtMs` 都为 `1788845821033`；返回按钮左界为 `-17.664501953125`，中心仅为 `2.335498`，脚本实际点了物理坐标 `(6,195)`。后续截图和树证明没有到达设置。原始归档哈希 `4df8d200bb2c5534e5fd3cb719f9dda6ab25da0e3ac6cf4aa15ffa1a737c08fe` 与三个成功正向的归档均已离线核验。该发现要求稳定性检查跨越真正更新的 Flutter 快照，并检查完整点击区域，不能把重复读取缓存视为稳定。公开编写契约已补充此边界；下一次矩阵先跑 core，再运行全部三次正向及负向控制，不沿用旧版本通过次数。

另一个缺口保存在 `localsend-script-2026-09-08-restore-2/cursor-gap-probe.json`：先以当前时间窗口获得完整游标，再只用这个游标读取，返回 170 条记录、`hasMore:false`、`capture_gap`；同一游标加上原来的时间下界后，前 170 条记录完全一致，`gap:false`（此时新增数据使 200 条页达到上限，故仍是 partial）。`SegmentedCaptureBackend.lossInsideWindow` 只判断时间/ID 下界，没有使用已发出的序列游标；历史丢失标记因此仍影响新游标窗口。这是独立只读对照与源码定位，本轮没有通过添加时间过滤或清空数据绕过它，也尚未修改、回归该运行时逻辑。

Flutter `actionId` 传递仍有明确源码缺口：Dart `_runAction` 不读取该字段，`recordEvent`/`recordState` 等构造的跨通道载荷不携带该字段，Android Flutter 插件调用 SDK 标量记录接口时没有传递动作上下文。直接 Flutter MCP 命令也没有把 Host 注入的 `runtimeActionId` 合并到 Flutter 请求体。修复必须验证真实动作与实际手机事实的关联，不能全局记住“最近一次动作”来补标历史或并发事件。

## 仍未闭合的验收

受控无 peer 网络夹具、业务语义的手机事件关联、执行中设备动作的取消、真实文件传输及全 App 覆盖仍须单独验证。等待控制器时取消只能证明该等待点之后未执行动作。当前阶段也没有完成 iOS 或四 App 矩阵；iOS 设备可用后应复用同一场景检验平台边界。

上述 matrix-3 之后已完成[Android 采证读取修复与 matrix-4 复验](LOCALSEND_CAPTURE_REPAIR_2026-09-08.md)：当前窗口不再从 epoch 头部逐条读取被过滤的载荷，新 watermark 也能确认历史 loss。相同 v1.0.5 Script 的三次正向分别为 1 分 40.007 秒、1 分 43.217 秒、1 分 38.305 秒；6 轮共 66/66 手机读取页完整，归档和独立设置证据再次通过离线核验。此前的失败均保留，本文件上文仍描述原 APK 的 matrix-3。

当前下一项是 Flutter 动作上下文与真实业务事件关联：matrix-4 的每个完整正向仍有 7 项手机断言 inconclusive。不得把采证缺口改成默认成功、放宽引用校验或增加业务 App 测试专用接口来收口。手机证据链收口后，再用同一场景推进 iOS 实测和既定可靠性关口。
