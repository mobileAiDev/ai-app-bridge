# 第二轮意见复核与方案调整 · 2026-10-14

2026-10-15 补充：[后续意见完整复核](OPTIMIZATION_SECOND_FOLLOWUP_REVIEW_2026-10-15.md)逐条检查了新意见的29项结论，包括后半段的六个后置方向、多设备、探索导出和大型App覆盖；补正profile仍需SDK显式支持、耗时包含关系和噪声归因，并区分0.4.9交付与未实施候选。下文保留本轮历史实验口径。

这份意见找到了值得修正的重点：**ownership 持久化应提前，延迟对照应补齐，模拟器截图有实际收益，跨时钟过滤存在真实问题。** 它对录屏和 Memos 实验范围的质疑也成立。但“只有派发前一次同步就能维持全部现有恢复合同”“29 秒扣掉 13 秒就是纯工具时间”“已经可以到 22 秒”仍不能采纳为事实。

后续动态测试 App 的最新结果见 [Meituan 流程验证](MEITUAN_SCALE_OPTIMIZATION_VALIDATION_2026-10-14.md)：30 轮独立业务核验通过，新增 ownership 窄去重约省 3%；四项 Host 实验仍有约 28–32% 的整段收益。快速截图后立即离开 H5 会暴露 DOM 与实际绘制的时序差异，因此下文 F21 的静态原语收益继续成立，默认切换则暂缓。不是要求真机与模拟器像素完全相同，也未证明 console 取错帧。新发现的 URL 持久化改写导致 Script 哈希不匹配，单独按恢复缺陷修复和验收。

这是对[57 项主审查](/Users/macbook/.codex/worktrees/proposal-evaluation/ai-app-bridge/docs/OPTIMIZATION_PROPOSAL_REVIEW_2026-10-13.md)的补充，不把已完成的评估改写成全部产品实现完成。美团、抖音与大型测试 App 按用户分工由其他 agent 继续，本轮没有接管；没有使用 K2、发布包、升级全局 CLI 或修改其他工作树。

## 本轮真正测了什么

- 同一个 Android 模拟器 `emulator-5564`，现有 Native/H5 fixture，冻结同一份含 SKU checked 就绪条件的作者脚本；baseline 与四项 Host 实验全开候选交错执行，后端分别配置 0 / 200 ms。
- 每个完整样本包含三段交易：普通、价格变更、支付提交后丢响应再查询退款；60 个业务 API、109 次点击/输入/H5 操作、3 次 launch、18 张 PNG、15 条独立账本断言。作者观察次数可随就绪变化，不强制假造相同命令数。
- **13 次尝试：首轮 baseline 超时失败；保留原未知结果并恢复后，12 次新的独立运行全部通过，共 36 段交易、180 条账本断言。** 首轮已通过的两段保留但不并入完整成功率或速度中位数。
- 实际 ownership JSON 提交、JS `fsyncSync`、native FactStore append、FactStore record 分层计时；同一探针用于两臂。另有 11 组私有存储/进程故障实验、8 对静态截图、10 次时钟采样、真实 SDK 历史日志过滤对照和历史 Memos 请求复算。
- 全程保留 `caffeinate -di` 防系统/显示器休眠。另一个测试模拟器在同一 Mac 上工作；4 个成功样本仍记录到短时 App Nap。未把防休眠等同为禁用 App Nap，也未因环境信息拒绝流程执行。所有样本和活跃子集同时列出；不是独占压测，不报告 P95 或普遍倍数。

[预先冻结的矩阵与作者哈希](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/plan.json)、[探针](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/storage-trace.cjs)、[完整结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/results.json)、[复算程序](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/analyze.py)、[首轮失败后的新场景说明](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/series-amendment.json)。探针只存命令类型与计时，缓冲到进程退出再输出；没有取消 fsync、缩减截图、略过账本或改写动作结果。

## 新的完整流程结果

单位为秒。`uiMs` 从 Script 提交到完成，包含 App/网络/等待/截图，不含模型编写和独立 Host 启动；ownership 与 FactStore 列为该组包含时间的中位数，**不是互相可随意相加或全部可删除的纯浪费**。

| Host | 后端配置 | 三次完整流程 | 流程中位 | ownership 写入中位 | FactStore record 中位 |
|---|---|---|---:|---:|---:|
| baseline | 200 ms | 48.015, 43.377, 45.195 | 45.195 | 4.228 | 0.221 |
| baseline | 0 ms | 36.422, 32.931, 35.807 | 35.807 | 4.161 | 0.199 |
| candidate | 200 ms | 29.710, 29.791, 30.333 | 29.791 | 4.357 | 0.274 |
| candidate | 0 ms | 18.662, 17.305, 18.239 | 18.239 | 4.328 | 0.273 |

