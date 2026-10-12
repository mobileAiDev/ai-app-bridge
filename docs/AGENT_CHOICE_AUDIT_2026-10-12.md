# AI App Bridge 全项目设计审查与改造记录

日期：2026-10-12。比较基线：`a76302e`。本文描述当前工作区的本地改动，尚未发布；现有已安装 0.4.5 客户端不会自动获得这些行为。

状态：**本轮全项目审查、选定改造与当前环境验证已完成**。此前未落实的 Script 积压/串行、嵌套输出、损坏端点恢复和参考方案采用判断已收尾。交付为本地可审查代码与证据；未发布、未覆盖的实机条件以及后续设计能力分别列明，不计作已通过。

## 判断

项目确实把几类不同的事情混在了一起：环境诊断被用于否决动作、旧动作结果未知被用于阻止新工作、结果清理失败被用于阻止执行、控件的动态属性被当成不可变化的身份。这些设计会扩大局部故障，增加恢复和交互成本。

采用的原则是：Bridge 提供能力、事实、候选、回执和恢复入口，agent 选择目标、策略、是否继续与是否重试。原动作的 unknown 保持 unknown，独立新工作可以继续。真实活跃占用、无法执行的平台操作、错误参数和无法落盘等仍需如实报告，并给适用的下一步。

前台 mismatch 在已发布 0.4.5 已改为 warning；本轮没有把这一旧修复冒充新增功能。历史仍有旧客户端、UIA 局部失败、恢复入口不易发现和跨执行入口限制的问题。

## 审查范围与证据

本次按执行路径审查 CLI/MCP、公共返回、Script、Intent/安装/权限工作流、共享所有权、UIA 的 Java 运行时与 Host 端、Android View、Flutter、iOS Native、H5/Web、恢复和使用文档。不是对全部源文件逐行证明，也不是所有平台的真实设备验收。

- [历史使用审查](HISTORICAL_USAGE_AUDIT_2026-10-12.md)：筛选 1,215 个 Codex 会话索引、282 个 Cursor transcript，保留 22 条原始来源定位。Codex 索引包含 976 个子 agent，会话副本和调用出现数不等于独立故障次数；Cursor 缺失的 tool_result 不作为独立运行结果。
- [同类工具方案](AGENT_TOOLING_REFERENCE_DESIGN_2026-10-12.md)：OpenAI/Anthropic Computer Use、Playwright、Maestro、UI Automator 等官方资料；明确区分上游事实、适配判断、已实现能力与设计示意。
- [本轮设备和输出证据](validation/agent-choice-2026-10-12.json)：独立 API 36 模拟器；未操作现有 OPPO、K2 等实体设备。

## 已落实的改动

