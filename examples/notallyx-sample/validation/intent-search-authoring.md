# 独立 Script 编写记录

交付 `search-regression.js`，CommonJS 导出 `async main(ctx)`。只依据冻结包编写；没有运行该入口，没有操作设备，没有读取 Bridge/App 实现、旧回归 Script、私有助手、memory 或其他任务。

## 时间与中断

- 首个保留下来的编写时钟：`2026-09-07T12:50:20.387Z`。此前已开始读取 HANDOFF；第一次读取的精确时刻未记录，不能把该时钟冒充首次读取时间。
- 中断前最后保留的工作时钟：`2026-09-07T12:58:14.508Z`；当时只创建了输出目录。
- 父控制器告知上一轮发生 transport/stream 连接错误。恢复时钟：`2026-09-07T21:17:27.895Z`，检查输出目录为空，未重做已完成的材料分析。
- `2026-09-07T21:23:24.754Z`：第一次语法检查通过，并完成 29 个冻结 raw observation 的离线解释检查。
- `2026-09-07T21:25:33.869Z`：完成 11 项离线数据检查，均符合包内记录。
- 交付结束：`2026-09-07T21:27:58.686Z`。上述跨越连接中断的墙钟时间不能作为持续编写耗时；中断的精确发生时刻不可得。

## 读取材料

根目录始终为 `writer-bundle-v1/`。`manifest.json` 的 SHA256 已核对为 `2225727647760f6a3131789e512371413baed63f63d6b8cb5b1d3d925d43b490`；没有声称重新校验全部载荷文件。

内容读取的精确相对路径：

- `HANDOFF.md`
- `manifest.json`、`inputs.json`、`fixture-summary.json`、`capabilities.json`、`provenance.json`、`timeline.json`
- `public-docs/SCRIPT_AUTHORING.md`：全文；`public-docs/CLI_README.md`：关键词搜索及 149–241、291–309 行；`public-docs/INTENT_FOREGROUND.md`、`public-docs/INTENT_NATIVE_EDITING.md`：仅关键词搜索命中内容。没有跟随这些文档指向包外的链接。
- `durable/intent.json`、`durable/intent-title-review.json`：读取 JSON，提取原始树、窗口、动作、回执、决策及修订；后续离线检查仍使用这两份文件。
- `verification/observed-outcomes.json`、`verification/data-invariance.json`
- `captures/intent/003-initial-status.json`
- `captures/intent/022-body-page1-tree.json`
- `captures/intent/025-body-page2-tree.json`
- `captures/intent/033-body-top-final-tree.json`
- `captures/intent/037-empty-tree.json`
- `captures/intent/041-clear-tree.json`
- `captures/intent/045-home-return-tree.json`
- `captures/intent/050-keyboard-state-capabilities.json`
- `captures/intent-title-review/008-title-full-tree.json`
- `captures/intent-title-review/011-title-scroll-tree.json`

实际查看的截图：`captures/intent/body-top.png`、`captures/intent/body-top-final.png`、`captures/intent/body-page2.png`、`captures/intent/empty.png`、`captures/intent/clear.png`、`captures/intent-title-review/title-full.png`。查看工具将 1080×2414 图像缩放显示为 916×2048；坐标分析使用原始树的像素值。

另用 `rg --files` 枚举过包内文件名，未因此读取其余文件正文。编写后读取本输出目录中的交付源码进行语法与离线检查。使用 Node 内置 `fs/path/crypto/vm`，没有额外依赖、skill、子代理或设备工具。向父控制器报告了接口缺口；父控制器只要求继续按冻结包处理，未提供实现细节。

## 输入与运行契约

- Script spec 使用 `aab.code-script/v1`、`language: javascript`、`entrypoint: main`，权限仅需 `app.read`、`app.interact`，`restartPolicy: none`。建议外部总超时至少 180000 ms；内部每次状态等待上限 12000 ms，每个滚动方向上限 8 次。
- 由 spec 注入冻结目标：`FYZLAU49X8OVQGJ7` / `io.github.mobileaidev.notallyx.sample`。设备调用不另设 serial，不读取未公开的 `ctx.target`。源码中的身份常量用于核对公开 status 字段与定位资源。
- `ctx.inputs.out` 必须是绝对路径，目录不存在或为空。拒绝覆盖既有运行结果。
- `ctx.inputs.expected.title/body/empty` 各含非空 `query` 与无重复字符串数组 `titles`；标题集合要求 1 个、正文集合要求多于 1 个、空结果集合要求 0 个。查询与业务标题没有从包内硬编码进源码。
- 该实验沿用冻结的“完整唯一标题作为查询”语义；不是任意标题子串搜索器。错误期望试验只改变 `expected.title.titles`，真实 query 保持不变。
- `cancelAfterTitle` 必须显式为布尔值。true 时，标题证据与断言写盘后严格依次 `ctx.progress({phase:'title-complete'})`、`await ctx.askAgent({question:'intent-reuse cancellation checkpoint'})`。此分支即使意外收到恢复决定也抛错，不能派发正文动作。false 时没有 Agent 决策请求。

## 定位、等待与断言

使用 raw tree 的 `windows[0].root`，要求单个 index 0 的 activity 窗口，不合并重复顶层 `root`。字段与窗口不符时报告接口缺口，不尝试替代结构。空输入必须是节点明确具有 `text: ''`；null 或缺失不会被转换为空。