其中四项实验包括减少参考前台信息和轻量截图归属探测，**不能描述成同等诊断证据下的透明提速**。这次确认的性能方向与前轮一致，但数值属于当前冻结原型、当前 App 和共享主机；不是已发布 0.4.8 新增的收益。

只看未记录 App Nap、显示器活跃的子集（每格仅两次）：

| 条件 | 样本数 | 全部时间 | 中位 |
|---|---:|---|---:|
| baseline / 200 ms | 2 | 48.015, 45.195 | 46.605 |
| baseline / 0 ms | 2 | 32.931, 35.807 | 34.369 |
| candidate / 200 ms | 2 | 29.710, 29.791 | 29.7505 |
| candidate / 0 ms | 2 | 18.662, 17.305 | 17.9835 |

全样本中，200 ms 档 baseline→candidate 为 **45.195→29.791 秒，−34.1%**；0 ms 档为 **35.807→18.239 秒，−49.1%**。活跃子集对应约 **−36.2% / −47.7%**，方向相同，但数量不足以承诺固定百分比。候选的 200→0 ms 档相差 **11.552 秒**，不是简单从同一条日志扣出 12 秒。请求等待、采树、App 回调与轮询时机重叠；零配置延迟仍有真实网络、App 布局/渲染、截图和执行工作。

### 持久化：热点确认了，但要对准哪一种存储

候选 200 ms／0 ms 两档 ownership 写入中位分别为 **4.357／4.328 秒**；逐样本耗时占比的中位分别为 **14.6%／23.8%**。占比是先逐样本求比再取中位，与两个分组中位数相除的统计量不同。对应 112 次带设备所有权的变更，每次通常四次 JSON commit，每次文件和目录各同步一次：全流程 **448 commits / 896 次 JS fsync**。恢复后第一个新 baseline 另有两次 unknown 归档 fsync，共 898，原未知动作没有被抹掉。

单次点击/输入/H5 的 ownership 包含时间中位约 38 ms，并不是所有命令恒定 48 ms。相同候选的全部 FactStore `record` 只有约 **0.274 秒**，其中 native `append` 约 **0.085 秒**。JS hook 不会统计 C addon 或 SQLite 的内部 fsync；这次同时包围了 native append 和 record，避免把“JS 计数为零”当成“不写盘”。ownership write 包含 JS fsync，FactStore record 包含 native append，不能重复求和。

这足以把 **ownership 提交去重与追加日志表示实验**提高到第 2 阶段。它没有证明 4.3 秒都能去掉；当前截图命令约 4.7 秒，与 ownership 相当，剩余 ADB、等待/渲染也存在，不能笼统宣布“持久化在所有平台都是最大瓶颈”。

## 对这次意见逐项裁决