| 路径 | 原问题 | 当前行为与选择方式 |
| --- | --- | --- |
| UIA 历史回执 | binding.warnings 不在读取白名单，历史审计导致启动退出 | 读取 warnings 和两代 identityStrength；原回执保持原样 |
| UIA 启动/历史清理 | 损坏或未知旧会话让新 epoch 无法建立 | 历史保留并报告维护 warning；真实锁或落盘错误仍返回失败 |
| UIA 恢复 | stale runtime.json/转发与死进程需要内部操作 | 新观察无法连接时检查实际进程锁，锁释放后重建；公开 `uia-runtime force-reset` 归档重置，原动作不重放 |
| UIA 观察 | 无焦点、某个 root/child 不可读、动画不 idle 导致整树失败 | 返回可读窗口/节点与 partial/warnings；缩短 idle 等待；返回的引用仍可选择 |
| UIA 引用点击 | 文本/位置/状态变化和重复语义匹配导致同一节点失效 | 对明确 ref 验证原连接/窗口/节点和当前可操作性；属性变化给 before/current warning；语义 selector 仍验证当前匹配 |
| 跨 provider 选择 | 不唯一只报错，没有选中手段 | 返回完整候选、状态、bounds 和实际 ref/selector；公共提示展示短预览并可分页读原响应，Web 另支持匹配后分页观察；UIA 可直接选第二个按钮 |
| Android/Flutter 引用 | Native 无 viewId 选择；同一 View 属性变化也拒绝；Flutter 截断树即使已有 nodeId 也拒绝 | Native 支持 viewId、组合/范围查询；同 View 属性/祖先变化给 warning，显式查询条件在 SDK 动作时校验；Host 不再重复读树。Flutter 允许已返回 nodeId，仍验证原 Element 和当前状态 |
| Script 能力 | 默认类别限制和永久拒绝 eval/转发等 | 默认开放所有已支持类别；显式 permissions 才收窄。副作用 logcat/诊断脚本属于 app.expert，尊重显式只读声明 |
| Script 设备目标 | 设备命令也强制包名 | Android Script 可只设置 serial；需要 App 的命令再要求 packageName；显式 target 与参数冲突仍给明确错误 |
| Script unknown | 一个未知动作挡住之后的读取、动作和 checkpoint | 源码可处理结果并继续；显式新 checkpoint 可以越过旧 unknown；重启按最新边界恢复，旧回执不改成成功；持久化错误和未返回的活跃调用仍明确失败 |
| Intent | 默认 autonomous 只准 tap；unknown 提前终止选择循环 | 默认允许所选 provider 支持的动作；显式 allowlist 收窄；已持久化 unknown 回到 waiting_for_decision，保留 lastAction，等待新决策 |
| 安装 Intent | UI 动作出错会自动取消安装，动作种类额外受限 | UI 失败保留诊断供 agent 决策，安装任务不因此自动取消；使用通用 UIA 动作合同 |
| 权限弹窗 Intent | 只接受 tap / dismiss Back；提示被外层丢弃，指定按键会被改成 Back | 复用 UIA tap/scroll/back/keyevent；允许 agent 结束为 fail/inconclusive；保留简短提示和可执行 observe/cancel 请求；授权结果仍由独立状态核验 |
| H5/Web 大页面与动态属性 | H5 超过 5,000、Web 超过 1,000 控件即拒绝；同一 DOM 节点改标签也失效 | 已观察 ID 不再被控件数限制；Web 直接定位已知 ID；同一节点属性变化给 warning；页面切换/节点替换仍要求新观察；selector 可组合属性 |
| 共享所有权 | Host 已死后 unknown 永久占用设备 | 活跃锁仍串行；旧记录先同步归档，再允许新显式操作，报告 previous_execution_unknown；status 区分 active/unresolved |
| 归档后的恢复 | 新工作覆盖旧 pending 会令强停/迟到回执找不到原动作 | force-stop 查历史归档；公开 archives/archive/reconcile-archive/delete-archive，保留原字节并单独记录原动作查询证明；Web 迟到 completion 可以保存和 ACK |
| 回执 ACK 容量 | 八条清理积压就禁止新 UIA 动作；满 epoch 不给重新开始 | 满队列归档并给 warning；全终态 epoch 可以轮换，未确认回执保留。已绑定动作不会偷偷换 epoch |
| ADB 统一入口 | 安装、传输、系统诊断需绕出 Bridge | `adb-exec` 接受 argv；stdout/stderr/exitCode、超时、binary outFile、Script 调用；不使用 Host shell，不设子命令白名单 |
| 可恢复错误 | 只给码，或给不适用的重启建议 | 对候选、旧引用、UIA 离线、占用和版本错配给短说明及合法下一步；旧 client 不再收到“重启较新 Runtime”的建议 |
| 默认输出 | 必填 extract 要求 agent 提前猜格式；8 KiB 概览又制造补读 | 预算内完整交付，重复字段无损表格化，仍超预算才给实际记录/文本范围和 ref；支持原始路径 select，显式 null 保留原始形状 |
| 日志筛选 | 历史把 A\|B 当正则得到空串；非 threadtime 文本被丢掉 | 显式 grepMode，正则在有时限的独立 worker 匹配；普通文本也可筛选；缺 PID/格式字段会说明原因；过滤失败保留原文；补读提示不重复 clear |

选择失败仍是 `ok:false, dispatched:false`，并带 `selectionRequired/candidates/guidance`；它是一次未选定目标的调用，不是无法继续的工作流。工具不会静默把两个同名按钮的第一个当成用户意图。

## 输出设计：尽量一次给够，减少重复结构

后续真实调用审查否定了“超过 8 KiB 就给概览”的初稿。25,845 份可完整计量的归档响应中，9,231 份超过 8 KiB；UIA 页面观察超过比例约 83%，Intent 约 86%。只统计对话中尚未被截断的小回包会误判其可用性。

auto 现在以完整回包预算为交付边界，默认 96 KiB。超过 32 KiB 的 JSON 在节省至少 30% 时可返回完整无损表格；超预算也先尝试无损表示。节点、字段、状态、顺序和重复项均可从首个回复还原。仍放不下时才返回部分视图，优先提供预算内完整记录或较长首尾文本，附来源偏移、字段事实和按当前原文大小生成的读取请求。

