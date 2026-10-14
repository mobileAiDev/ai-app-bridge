# Meituan 测试 App：剩余优化收益与真实边界

**后续解锁复测：** [30 轮冻结程序复测](/Users/macbook/.codex/worktrees/proposal-evaluation/ai-app-bridge/docs/UNLOCKED_PERFORMANCE_RETEST_2026-10-14.md)已完成，60 次环境采样均解锁且显示器未休眠。四项 Host 实验的配对收益为 30.4% / 32.1%；新增 ownership 和全组合没有稳定整段收益，因此下文“约 3%”仅为本报告原轮次结果，不能外推。新轮业务 30/30、H5 所需画面 23/30；原始历史数据及恢复验证保留。

2026-10-14。本轮使用已经准备好的测试 App 进行独立核验，延续“先实验、保守吸收”的要求。**较大的收益仍来自先前四项 Host 实验；新增 ownership 去重约省 3%，截图原语更快，却在完整流程中暴露绘制就绪缺口。当前不能说项目已经达到最好状态，也不能把最快配置直接当成通过验收的版本。**

本报告不是发布验证。新的 Host、ownership、截图实验均在私有 CLI 副本运行；本轮不将它们默认合入产品。实际暴露的 Script 恢复缺陷单独修复和验收，不升级本机 CLI，不修改测试 App 作者的源码。

## 可复现证据与对照

- 源码基线：`codex/proposal-evaluation`，HEAD `87af91f44cf0070686c6bd3e3e695ef2423d6702` 加已有未提交候选；不是以公开 0.4.8 包直接冒充基线。精确各文件 SHA 见冻结清单。
- 证据根目录：[meituan-scale-review-2026-10-14](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14)。
- [freeze-v2.json](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/freeze-v2.json)：五臂所有 bin 文件、程序、oracle 的 SHA；APK `b758d1b621c198f8711d8f539c00ef40a6ee72defd7f2f68e1e8572c24148edb`。
- [matrix-v2-plan.json](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/matrix-v2-plan.json)：3 个留出 seed × 0/180 ms 延迟 × 5 臂，交错执行，共 30 轮。每对延迟共享 seed，后两组 seed 启用下单丢响应。每轮独立 run ID、runtime、事实目录。
- 独占 `emulator-5594`：API 36 arm64、2 核/2 GiB、540×1200、headless + SwiftShader。防休眠在任务期间持续开启；Mac 仍存在人工锁屏状态，因此不用这些数值与旧 GUI/已解锁样本混比。早期 5592 遭其他 Host 操作的作者样本排除，未停止对方 runtime。
- 同一普通 JavaScript 程序：启动→真实启动遮罩→从当前列表选可售商品→OTP 登录/协议→回商品→加购→结算→订单/未知后查询→H5 同账号空车→嵌入 Flutter 酒店填写并查询。25/26 次变更，6/7 张截图；较快调用会让同一 readiness 循环多读几次，命令总数 52–93。
- 计时从程序开始到业务结果返回，包含本地 OTP controller 的 askAgent/decide 往返；不含脚本编写及模型思考，runtime 启动在外。CLI 外层另约 0.3 秒；不把作者尝试时间混入提交后执行时间。

早期 v1 的 14 个完整样本因 H5 超时后只检查空车、没有再次要求正确账号，被移出正式矩阵。源码和结果原样保留在 `matrix-v1-archive/` 与 `runs/m*/`；未为旧结果补造 DOM 证据。v2 返回实际 `h5BodyText`，独立 oracle 校验账号、订单完整 ID、商品/金额、qty、账本 key、酒店请求字段、无重复 POST、无支付。19 项正负对照验证 oracle 会拒绝错误证据。

## 时间收益与画面证据必须分开

每档仅 3 个配对样本，下表为整段中位数，不报告 P95 或稳定倍数承诺。

