# 已解锁环境下的性能复测

2026-10-14。用户解锁后，按原冻结程序重跑 30 轮五组对照。**四项 Host 实验仍有约 30–32% 的整段收益；追加 ownership 写盘去重和 console 截图没有表现出稳定的叠加收益。** 全部 30 轮业务与独立账本核验通过；截图是否包含所需业务画面另行核对。当前结果不支持把所有实验一起默认开启。

这是原方案的补充实测，不是公开版本之间的比较，也不是发布验收。本轮未修改产品源码，未发布或升级全局 CLI。先前恢复修复的验证仍以[主报告](/Users/macbook/.codex/worktrees/proposal-evaluation/ai-app-bridge/docs/MEITUAN_SCALE_OPTIMIZATION_VALIDATION_2026-10-14.md)为准；本轮没有重新执行崩溃矩阵。

**方法与环境。** 使用原五份私有 CLI、同一 APK、同一 JavaScript 程序和独立业务 oracle。3 个 seed × 0/180 ms 配置延迟 × 5 组，共 30 轮；seed、条件及交错顺序与上一轮一致，每轮新建 run ID、runtime、事实目录。后两组 seed 包含下单丢响应及原结果查询。冻结文件前后 SHA 一致。独占 emulator-5594，API 36 arm64、2 核/2 GiB、540×1200，headless + SwiftShader；专用本地服务 18199。预先完成一次基线热身，16.352 秒，不计入正式矩阵。

任务期间持续防休眠。每轮开始、结束共 60 次采样均为 `IOConsoleLocked=false`，显示器 active、未休眠；没有把无法取得的另一项 session 锁位当成 false。复测重启了模拟器，其他任务仍共享 Mac，因此旧轮与新轮不是“只改变锁屏状态”的因果实验。新轮整体反而略慢，不能把所有波动归咎于锁屏。以下结论以本轮内部配对为主。

流程仍为启动遮罩处理→按当前列表选可售商品→OTP 登录与协议→加购结算→创建订单或丢响应后查询→H5 同账号空车→原生返回→Flutter 酒店填表及真实查询。每轮 25/26 次变更、6/7 张截图，52–91 条命令；只读轮询次数随就绪时间变化。计时从已准备好的 Script 开始到业务结果返回，包含本地 OTP controller 的 askAgent/decide 往返，不含模型编写程序和 runtime 启动。

**整段结果。** 每档只有 3 个样本，报告中位数及配对结果，不推导 P95 或稳定倍数。

| 配置 | 180 ms 延迟，中位数 | 0 ms 延迟，中位数 | 业务/账本 | H5 所需画面 |
|---|---:|---:|---:|---:|
| 候选基线 B | 13.927 s | 11.513 s | 6/6 | 6/6 |
| 四项 Host 实验 H | 9.694 s | 7.735 s | 6/6 | 6/6 |
| H + ownership 去重 | 11.042 s | 7.607 s | 6/6 | 6/6 |
| H + console 截图 | 9.416 s | 7.001 s | 6/6 | 3/6 |
| H + ownership + console | 9.794 s | 7.600 s | 6/6 | 2/6 |

H 为直接 ADB 协议、按 epoch 复用能力、省略参考前台信息、截图只查窗口。后两项减少诊断信息，不能宣称与基线提供的信息完全相同；没有取消未知动作不重放的原则。

以下先在同 seed、同延迟内计算差值/比例，再取中位数，因此不能用上表两个中位数相减代替：

| 增量 | 180 ms 档节省 | 0 ms 档节省 | 判断 |
|---|---:|---:|---|
| B → H | 3.969 s / 30.4% | 3.726 s / 32.1% | 6 对全部更快；本轮可见的主要收益 |
| H → H+ownership | −0.979 s / −9.7% | 0.128 s / 1.7% | 写盘局部减少，整段收益不稳定 |
| H → H+console | 0.278 s / 2.9% | 0.307 s / 4.0% | 6 对全部更快，但整段节省较小 |
| H → 全组合 | −0.725 s / −8.0% | −0.042 s / −0.5% | 仅 2/6 对更快，不支持稳定叠加收益 |