POS 大页面单独检查，77 份保存页面树均能首轮完整交付；没有用大量小动作回执掩盖其问题。`read` 是可选入口，agent 已获得所需事实时直接继续。已知所需信息时仍使用 select、regex/JS/Python；`extract:null` 保持原始形状。更多见[公开输出合同](../desktop/ai-app-bridge-cli/docs/RESPONSE_EXTRACTION.md)。

先前 300 条合成样本的 97,992 → 2,543 bytes 只证明概览变小，不能证明少一次调用；它不再作为 auto 默认值合理性的依据。本次采用原始存档和历史工具调用回放检验实际完整交付与字段还原，未重放原设备动作。样本口径、分组数据、完整交付比例及限制见 [auto 真实调用审查](RESPONSE_DELIVERY_AUDIT_2026-10-12.md)。

## 继续优化的方案

以下逐项区分已实现、已验证和仍待落实的内容：

1. **统一诊断与恢复导航，已实现**：doctor 聚合 client/runtime 身份、设备活性、占用、转发、前台/锁屏指示和独立 SDK/UIA/WDA/Web 路径；CLI/MCP 可在 Runtime 停止、版本不一致或配置损坏时本地诊断。正常动作不重复探测，结果无总 ready 闸门，建议不自动执行。Script 也可调用。Android 模拟器已验证 SDK 不可用而 UIA 仍可用；iOS 的独立路径目前为协议验证。
2. **目标查询更丰富，已实现并完成 Android 模拟器验证**：Native/UIA 可组合 text、显式 textContains、contentDescription、resourceName、className 和布尔状态；within 可直接选容器，也可由行标签找 ancestor/parent。范围可以有多个匹配，只要求最终目标唯一。Native 对同一个 View 的属性/祖先 guard 变化给 warning，显式 selector 条件仍在 SDK UI 线程校验；真正换 View/window/runtime 不能冒充原目标。UIA 组合条件筛选观察后绑定原 nodeRef，当前属性变化由运行时报告。Native 普通命令从两次 Host 树采集减为一次，Intent 直接使用已提交观察，设备端仍原子校验。模拟器验证了说明文字/两个同意按钮、不同账户行、重复容器、动态文字和真实 View 替换。序号采用“从当前候选数组取第 N 项的实际 viewId/targetRef”；不新增跨观察裸 index。邻近标签采用显式祖先关系，不猜最近文字；上下左右几何关系保留为后续候选方案。
3. **权限弹窗跨设备验收**：多余动作限制和丢失提示已修复，受控契约测试覆盖滚动、指定按键、Back、主动结束及独立授权核验。不同 OEM 弹窗与真实设备仍未在本批验收；不能把 Host 测试计作实机通过。
4. **更少往返，已提供基础配方**：script recipes 通过 CLI/MCP 本地返回目录、可编辑 JS 和 start 请求；android-launch-and-wait 一次启动并复用 wait-text 等待条件。普通源码可顺序调用并在组末观察；既有 wait 按事件/状态变化返回，终态带 resultRef。真实模拟器暴露一份 177,258 bytes 的最终值，主要是重复 dumpsys；该可编辑配方保留回执、条件、时间、窗口身份及警告后为 11,689 bytes，可选 fullResult 返回原始诊断。未另起 DSL，也未把这个配方的投影强加给所有命令。
5. **候选与证据按需浏览，部分已实现**：Host 不再丢弃第 21 个之后的候选，短预览之外可按返回 read 分页读取同一原响应，页数按字节预算调整；Web 增加 query/offset/maxControls，真实 Chrome 已从 65 个同名按钮中分页选中第 45 个。按字段/子树 select 已存在。采用判断已记录在同类工具方案：首次调用优先完整结果，索引随必要的部分预览给出；不新增隐式增量基线或跨平台区域协议。Native/UIA 源头子树和区域截图保留为独立后续能力，不计作已交付；当前 auto 减少交付成本，不减少设备采集。Native 本批独立去掉一次冗余采集。另发现两个便利 text 入口仍 slice(0,20)，现已保留全部候选，并验证可选择第 45 项。
6. **测试会话便利层，已实现并验证恢复**：android-test-session 在写设置前保存 serial、Android user 和原值；可选供电保持唤醒、默认旋转、IME/硬键盘显示及唤醒屏幕。恢复可在另一个 Script 执行，原值为空时恢复为空，已恢复项不再写；中断/未知回执测试通过。模拟器实际修改设置、恢复，并独立读回 7 个记录值一致；本轮未实际切换多个 IME，组件/子类型恢复由受控测试覆盖。锁屏诊断只提供事实，wake 不冒充完成凭据解锁。
7. **长期归档管理，本地实现已验证**：archives 按 actionId 筛选/游标分页；archive 保留原 journal；reconcile-archive 用 entryId 查询原动作，不取消、不重放、不清理手机回执、不取得当前设备的动作锁；证明单独绑定原归档校验和保存，终态证明可直接复用。Android Native/H5/Flutter SDK 增加只读 query；旧 SDK 返回更新说明，UIA/安装/shell 使用原有只读协议。CLI/MCP 可在共享 Runtime 不运行时使用归档入口；默认保留，显式 delete-archive 删除指定本地记录。普通 reconcile 仍可能请求取消，文档明确区分。Native 新 SDK 查询已在隔离模拟器从真实 SDK 取回原点击回执，并验证第二次读缓存及原归档字节不变；本地 unknown 归档外壳为受控夹具，没有实际杀进程制造未知。H5/Flutter 查询及实体设备仍为待验收范围。
8. **跨平台验证**：Web 已增加隔离真实 Chrome 的 12 项验证，包括 6,000 控件页面、同一节点改标签、组合条件、替换/导航、焦点、遮挡和滚动。iOS/原生 WebView 仍主要是 Host/renderer 协议测试，后续需要 iPhone、不同 OEM 与复杂页面验收；不能从 Chrome 或 Android 模拟器结果推断这些场景已通过。
9. **日志筛选已落地**：`grepMode:"literal"|"regex"`、原始文本过滤、堆栈行命中、格式/PID 诊断、不会重复 clear 的简短提示均已实现；病态正则在 worker 超时，Host 继续响应且保留采集文本。历史中的空筛选结果仍不能反推原日志大小。