| 配置 | 180 ms 服务延迟 | 0 ms 配置延迟 | 业务/账本核验 | H5 账号与空车截图语义 |
|---|---:|---:|---:|---:|
| 当前候选基线 B | 12.338 s | 10.345 s | 6/6 | 6/6 |
| 四项 Host 实验 H | 9.096 s | 7.004 s | 6/6 | 5/6 |
| H + ownership 去重 | 9.050 s | 6.836 s | 6/6 | 6/6 |
| H + console 截图 | 8.363 s | 6.542 s | 6/6 | 3/6 |
| H + ownership + console | 8.094 s | 6.158 s | 6/6 | 0/6 |

四项 Host 指：直接 ADB 协议、按 epoch 复用能力、省略参考前台信息、截图只查窗口。后两项减少诊断信息；没有把它们宣传成与基线信息量完全相同。

按每一对先计算节省量再取中位：

| 增量 | 180 ms 档 | 0 ms 档 | 解释 |
|---|---:|---:|---|
| B → H | 3.374 s / 27.6% | 3.368 s / 32.3% | 本流程仍有明确的较大收益，但 H 的一张截图未满足画面验收 |
| H → H+ownership | 0.264 s / 2.9% | 0.238 s / 3.4% | 小而可测，单轮仍受波动影响 |
| H → H+console | 0.618 s / 6.8% | 0.175 s / 2.6% | 整段收益波动，且画面语义未通过 |
| H → 全组合 | 0.736 s / 8.3% | 0.943 s / 13.5% | 不能用最快数字替代完整验收 |

[逐轮结果与存储计时](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/matrix-v2-analysis.json)；[分层验收纠正](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/acceptance-layer-review.json)。原 `acceptance.json` 表示当时的业务 oracle，不覆盖后补的图像语义检查。

## 写盘：优先级成立，4–5 ms 的推算未被兑现

ownership 真实同步写入计时的全样本中位：H 997 ms → H+ownership 743 ms。普通动作 4 次提交/8 次 JS fsync → 3 次/6 次；整条链 100/104 次提交 → 75/78 次。保留派发前 marker 和返回结果前 terminal 的同步持久化，只省掉已持久状态不变时的释放投影写入。

这不是 append WAL、group commit 或后台刷盘。不能由此声称已经验证“每次动作只需要一次 fsync”。私有真实文件/进程故障实验覆盖 marker/terminal 写失败、SIGKILL、争用及 HTTP UIA fixture；没有把这些叫作真实手机 UIA ACK 或断电验收。另发现 durable proof 谓词在未成功写盘时可能比较可变内存而误报，候选以最后一次成功提交为准；没有证据说旧产品已因此实际误 ACK。

决定：保留窄去重候选和正确性修正建议；约 3% 的流程收益不足以跳过持久化生命周期验收。更大的 WAL 重构仍可另作实验，本轮未实现，也没有将其潜在上限判为零。

## 截图：能生成 PNG，不等于业务状态已经绘制

30 张 H5 图独立复核，20 张包含正确账号和空车，9 张还是加载态，1 张为 WebView 白屏。OCR 的六个假阴性已经逐张目检纠正。未要求两来源像素完全相同，也没有把图片未全部下载与账号/空车未绘制混为一谈。

这是流程所需画面证据未满足，不等于截图原语执行错误：如果新 DOM 尚未呈现在屏幕，拍到当前加载态本身可能完全正确。不能从这 10 张图片推导 console 会返回旧缓存，也不能把它们计为 10 次 Bridge 命令失败。

[代表性加载截图](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/runs/v2-m3-optimized/h5.png)与[同 seed 已绘制截图](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/runs/v2-m3-fast-capture/h5.png)。`optimized` 与 `fast-capture` 的截图代码完全相同，只有 ownership 去重不同。较短节奏更容易进入尚未绘制的窗口，不能因此直接指控文件缓存。