负数表示变慢。全部慢样本保留，包括全组合 12.862 秒的一轮；不按理想耗时删除样本。结果不能证明 ownership 去重导致渲染变慢，也不能用局部写盘节省掩盖整段波动。

**持久化与截图的局部收益。** 六轮合计计时的中位数：ownership 同步写入 H 为 986 ms，去重组为 753 ms；100/104 次原子提交减少到 75/78 次。JS fsync 从每次普通变更 8 次减少到 6 次。窄去重确实减少约 0.23 秒的这部分开销，但本轮没有稳定转化成整段收益。它仍不是 append WAL、group commit 或后台刷盘；本轮不能证实或否定更大重构的上限。

每轮全部截图命令的耗时中位数，H 为 1.414 秒，console 组为 0.630 秒；整段配对节省只有约 0.28–0.31 秒，其他等待和调度会变化，不能直接相加局部差值承诺总收益。0 ms 配置仍包含渲染、HTTP、IPC 与调度，不等于纯工具耗时；也不直接减去服务端延迟总和来制造“净工具”百分比。

**截图复核。** 200 个截图文件的 PNG 签名和 540×1200 尺寸检查通过，30 张 H5 图另用 OCR 检查账号与空车文字；4 个 OCR 漏字样本、1 个部分绘制样本及加载态代表图经人工目检。最终 23/30 张包含所需账号和空车画面，6 张仍显示加载，1 张账号可见但空车文字尚未绘制。判据不要求图片下载完毕，也不要求模拟器与真机像素一致。

这 7 张不是 7 次命令错误：流程的 DOM 条件已满足，截图可能准确拍到了当时实际显示的加载/部分绘制状态。此次证据仍不能断言 console 返回旧缓存。需要结果截图的流程应明确等待相应显示状态；不需要画面证据的动作不应因此被增加强制等待或拒绝执行。截图来源选择本身仍可作为显式能力保留。

**连续 Intent。** 同一预备程序完成 14 条命令、15 次本地决策：包装 ADB 读取与返回→原生打开酒店→Flutter 填写错误日期→观察校验提示→修正→真实查询→截图。CLI 外层耗时 **4.694 秒**，runtime 内 **4.493 秒**，命令累计 4.159 秒。后端仅新增 1 条酒店查询，账号、杭州、10.18/10.20 均正确，原订单及创建记录仍各 1 条，无支付；最终图片人工核对正确。该项只有一次样本，不包含模型逐步思考时间，也不代表所有 App 登录都能稳定在 5 秒内完成。

**本轮取舍。** 四项 Host 实验继续作为主要性能候选，需保留诊断取舍和原验证边界；这次 H 的 6/6 张所需画面合格，不能抹去上一轮 1 张加载态。ownership 仅保留窄候选与局部节省证据，撤回“整段稳定省约 3%”的外推。console 截图原语有收益，可继续保留明确选源能力，不因像素差异或拍到真实加载态而否决；本轮没有新增默认切换。全组合没有稳定收益，不直接吸收为默认配置。方案中的其他大型重构、UIA 真机与 iOS 运行验证未因本次解锁而自动完成。

测试 App 仍有小型固定目录、大量频道图像页面、只读 H5、酒店固定空结果等限制；这些结果证明上述具体混合流程，不证明已经测完美团级别的全部功能。

**可复核材料。** [全部原始证据](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/unlocked-retest-2026-10-14)、[代码/程序冻结](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/unlocked-retest-2026-10-14/freeze.json)、[逐轮配对与局部计时](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/unlocked-retest-2026-10-14/comparison.json)、[60 次环境采样](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/unlocked-retest-2026-10-14/environment-samples.json)、[截图逐张判定](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/unlocked-retest-2026-10-14/screenshot-review.json)、[Intent 独立核验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/meituan-scale-review-2026-10-14/unlocked-retest-2026-10-14/intent-validation/acceptance.json)。

本轮专用模拟器和服务已结束；证据与 AVD 文件保留，共享设备及其他 runtime 不受影响。防休眠保持到复测和整理结束后清理。本轮只补充这份报告及主报告的更正链接，不改变先前源码修复和未提交改动。