10. **Intent/Script 组合能力已实现**：Script catalog 开放全部已登记命令，默认类别包括 app.workflow、evidence.read；显式 permissions 才收窄。Intent 新增 command action，可调用 Bridge、包装 ADB、另一个 Intent 或 Script，也能在首次观察失败时执行修复命令。Android device target 可只给 serial；iOS Script 设备命令可省略 bundleId。使用同一 Host 内的路由，避免递归 MCP、外层设备锁和错误 requestId 注入；子任务拥有独立生命周期、目标和原始 operationId。组合入口默认后台启动 Intent，直接 CLI/MCP start 保持原默认；intent wait 按事件等待。自取消与自等待不会等待自己的当前调用排空。
11. **命令结果与观察成本已优化**：Intent command 默认直接返回 lastAction.result，显式 observeAfter:true 才重读页面；uiObservation 标明旧树是否过时。原始结果在 value 中保留一次，control.lastAction 只保留续跑字段和 JSON Pointer。模拟器 6 次同一只读 ADB 查询中，不附加观察约 49–51 ms，附加观察约 481–491 ms；这是单一流程的局部测量。后续增加 v2 完整表示，共享相同长诊断文本并保留各处原始路径。45 份真实公开回包全部首轮完整；原来需补读的 161,711 字节嵌套结果降为 72,198 字节并逐字段还原一致。
12. **工作流与 Host 恢复已实现**：普通命令失败、unknown、初始 UIA 观察失败保留当前 Intent，agent 可给新决定；托管权限流程也不会因诊断读取或一次已知失败就终止。runtime status/stop/force-stop 不被代码或配置版本核对挡住；正常 stop 有界等待，强停由独立进程处理并保存结果文件，保留已派发动作 unknown。controller 自身抛错也写出终态错误及状态查询提示。Host 在初始化服务前另存 owner.json；端点损坏/丢失时可据独立身份强停，两份记录都坏时给 OS 检查短命令和显式 ownerPid 入口。无关进程拒绝，坏字节归档，锁已释放时显式 start 可自动归档旧元数据重新开始；保持 SQLite 锁 inode。四类恢复及公开 CLI 选择 PID 已实测通过。
13. **只读等待与源头覆盖已实现并完成本批验收**：wait-text 在原 deadline 内继续读，保留次数、耗时和最后 provider 原因；未命中的文本轮询不再反复做两次前台探测，非必需前台探测另有短预算。Native SDK 去掉 Activity 根树二次遍历；compact Native 也只遍历 windows 一次，保留 viewId/targetRef、状态和截断标记。Native 深度/长文本、Flutter 长标签、UIA 缺失根节点均报告源头范围；Intent summary 和 compact tree 将 source/projection 分开。完整标签的正向匹配可使用部分树，精确匹配不会把截断前缀当完整标签。absentText 默认要求该 provider 完整范围，也可选择 absenceScope:observed 验证返回的部分；该选择及 partial/unknown 保留在回包。Flutter 部分树的文字查询提供可选 nodeId。最终真实 XML 回放又确认并修复 UIA visibleOnly 将首个状态栏窗口当整屏的错误；过滤使用各自窗口范围和 provider 的可见性，保留隐藏节点事实。Native compact 也不再将 provider 失败包装成成功空树。