保持页面不退出的 4 组交错截图实验共 12 张：一组首次 console 调用区间 0–77 ms 是加载页；随后 guest 77–283 ms 正确，后续 console 283–365 ms 也正确。其余三组都正确。**没有得到“guest 已更新、后续 console 仍持续旧帧”的反例**；H 的 guest 截图本身也有一张加载态，所以不能简单归因为 console。调用区间不是精确取帧时间。

Android 明确区分 DOM 更新与后续可绘制状态；`postVisualStateCallback` 后的下一次绘制才包含此前 DOM 更新。该合同支持当前就绪条件不足这一解释，但并未独立证明本轮合成器中的精确根因。[官方 WebView API](https://developer.android.com/reference/android/webkit/WebView#postVisualStateCallback(long,%20android.webkit.WebView.VisualStateCallback))

决定：暂不吸收默认 auto 切换；保留已完成的截图候选、选源参数、28 项定向回归和故障提示设计。候选已修正“成功截图因清理目录失败被降为失败”的额外阻断，清理异常只给 warning；复用 executablePath，避免 Windows adb.exe 漏检。后续先验证可选的 DOM→可绘制→实际显示帧屏障，再比较两来源；不靠固定睡眠制造合格率，不把这种等待强加给普通动作，也不失败后偷偷换源。

## 能力与自由度

一次本地 autonomous Intent 用 **4.205 秒** 连续完成 14 条命令、15 次本地决策：包装 ADB 读取/返回→原生进入酒店→Flutter 填写错误日期→观察校验提示→修正日期→真实查询→截图。独立后端只新增 1 条酒店查询，字段为杭州/10.18/10.20、账号正确；原订单仍恰好 1 条。页面重新进入，避免将上一次相同的空结果文字当新查询成功。仅为单次能力样本，不是所有登录/网络情况的速度承诺。

[Intent 结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/intent-validation/summary.json)和原决策/回执已保存。Script 使用真实 JavaScript、循环、条件、checkpoint 和 askAgent，并非只能执行静态 JSON。30 轮每轮都经历 OTP 的显式 askAgent/decide。

截图诊断程序刻意保存大量原始观察，`extract:null` 的 134 KB 回复超出 96 KiB 交付预算；随后按同一个 `control.source.ref` 只读重提取 `/result/cases`，得到约 4.7 KB，不重跑程序。该例证明引用恢复可用；不是默认 auto 的性能样本，也不是让 agent 每次多问一趟的理由。

## 真实 Host 崩溃恢复

第一轮真实 Host SIGKILL 实测暴露一个产品缺陷：原 Script 源码未变、checkpoint 和订单均在，但普通 resume 返回 `script_hash_mismatch`。唯一 inputs 差项是 `baseUrl: http://10.0.2.2:18199` 被持久化 URL 脱敏器无条件序列化成 `http://10.0.2.2:18199/`。恢复拿改写后的输入重新算哈希，自然不匹配。这不是 fixture、脚本源码漂移或未知动作重放问题。

进一步尝试显式提交最初保存的原始 spec，公开 CLI 又以 `unsupported_argument: script` 拒绝，而内部 `planCodeRestore` 已有同哈希程序校验能力。原始失败及一次未派发的恢复尝试完整保留，订单 POST 始终为 1。最小修复方向：无须脱敏的 URL 原字节不变；确需脱敏仍处理；公开 resume 可显式提供**同一个哈希**的原始程序，live/restored 两条路径都校验，绝不跳过身份校验或篡改旧 checkpoint。

已在隔离工作树采用最小修复：安全 URL 保留原字节；`resume.script` 接受完整原 spec；运行中与重新载入的 operation 都按原 hash 校验；相对源码/工作目录/ADB 包装路径按调用方目录解析；旧记录的 URL 规范化不能推翻匹配的原程序 hash。错误附简短恢复提示，公开合同和 authoring 文档已补充。没有合入四项 Host 实验、ownership 去重或 console 截图。

独立 review 又找到一个合成脱敏反例：URL 解析移除 TAB 后才显现的 `password=`，最初“保字节”候选会漏掉。最终实现先对解析后的表示执行同一脱敏规则，仅在确实无敏感信息时保留原字节。TAB/LF/CR 三个反例先红后绿；独立差分 594 个敏感样本均保持脱敏及幂等，9 个安全 URL 与嵌套 JSON 保字节。没有证据表明发生真实凭据泄漏。[修复与定向回归报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/recovery/hash-fix/REPORT.md)、[独立差分证据](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/recovery/hash-fix/review-final/README.md)。

首先恢复**原先已经失败的同一条 operation**，显式提供原 spec，约 1.086 秒完成；原记录逐条不变，订单、创建账本、POST 次数仍均为 1。不是新建流程冒充恢复。新修复在性能实验副本通过三边界后，又在**最终工作树、默认传输/持久化、无性能开关**独立验证：

| 真实 SIGKILL 位置 | 核验 | resume 到持久结果 | 从检测到崩溃至结果，含诊断 |
|---|---:|---:|---:|
| 业务 checkpoint 后 | 55/55 | 1.092 s | 1.968 s |
| SDK 已执行、ownership terminal 落盘前 | 58/58 | 0.957 s | 2.434 s |
| ownership terminal 已落盘、Script receipt 尚未保存 | 57/57 | 0.967 s | 2.217 s |

每种仅 1 个最终工作树样本，不承诺恢复 P95；不含编写诊断代码或首次查找问题的时间。后两组普通 resume 仍返回原 unknown，不重放；按原 action/epoch 只读查询并核对独立订单账本后，显式选择 query-order checkpoint，继续新导航。原记录不修改、缺失的 Script receipt 不补造、后续 action ID 继续递增、所有业务写入计数不增加。每轮始终恰好 1 次订单 POST、1 条未支付订单，未发支付请求。[最终冻结代码](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/product-recovery/final-freeze.json)、[三组结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/product-recovery/final-summary.json)。

原 Native action 查询在本轮 harness 中使用内部导出的只读 helper；现有公开 `device-ownership receipt` 主要针对 UIA，不能将这项内部查询宣传为已有统一公开入口。恢复使用现有公开 `reconcile` 和 `script resume`。统一原 action 查询仍值得补；本轮不声称验证了真实 UIA ACK、整机断电或 App 进程死亡恢复。

保留的测试失败还包括：一次 harness 把只读 wait 拉起的新 Host 当成旧 Host 未死亡，随后按旧 PID 已退出、新 runtime 身份和同 facts 纠正控制器；原失败 operation 也经原结果查询继续完成，未丢弃后重建订单。一次最终 ledger 读取早于私有 runtime 关闭，按存储锁合同关闭后只读成功，未重跑 Script。它们均与真实 URL 哈希产品缺陷分开记录。

## 最终代码回归与交付状态

- 最终工作树 `npm run test:functional` **1681/1681 通过，0 失败、0 跳过**；另有 138 项定向回归。两组有重叠，不相加。[完整功能日志](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/product-recovery/functional-regressions.tap)。
- 新增回归覆盖真正落盘/重新载入、旧规范化 inputs/target URL、原文件移走后使用冻结源码、真实 CLI 在不同 Host/caller 目录恢复、运行中与终态原 spec 验证，以及变更源码/inputs/target/permissions 被拒且无新副作用。iOS URL 项是 Host 身份恢复测试，不是 iOS 设备运行验收。
- 最终 3 组默认工作树真实 Host SIGKILL 样本共 170 项核验通过；代码/程序冻结后 SHA 无变化。`git diff --check` 通过。[新恢复代码及测试补丁](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/product-recovery/final-code-tests.patch)。
- 修改位于 `codex/proposal-evaluation`；原有工作树改动保留。未提交、推送、发布或升级全局 CLI；主工作树保持干净。
- 本轮专用 `emulator-5594`、18199 服务与作者 runtime 已停止，运行证据和 AVD 文件保留。共享 5592/5564、主项目与全局 runtime 未停止。防休眠保持到测试结束，再清理本任务自己的进程。

## 测试 App 本身的限制与问题

[独立 fixture 审核](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/fixture-audit/REPORT.md)包含 96 次私有 API 请求、Android JSON 原库探针及源码因果。当前只有 15 商品/10 商户且价格全为 0.01 元；列表 seed/可售状态会变化，但首页抓取数据固定，大量频道为整页 ImageView，H5 只读，酒店固定空结果。不能视作完整美团业务规模。

| 问题 | 证据/影响 | 处置 |
|---|---|---|
| “手动选择地点”没有业务 listener | 早期 11 次动作派发成功但无页面改变，随后底层点击被遮挡 | fixture + 作者 readiness 问题；不能算 Bridge 随机拒绝，不删除遮挡事实 |
| 末页 JSON null 变成字符串 "null" | Android 库探针确认，继续翻页得到 cursor_stale | fixture 修正，避免工具替它猜测游标 |
| 下架购物车项无删除口 | qty:0 仍先被 sold_out 拒绝，UI也无删除控件 | 不能验收失效商品恢复全链 |
| 订单跨账号隔离缺失 | B 能查询 A 的单，本地模拟 pay 也能触及 A 的单 | 本轮速度测试单账号隔离；多账号验收先修 fixture |
| 原 acceptor 允许错金额和 ID 子串 | 负对照实际错误通过 | 本轮独立 oracle 已替代并做反例检查 |
| 待查订单 key/token 仅在内存 | App 被杀后的登录/建单恢复不能假定存在 | 区分 Host 与 App 进程故障，不伪造全链恢复 |
| journal 序号重启归零 | 追加文件里出现重复序号 | 分启动段/时间窗取证，不用序号单独跨重启去重 |

fixture 源码没有被本轮改动；缺陷可直接交给其作者按证据修复。

## 对方案的最终取舍与下一步

- **已有明确大收益但未默认吸收：** 四项 Host 实验，本流程约 28–32%；继续保留显式少诊断的区别，解决快路径画面就绪后再作最终验收。
- **小收益、保留窄候选：** ownership 同步去重约 3%。完整记录先前持久化屏障，拒绝将“可保守变 unknown”等同于“所有成功结果都可恢复”。
- **方向有收益、默认切换暂缓：** console 截图；原语更快，真实截图语义尚未稳定。不是因模拟器/真机像素差而否决。
- **新增最值得尝试的能力：** 明确且可选的视觉就绪证据，区分 DOM、布局、实际绘制与业务成功；不得成为普通命令新的强制门槛。先小型 SDK 实验和故障回退提示，保留 caller 决定继续的权利。
- **本轮实际采用的修复：** Script URL/原 spec/相对路径恢复及其提示；按完整原 hash 验证，不修改旧记录。它减少真实中断后的卡死和返工，不计作整段性能优化百分比。
- **先补测试可信度：** 修复 fixture 真实业务缺口、动态数据和 oracle。已有 30 轮测试不能替代大量变化商家、SKU、复杂 H5、权限中断、多账号、App 进程重启及真正 UIA 黑盒应用。
- **维持原逐项评审：** [57 项原提案审查](OPTIMIZATION_PROPOSAL_REVIEW_2026-10-13.md)、[后续意见逐项复核](OPTIMIZATION_FOLLOWUP_REVIEW_2026-10-14.md)。本轮没有重新实现 WAL、设备端 Merkle/push 协议、录屏替截图、状态分支、iOS 实机等；不得把“审过/列入计划”写成“全部实验完成”。

0 ms 组用于分离等待影响；它仍含渲染、HTTP、进程调度和截图，并非纯工具时间。每轮 15/16 条非 pulse 业务请求，180 ms 组服务区间总和中位 2.917 秒、区间并集 2.719 秒，Host 工作与之重叠，不能直接相减得到净工具开销。分析按不可变试验时间窗截断，排除了后续 Intent/截图诊断复用同会话的请求。
