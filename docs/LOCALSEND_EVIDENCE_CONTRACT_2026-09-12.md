# LocalSend 业务证据条件

后续 v1.3.0 已完成[空设备前提与完整控制器收尾](LOCALSEND_NO_PEER_2026-09-12.md)：132.939 秒、148 项断言，当前固定导航场景通过。下文保留 v1.2.0 的原证据条件和当时未决结果。

本轮处理组合回归中重复出现的七项未定条件。原 `v1.1.0` 运行及其 139 passed / 7 inconclusive 结果保留；没有改变 Host 的设备断言合同，也没有改样本 App 或添加测试日志。

## 原因与本轮判定

原脚本要求系统取消、主题恢复及最终接收三个动作后，App 内 events/state/logs 每一种流都必须非空。这不能正确表达原业务要求：

- 系统取消由 `com.coloros.filemanager` 的 UIA 原回调执行。其 actionId 不属于 LocalSend 的 Dart 异步上下文，不能要求 LocalSend 生成同 ID 记录，也不能按时间接近强行关联。
- `recordState` 是显式状态生产入口。当前 LocalSend 集成仅初始化 Bridge 并接入 navigator observer，没有添加设置状态上报。这几次实际完整、已提交、无缺口的 state/logs 查询为空，不能据此认定设置未保存或采证丢失。
- 手机真实 events 已包含原 Flutter started、target.tap、settled。主题恢复另有 `ui.route.changed`、`HomePage`、`pop`、`semanticChanged:true`；最终 Receive 是页内标签选择，没有新的 route push。仅断言任意一条事件存在同样不足。

源码依据为 Flutter 的 `recordState` / `recordLog` 与 navigator observer、LocalSend 的 `integrate.py`，以及 `android-combined-localsend-20260912-05/` 的原始归档。独立 SharedPreferences 检查仍直接读取真实持久文件。

## v1.2.0 固定条件

| 业务结果 | 自动判定依据 | 保留的边界 |
| --- | --- | --- |
| 文件选择取消 | 精确系统 Cancel 控件、原 UIA callback、回到 App 后的新空选择页面与截图 | 系统动作不声称具有 App 内同 actionId 记录；不推断文件传输完成 |
| System 主题恢复 | 原 Flutter 动作与目标一致的有序手机事实、明确 HomePage pop、实际设置页面、控制器独立读取持久设置 | 路由事件本身不证明设置值；空 state/logs 保留为诊断数据 |
| 最终 Receive | 原 Flutter 目标与结束事实、新 Receive 内容、原设备名与截图 | 不要求标签选择制造 route push；最终设置仍由执行结束后的外部读取确认 |

每个事件断言还要求当前 Host 签发的完整证据、正确前置水位、运行时、目标和 mobile refs。新谓词拒绝错误 action、目标、epoch、缺少结束事实、缺少引用、空页，以及错误／非语义路由。已有断言内核的 coverage、跨包边界和过期观察拒绝条件保持不变。

state/logs 和系统动作的 App 内过滤查询继续原样采集，标明 `supporting-diagnostics`，不作为“记录存在”的设备断言。查询失败或缺失仍留下未定项。系统 Cancel、设置及最终页面的 `businessEvidence` 保留回执、调用和观察关联；外部数据库结果不伪装为手机 `ctx.assert` 引用。

这明确了原表格的“关键 state/events/logs”如何支持实际业务结果，不要求每个动作产生每一种记录。原 no-peer 前提、截断诊断树、最终外部设置核对及真实传输要求继续有效，完整四 App 和 iOS 验收范围保持。

## 验证记录

新源码 SHA-256 为 `52b7715f23d9413463f7984559eb2ee922bf239e8c7720f879a1bd5ecf5aa2aa`。离线谓词检查读取了前轮实际归档的两个事件页及其原动作回执；两页符合更强条件，14 个内存副本反例被拒绝。该检查保存在 `localsend-evidence-contract-20260912-01/predicate-review.json`，不是新真机执行，也不改写旧结果。

随后同一源码在获授权 OPPO `b46093e6` 实际执行 `android-combined-localsend-20260912-06/`：

- 公开 start 到 terminal **124.801 秒**，执行 completed、完整流程走完；323 次调用、31 次动作、13 张截图。
- **145 项断言通过，0 failed、0 inconclusive**，包含两个新的严格手机事件断言。断言与动作数受实际有界滚动／观察次数影响，不能用前轮数量做覆盖等价判断。
- 原系统 Cancel callback 与新空选择页面相连；主题恢复含准确路由事实，最终 Receive 含准确目标动作事实。已查看文件选择器、取消后页面与恢复设置的本轮截图。
- 七个 supporting-diagnostics 查询仍完整保存，均为真实 complete、committed、gap=false 空页；它们没有被改成虚构 mobile facts。
- 三个中间 SharedPreferences 检查通过，执行结束后的真实设置与执行前完全一致。Script 返回时的 `final-independent-fixture-equality` 表示仍需控制器读取，控制器随后已完成此项，不能把它误列为实际未验证的数据库条件。
- 18 页手机采证保留，调用目标审计与公开离线验证 verified，自有运行时已停止。含预检、启动及导出的 live wall 为 126.945 秒，含停机和离线验证为 127.470 秒；这仍是单项定向运行。

**该结果不是整体通过。** Script 与控制器保留 `inconclusive`：前后两处诊断树覆盖和受控 no-peer 前提仍开放；原四 App、已有 iOS 及生产发行关口均未完成。新源码当前只有这一次完整实机运行，不借用旧源码的三轮成绩。后续优先完成无对端场景的真实网络前提与可核验 UI 依据，再回到组合；当前证据条件无需无变化复跑。