14. **Script 排队与执行效率已实现**：32 条在途请求成为流控窗口，后续请求排队；Host 按管道背压读取，不因普通积压结束进程。独立读取可 Promise.all 并行，写操作、断言、检查点和 agent 问题保持前后顺序；返回前排空已提交调用。Python 正常调用不再前后各查一次控制状态，暂停由 Host 和带控制状态的回复共同处理。重复 paused 回复不会使 JS SDK 的等待循环自旋。256 个读取、1,001 帧管道、未 await 的队列、暂停恢复、取消与持久化边界已有回归。

**本轮收尾状态**：上述已确认缺口、整体功能/串行性能及全新安装包验证均完成。不同 OEM、iPhone、原生 WebView/Flutter 原动作查询保留明确实机未验收边界；几何邻近、全平台增量/区域采集属于后续方案，不算当前能力。整体目标按“当前可实施改造和验证、明确剩余条件与方案边界”的范围完成。

## 验证记录

- Java：UIA 50 项、Android SDK 388 项通过；UIA 运行包已重新构建并更新随包 manifest。
- Flutter：32 项 execution target widget 测试通过，包括 650 个控件的截断观察里选择已返回 nodeId 并实际触发动作。
- Android API 36 模拟器：同意按钮与长说明区分；两个同名按钮返回合法选择命令；第二按钮实际 UI 变化；移动控件引用点击；公开 force-reset；杀掉 UIA 后由新观察恢复且没有重放旧动作。
- Node：完整功能组 1,422 项通过（4 并发），串行性能组 50 项通过。默认高并发全量测试曾出现两个进程/等待时间窗的超时；没有为通过测试放宽产品时间限制。
- 随包 UIA jar 与 12 个来源文件哈希一致；四份 H5 renderer 生成副本一致；两份使用技能一致，diff 无空白错误。全新 tarball 安装验证通过：受控 ADB、公开 MCP、npx 首次/重复启动、Script、提取、重连与 Runtime 收尾均通过；这不替代真实设备业务验收。

后续批次的验证记录独立保存，避免覆盖上面首次设备验收的时间与范围：auto 见 [response-delivery](validation/response-delivery-2026-10-12.json)，权限/H5/Web/日志改动见 [agent-choice-followup](validation/agent-choice-followup-2026-10-12.json)。后者完整 Node 功能组 1,440 项、Web SDK 26 项、真实 Chrome 11 项及 Android SDK debug/release 388 项通过；末次提示变更另外做 23 项定向验证。全新安装包通过，公开 MCP 实际执行包内正则 worker，并确认错误正则未发出清日志命令。

候选/归档后续批次见 [agent-choice-archives](validation/agent-choice-archives-2026-10-12.json)：完整 Node 功能组 1,451 项通过，最后增加的长候选/损坏归档用例在 12 项定向组通过，串行性能 50 项、文档/合同 24 项、Web SDK 27 项、真实 Chrome 12 项、Android SDK 196 debug + 196 release 项通过。全新安装包通过，并实际从已安装包的 MCP 列出/删除归档、CLI 读取原记录。原 28,760 份响应表示重新回放，完整性与首次交付分类未改变。另统计当前 Host 的 47 份 ownership 归档，最大 4,690 bytes，无一超过 96 KiB；这个小样本不代表所有未来归档。

诊断/配方批次见 [agent-choice-diagnosis-recipes](validation/agent-choice-diagnosis-recipes-2026-10-12.json)：完整功能组 1,472 项通过，最后的只读 Web 状态/目标归属修正由 84 项定向组验证，元数据另有 28 项合同验证；文档 18 项通过。性能首轮 49/50 通过，JS 握手 p95 为 199 ms 超过 150 ms；相同源码和阈值的独立复测 3 项通过，JS p95 为 82 ms，保留首轮失败而不写成干净的 50/50。全新安装包通过，23 份已安装源码/文档与仓库逐字节一致。隔离 API 36 模拟器验证了无 SDK 时独立 UIA 路径、设置准备/恢复、启动并条件等待；临时 AVD 已移除。整体 goal 仍为进行中。