控件来自观察到的 `contentDescription`（搜索、取消）及完整 `resourceName`（EnterSearchKeyword、MainListView、Title、ImageView）。每次动作前重新保存 status、带 package 验证的 screenshot、键盘原始响应与 raw tree，再核对唯一可见定位、enabled、祖先边界。输入还要求 `editable: true`。坐标取当前节点中心；滑动取当前列表可见范围内的 20%–80%，不会从固定工具栏开始。没有不确定动作的重试或替代动作路径。

结果标题必须完整落在列表、祖先与窗口交集内，且不被列表外可点击控件遮住，才计入跨页可读集合。每个结果页先提交当前 tree 的设备断言，再允许下一次动作；被裁剪标题保留在页面说明中，但不计入可读集合。跨页并集、移动比较和滚动末端推断使用 code scope，保存参与页面路径。

等待要求明确状态和两次相同的新树；150 ms 仅为轮询节奏。标题等待依据真实 query 出现且旧标题消失，独立于被注入的期望标题，因此错误期望会在 `title.filtered-set-equality` 得到当前树证据下的失败并停止。正文等待排除唯一标题阶段的旧单项结果。空结果同时要求准确 query、零标题与可见 Background 插图。清空要求明确空字符串与笔记恢复，随后核对初始可读笔记中的前两个锚点，再退出到首页。

主要断言名称：

- `inputs.explicit-contract`，`*.target-status-fields`（code），`*.current-locator`（device）
- `home.ready-and-query-not-on-first-screen`，`search.open-with-explicit-empty-input`
- `title.filtered-set-equality`，`title-full.query-viewport-and-results`，`title.short-card-fits-full-viewport`，`title-after-scroll.query-viewport-and-results`
- `title.short-list-unchanged-after-in-list-swipe`（code）
- 每个正文页 `body-*.query-viewport-and-results`，`body.top-heading-visible`，`body-later-*.terminal-card-fits`
- `*-earlier-*.list-moved`、`body.settled-end-geometry`、`body.reached-observed-end-within-bound`、`body.cross-page-set-equality`（均为 code）
- `empty.query-zero-titles-and-illustration`，`clear-*.explicit-empty-input-and-restored-results`，`clear.top-heading-visible`，`clear.baseline-note-anchors-restored`
- `home.search-closed-and-baseline-notes-restored`
- `*.png-file`、`*.capture-bounds`（文件与尺寸的 code 检查）；失败时 `*.observable-deadline` 或 `*.stable-around-screenshot` 保留当前设备证据。

## 输出与未解决限制

每次运行写入 `inputs.json`、持续更新的 `summary.json`、`calls/`（请求与完整返回 envelope）、`pages/`（截图/树/键盘调用关联及可读/裁剪标题）、`screenshots/`、`assertions/`、`actions/`（派发前依据），正文另外写 `body-union.json`。取消分支提前写 `cancellation-checkpoint.json`。失败不清理这些文件；SDK 抛出时单独保存 `.error.json`。

1. **keyboard-state 缺少公开响应 schema 或实际响应样例。**源码保存其完整 envelope，不猜测 shown/visible 等字段，也不声称直接断言键盘布尔状态。列表恢复至本次冷启动首页的底边与宽度被单独断言；截图和键盘实际状态仍须控制器核对。`ui-assertions-passed` 不能关闭该验证缺口。
2. **raw tree 的 Script 返回结构是依据公开接口和 Intent 原始观察作出的接口推断。**能力表支持 `compact:false`；源码要求结果直接具有观察到的 `windows` 结构。status 同理要求公开普通结果的 `_feedback.target` 仍保留在 Script envelope 的 `result` 内。若真实返回不同，立即暴露缺口，不探查实现或兼容替代字段。
3. **无显式滚动范围/到达末端指标。**顶部依靠记录中的“已置顶”标题；底部依靠有效列表内手势后稳定几何不再变化，同时最终卡片完整落入可见范围。该推断依赖冻结布局与夹具；不是对所有 RecyclerView 的通用末端证明。所有移动与并集比较按 code scope 记录。
4. **截图不是原子证据。**源码用截图前后的相同树减少过渡风险，不将 PNG 存在或尺寸正确说成视觉内容验收；各页 screenshot 与 tree 供控制器检查。
5. **外部验收仍未执行。**APK SHA、数据库与偏好零差异由控制器验证；清空阶段证明空输入与可见笔记锚点恢复，不声称已遍历恢复后的全部 10 条记录。进程若被强制终止，本地 summary 可能停留在 cancellation-checkpoint，最终取消状态必须以控制器保存的 Host 事件为准。

本地验证仅包含 Node 语法检查和冻结数据分析：29 个原始 observation 可解释；11 项局部检查涵盖补查旧结果排除、真实标题、无移动短列表、裁剪排除、正文两页并集、空结果过渡、显式空输入恢复和首页。没有运行 `main`，没有正向、错误期望或取消的设备试验结果。

最终 source SHA256：`3f9864d958843f4f189f761535cfcf7f34f185ce6eaafb47fc52cc24f6e50877`。控制器应自行复核并冻结后执行全部试验；当前文档不是设备通过报告。