| 意见 | 裁决与处理 |
|---|---|
| F01 动画不在该 fixture 关键路径，原收益约 1% | **同意范围限定。** 保留显式非视觉测试选项；该样本不证明所有 App 关动画都无效，不提高默认优先级。 |
| F02 快照加载比短登录慢 | **同意。** 有很长准备流程时仍值得测；设备/后台/Host 不同步回滚的问题仍在。 |
| F03 当前树采集便宜，事件缺失不能证明页面不变 | **同意。** 后置常驻 Merkle 镜像。property/CSSOM 反例有效；事件可用于唤醒重算。 |
| F04 大纲 10 倍用了 raw 对照，跟 auto/table 比只有约 3% | **同意。** 保留当前默认信息与选目标所需字段；比较总 token、补读与正确性。 |
| F05 整页跳转时默认增量常更大 | **同意当前语料结论。** 47 次中 29 次更大，不能据此否定局部小改动时的显式增量。 |
| F06 SSE 使全局网络空闲不成立 | **同意。** 等业务声明的条件；SSE 长连接本身不阻止执行。 |
| F07 录屏测试被 guest 路径和固定 25 秒限制 | **采纳批评，修正文案。** 旧数据只评价该实现，不能否定 host console/scrcpy。没有编码器/CPU 栈证据，不能把“2 核软件编码竞争”当已证根因。host console 即时 stop 另立低优先级实验。 |
| F08 Memos 慢 5% 只是多一个命令 | **部分同意。** 多的 DOM 约 6 ms，更关键是同源码第二阶段多一轮约 150 ms readiness polling。首个存在性等待其实快 48–71 ms。保留当前组合端到端未提速的事实，删除“observer 本体慢 5%”的可能读法。80 ms 网络档还多 4–5 次命令及一次未派发的 stale 恢复，并非仅一条。 |
| F09 serial-only UIA 缓存原型错误不否定缓存 | **同意，前文已保留重设计。** 用完整 transport/server/serial/target/epoch 绑定；克隆 epoch 相同的反例仍需覆盖。 |
| F10 固定服务延迟稀释百分比 | **采纳并补实测。** 历史 60 次请求的服务端区间不重叠，合计 12.281 秒，配置延迟共 12 秒；但读树与这些区间重叠。新增的 0/200 ms 矩阵证实方向，不把相减余数命名为纯工具时间。 |
| F11 launch 约 1.4 秒不归工具管 | **部分纠正。** 历史三个 App launch 命令合计确为 1.405 秒，但包含工具校验/传输；Host runtime 启动已在 uiMs 外，不能再扣。 |
| F12 持久化未被列为主线 | **采纳优先级批评。** 前轮不是完全没测，而是只做局部提交原型、没量完整占比。现在测出 ownership 约 4.3 秒，进入第 2 阶段；不要优先改只有约 0.27 秒的 FactStore。 |
| F13 每个变更 8 fsync / 48 ms，合计约 5.3 秒 | **计数在普通成功路径成立，耗时需校正。** 新完整样本和私有 lease 原型约 37–40 ms；launch、ack、归档、错误路径另算。不是整个项目统一常数。 |
| F14 只派发前一次落盘即可保持全部合同 | **不采纳这个等价宣称。** 可以保证一部分“不主动重放”规则，却未保持已返回终态的可恢复性。真实 SIGKILL 反例显示已返回成功后只剩 pending；原设备查询也不保证永久可取。逻辑屏障不等于必须维持全部现有物理提交。 |
| F15 terminal / release 可跟下一次提交一起写 | **值得设计，不能直接后台覆盖旧 JSON。** 双 Host 迟到写覆盖新 pending 的反例只否定无写入权隔离的方案；单 writer、owner generation、durable sequence、逐动作 append WAL 仍值得实验。串行程序返回 A 才生成 B 时，不能无条件靠 B 凑批。 |
| F16 completion 持久前不能 ack | **同意。** 先保留可查询原 receipt，后 ack；已持久的 ack 清理义务可合并，需验证重复清理和容量。还需覆盖 release/force-stop、持久水位、保留期与退出。 |
| F17 给 fs.fsyncSync 加计数即可验证全部存储开销 | **不足，已扩展探针。** JS 能看 ownership 文件/目录同步，看不到 C mmap 和 SQLite；本轮分层观测，不混加嵌套时间。 |
| F18 模拟器时钟固定慢约 1 秒 | **时差事实采纳，固定数值不采纳。** 本轮 10 次中点估计中位 −501 ms，最短往返样本误差区间约 −515 至 −490 ms；时差要随采样报告。 |
| F19 Host sinceMs 会漏记录，尚无调用方证据 | **风险已得到更具体验证。** 找到文档/验证脚本 6 处调用；实际 SDK 既有日志的设备时间过滤/错误 Host 时间过滤/sinceId 对照为 1/0/1。不是刚产生动作后的现场漏日志证明，也不推断所有 cursor 后续读取都漏。 |
| F20 status 增设备时间与偏移，优先 sinceId / afterActionId | **复用已有时间与 cursor，按需要补诊断。** Android status 已有设备 updatedAtMs，无须新造必填校时参数。既有 sinceMs 不静默换域；afterActionId 不能独自替代完整 capture 起始边界。 |
| F21 模拟器 console 截图更快 | **采纳能力方向，默认切换暂缓。** 本轮 8 对为 72.68 vs 180.93 ms，原语约省 108 ms。保留真机截图；18 张约省 1.95 秒只是分项估计。后续 30 轮复杂流程已补测，业务核验与截图语义分开记录，见文首更新；不能用原语速度代替页面绘制验收。 |
| F22 同秒覆盖、像素差异 | **处理覆盖，接受来源差异。** 每次独立目录，校验 console OK/KO 与产物（实测 KO 可 exit 0）。用户明确四角/相机孔差异可以接受，不把像素完全一致设为准入条件。 |
| F23 P01/P03 否决；P02/P07/P08/O10/R01–R04/C01/E06 采纳；W02 只先修串行阻塞 | **沿用有边界的方案。** 这些方向的前轮证据仍有效；“采纳方案”不等于全部已进入产品或全平台验收。本轮未重新实验每个方向。 |
| F24 Flutter 重复 ok 检查 | **已清理。** 删除 caller 的重复检查，由 flutterLayoutResult 一处保持外层失败；18 项相关回归通过。是简化，不计性能收益。 |
| F25 优先级调整与 29→22 秒估计 | **调整优先级，保留估计标签。** ownership 提前、0 延迟组完成、截图与时钟纳入方案、录屏后置。没有把未实现的 fsync 和截图节省加到一起宣称已达 22 秒。 |

[历史时间与 Memos 逐条复算](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/attribution/README.md)、[持久化合同与 11 组实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/persistence/P13_PERSISTENCE_FOLLOWUP.md)、[截图与时钟原始证据](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/capture-clock/report.md)。输入的 fsync 目录只有三个中位值和 Node 版本，未见探针源码/逐次样本；以上判断以本次可复跑实验补证，不把原输入说成伪造或错误。

