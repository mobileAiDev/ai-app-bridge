# 命令生产化第三阶段 A：执行预算与取消收尾

本阶段收口普通 Android 命令和 Script 的 Host 执行生命周期。它为后续定位、输入、滑动、等待重整提供共同基础，第三阶段整体仍在进行中。样例仍用于验证 Bridge，没有修改 NotallyX 业务代码、APK 或业务数据。

## 已落实的合同

- Script 从共享注册表判断变更。授权、撤权、AppOps 和清数据与 UI 操作一样，在提交前持久化 dispatch marker，提交后持久化 receipt，参与暂停、取消和检查点恢复判断。崩溃后不能从旧检查点重复已发生的变更。
- 普通 Android 命令的 `timeoutMs` 覆盖排队、Provider 和可选反馈，默认 30000 ms；定时 logcat 默认采集时长加 1000 ms。`adbTimeoutMs` 是同一预算内的单次子进程上限。Script `policy.timeoutMs` 是整个运行预算，内部调用不能延长它。
- ADB、HTTP、轮询和 UIA 文件锁等待收到同一个取消信号；实际派发前再次检查时间，避免事件循环尚未执行定时器时越过截止时间。已取消的队列项不会派发，也不会把前一个未完成操作的队列屏障移除。
- 取消先阻止新调用，进入 `cancelling`，等待拥有的 Host 调用、断言、检查点与回执写入结束，再提交终态。子进程关闭后才返回；忽略 SIGTERM 的本地进程在 250 ms 后收到 SIGKILL。HTTP 有总时限与响应大小上限，持续少量回包不能延长时限。
- JS/Python Runtime 在等待 Host、检查点或 Agent 时也接收子进程退出通知。MCP stdin EOF 与 SIGTERM 会清理 Script，再关闭证据库。后台观察器有独立生命周期，不继承启动它的某次命令截止时间。
- 已保存但在取消期间尚未更新内存的检查点，仍推进版本号，然后再保存终态，防止两个检查点使用同一 revision。

`cancelled` 表示 Host 任务完成收尾。Android/App SDK 已接受的操作不能靠关闭 ADB/HTTP 撤销；结果未确认时保留 `dispatched:true, ambiguous:true`。真机本轮验证的是观察期间取消；提交期间的不确定结果、拒绝退出进程和存储竞态由真实本地进程、HTTP 及持久库测试覆盖，不能代替手机端动作中止协议的验收。

## 源码与发行包

完整 Host 测试 **786/786**，0 failed、0 skipped，15.336536333 秒：`build/phase3-full-fourth.log`。

真实 npm pack、全新目录 npm install、native install lifecycle/node-gyp、已安装产物公开 MCP 验证均通过。仍只有 capabilities/run 两个工具、93 个命令；81 个非依赖源文件与工作区逐字节相同，未发布 npm。

- tarball SHA-256：`88860e1612e40a64fe453dfe6c2eb1bdf6ec186ab1256a589fdedc1aa7bcd2ef`
- 发行验证：`build/ai_app_bridge_artifacts/command-production-phase3-package-2026-09-08/report.json`
- 源码对应：同目录 `source-match.json`

发行包还验证了四个同时存在的 Script：JS/Python 各有一个进行中的受控 ADB 调用、一个等待 Agent 答复的运行时。退出时真实进程全部关闭，重新打开库后验证回执位于终态之前，归档校验通过。权限阶段的四种结果及等待中的 Intent 退出收尾也再次通过。

## 发行包 OPPO 验收

设备为 `b46093e6` / PKR110 / Android 16，样例 `io.github.mobileaidev.notallyx.sample`。实际调用干净安装目录中的 MCP server，控制器已冻结为 `device-packed/controller.js`。

| 场景 | Script ID | 结果 | 总观察耗时 | 动作数 | 残留 Host ADB |
| --- | --- | --- | --- | --- | --- |
| JS 正常 | script-1788872784954-1 | completed | 2330 ms | 1 | 0 |
| Python 正常 | script-1788872787279-2 | completed | 2341 ms | 1 | 0 |
| JS 观察中取消 | script-1788872789621-3 | cancelled | 208 ms | 0 | 0 |
| Python 观察中取消 | script-1788872789828-4 | cancelled | 208 ms | 0 | 0 |
| JS 700 ms 运行预算 | script-1788872790036-5 | failed / timeout | 754 ms | 0 | 0 |
| Python 700 ms 运行预算 | script-1788872790790-6 | failed / timeout | 750 ms | 0 | 0 |

正常场景是 UIA 读取及 KEYCODE_UNKNOWN（0）空操作，验证 Host 连续调用与回执，不是新的全 App 功能回归。取消前独立观察到真实 `adb ... uiautomator dump` 进程；取消 RPC 分别耗时 4 ms、3 ms，返回后 PID 已退出，后续按键未提交。这是两次样本，不是性能 SLA。表中总耗时包括控制器查询和归档导出。

六份归档复制到新位置后，在新的 MCP 进程中离线验证；该进程的 FactStore 路径指向普通文件、ADB 路径不存在，六份均 `integrity:verified`。此处核验归档保存的执行记录，不把未保存的手机事实载荷当作已离线采集。

独立复制 SQLite 后比较完整行内容：11 条 BaseNote、11 条 Label、android_metadata 均未改变；安装物 SHA-256 保持 `ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。前截图处于启动画面、后截图为笔记列表，不能用截图相等作为业务结果依据。测试后样例已重新启动。

证据根目录：`build/ai_app_bridge_artifacts/command-production-phase3-2026-09-08/`。

- `acceptance-summary.json`：测试、发行包、设备与业务核验入口。
- `device-packed/report.json`：六轮 Script、耗时和离线结果；同目录包含源码、JSON-RPC、实际 PID、截图及归档。
- `business-comparison.json` 与 `business-before/`、`business-after/`：独立业务数据证据。
- `baseline.json`、`baseline.patch`：本阶段开始前的脏工作区快照。已有改动和 Flutter lockfile 保留，未提交 Git。

## 保留的失败与后续

`phase3-full-first.log` 的旧无限挂起测试要求在 Host 未结束时就报告终态，已改为可取消的挂起调用。`phase3-shutdown-first.log` 暴露验收控制器把 Script durable checkpoint 当作 Intent ledger payload 读取，控制器已修正。`phase3-closure-third.log` 的检查点夹具没有命中 running 状态，修正夹具后，`phase3-full-third.log` 真正抓到取消与检查点 revision 重复，源码已修复。最终完整回归与发行、真机矩阵在这些修正后通过；失败记录不计入通过证据。

下一步继续第三阶段 B：重整语义定位、输入、滑动与等待合同，统一单位、条件和新鲜观察；把上述生命周期接入普通 Intent 及安装/权限长期操作。跨进程独占、手机端进行中动作取消、iOS/Web 同义能力、长期压力与四 App 固定完整回归仍按总计划推进，不能因本阶段通过就宣称整体生产就绪。