组合定位批次见 [agent-choice-selectors](validation/agent-choice-selectors-2026-10-12.json)：完整功能组 1,488 项、串行性能 50 项、文档/合同 29 项、Android SDK 198 debug + 198 release 项通过。隔离模拟器验证 Native/UIA 组合条件、邻近标签与多容器范围、同 View 动态属性 warning、真实 View 替换不误点击，以及真实 Native 原动作查询；查询回执哈希与原点击回执一致。新安装 APK 哈希一致，临时 AVD 已清理。全新 npm 安装包通过，175 份已安装代码/文档/技能/配方与仓库逐字节一致，安装包的公开 MCP 发现也接受组合查询。新流程 29 份完整公开 envelope 在默认 auto 回放为 25 inline + 4 完整表格，无部分预览。初次测试中仍依赖旧契约的断言及验证脚本目录遗漏均保留在批次报告，不计为产品通过证据。该批次结束时整体 goal 仍进行中。

工作流组合批次见 [agent-choice-workflow-composition](validation/agent-choice-workflow-composition-2026-10-12.json)：Script → 托管安装 → Intent → ADB/Bridge/子 Script 的模拟器链路通过，单步失败后原 Intent 继续，后台启动、按事件等待、自取消、强停控制器及旧运行时版本下的恢复均有定向验证。命令默认不额外观察的局部效率样本及 44/45 首次完整 auto 回包保留原始记录。

观察与恢复批次见 [agent-choice-observation-recovery](validation/agent-choice-observation-recovery-2026-10-12.json)：完整功能组 1517 项、串行性能组 50 项通过；最后的 compact UIA 可见性修正另通过 102 项定向回归及真实 XML 重放。Android SDK 199 debug + 199 release 项、UIA Java 50 项、Flutter widget 33 项通过。模拟器证明 Native 29 个节点只采集一次、307 单元文本的预览不冒充完整标签、部分树无法证明完整范围的缺失、agent 仍可选择观察范围或继续点击，页面清理后完整范围断言可通过。该流程 13 份回包默认 auto 全部首次完整返回。首轮夹具标题被状态栏覆盖、首轮高并发测试的三个时限断言失败及父测试计数均保留；同代码 85 项串行复测通过，随后完整组改为 2 并发通过，没有放宽产品时限。

最终全新安装包验证通过，194 份代码/运行包/文档/技能/配方与工作区逐字节一致；安装包发现 125 条命令均可从 Script 使用，并实际验证新 Intent/wait/absenceScope schema、离线 force-stop 和多窗口可见性处理。UIA 新运行包与 12 个来源哈希一致，4 份 H5 生成副本及 2 份使用技能一致。临时模拟器已结束并移除 AVD，实体设备未操作。该批次结束时整体 goal 仍为 active；后续收尾结果见下节。
本轮没有发布 npm/SDK、升级全局安装或推动 Git 远端。修改包括 Node 行为、设备 Java bundle 和 Flutter SDK，发布时需配套版本与客户端重连验证；当前提供的是可审查的本地实现和设计方案。

## 最终收尾：调度、恢复与组合接口

证据见 [agent-choice-scheduling-recovery](validation/agent-choice-scheduling-recovery-2026-10-12.json)。最终完整功能组 1534/1534、串行性能 50/50 通过。安装包补充回归发现并修复 runtime status 在 Script 内返回诊断结构的问题；start/status 现在与 CLI/MCP 共用命令合同，实际公开 Script 并发 64 次查询结果一致。stop/force-stop 的自停止接收回执仍按明确的控制请求合同返回。

受控 Host 每次只读延迟 20 ms，64 次调用三轮中位数从 1489.1 ms（顺序）降为 125.5 ms（并行），约 11.87 倍。它验证调度能力，不代表所有手机操作的提速。Python 50 条命令加 1 条 progress 实际产生 51 个请求、0 个隐式 control-point。

最终安装包 SHA-256：`50d09fc871062d57914033ba63e9e3723d3df9ff7c4548714e820e4cb9ef749e`。194 份已安装文件逐字节一致，125 条命令支持 Script；公开 MCP 的 64 条并发调用、坏端点诊断/独立身份强停/保留坏字节/重启、安装包 v2 完整输出均通过。所有调用和历史回放的失败记录保留，未放宽产品时间预算。临时测试 Host 已关闭，原实体设备未操作。