## 调整后的实施方案

1. **先减少错误与恢复成本。** 保持 R01–R04 原结果事实视图，补统一、简短的原 action 只读查询入口；修正跨时钟的示例和调用方。已有 status 的设备时间与 opaque cursor 足够时不再加探测。偏移仅作可选情报，不成为执行门槛。
2. **第 2 阶段明确加入 ownership 持久化。** 先比较 terminal + release 合并、可重建 idle 状态省写；再用隔离追加日志原型对照现有临时文件/rename。两个逻辑保证仍是“可能派发前有 durable marker”“公开 durable known/ack 前有 durable completion”。这允许一个屏障含多条记录，并不要求当前四次 JSON commit。
3. **追加日志/group commit 的具体验证。** 记录 action ID、命令、调用方标签、writer generation 和 durable sequence；用单 writer 或等价协议约束落盘，处理不完整尾记录、CRC、旧格式迁移、rotation 与未决记录保留。初始 owner 必须能被 force-stop 找到，但未证明它必须单独 fsync。不得让已经释放写入权的旧快照覆盖新 pending。延迟刷盘的弱持久模式若有需求可以由 caller 显式选择并如实返回保证级别，不静默改变既有合同。
4. **保留更快的模拟器截图候选，暂缓默认切换。** 独立目录、标准 outFile/artifact、source 标记与来源选择候选已完成；真机保持现有 screencap。后续复杂流程暴露 DOM 条件不代表绘制完成，先明确可选的视觉就绪条件并实测，再判断默认切换。普通操作不要求完全像素等价，也不增加强制等待或静默换源。
5. **事件等待和录屏按具体问题继续实验。** 事件等待双方使用同一个明确就绪谓词，再分策略和轮询周期；不删除现有 helper 的额外成本来“制造收益”。录屏流程结束即 stop，测录制资源、帧时刻、收尾时间和失败恢复；本轮没有新的录屏性能数据，不用它替代已经可用的截图。

持久化候选进入产品前，应经过 Native/H5/UIA 与 Script/Intent 的完整业务及以下故障：派发前后杀 Host、已收结果/未返回时退出、双 Host 争用、ack 前后退出、磁盘/目录同步失败、rotation/日志损坏、取消与 force-stop、askAgent 交接。对照同时报**完成率、恢复后已知/未知事实、无重复效果、整段时间和写盘包含时间**。这些是候选验收条件，不是普通用户执行动作的额外审批。

## 新发现的真实 H5 超时没有被测速掩盖

首轮原动作 `script-1791939055312-1:action-85` 点击“返回商城”：action 请求约 10 秒超时，cancel 约 1.5 秒仍 pending。随后按原 action/epoch 查询仍为 pending，但新 Native tree 已出现商城首页。画面变化说明输入可能生效，不能替代终态回执，也不能据此重放或虚报完成。

保留全部原回包后，仅强制关闭本轮 fixture 包，另开全新业务 runId。后续 ownership 归档仍保留该原 pending，outcome=unknown，新场景可继续，不是抹掉未知来换“成功”。[原回包](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/runs/01-baseline-delay200/run/payment-response-lost/last-failure.json)、[原 action 查询](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/runs/01-baseline-delay200/recovery-query.json)、[新页面](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/runs/01-baseline-delay200/recovery-tree.json)、[归档核验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/profiling/original-unknown-archive-check.json)。

目前没有足够证据把这次失败精确归因于 WebView 销毁、回调丢失或调度，不能编造根因；它发生在 baseline，也不归咎于尚未实施的存储优化。它说明**加速方案评估通过不代表工具已无真实恢复缺口**。H5/navigation 长尾与公开查询提示应作为独立产品缺陷继续处理，不用这次 12 次通过覆盖该失败。

## 本轮实际改动与尚未做的事

- 修改本文件及主审查的 P13、W01、E03、阶段排序和结果边界；修正 SCRIPT_AUTHORING 的 Host 时间示例为设备时间。
- 删除 Flutter caller 重复 guard，保留 helper 对原始失败的处理；[18 项相关回归](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/flutter-guard-regression.tap)通过。
- 全部性能原型、探针和实验副本留在证据目录；**没有将新 group commit、console 截图、时钟校准或新 observer/录屏实现合入产品，也没有发布**。其余五处捕获样例/脚本时间域修复仍列入第 1 阶段，不冒称已修完。
- 前轮的 1668 项全量功能、50 项性能和独立安装包结果属于当时冻结候选。新增的一行 guard 清理只做了上述相关回归；不把历史包的哈希和全量结果冒充本轮修改后的新安装包验收。
