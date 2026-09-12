# 第三阶段 K：Native 执行结束证明、恢复与持久回执

Native 点按、文字输入和持续手势现在共用 SDK 执行协调器；Host 响应丢失、取消或进程死亡后，只有原动作的匹配结束凭据才能解除未知占用。普通命令、Intent 和 Script 保存同一份紧凑凭据。本轮通过真实 NotallyX、LocalSend、公开发行包和离线归档验证，样例业务逻辑未修改。整个体系仍未达到生产就绪。

## 实现与合同

- Android SDK 新增 `aab.native-execution/v1`。点按、输入、手势共用一个活动槽位和 `/v1/action/cancel`；取消必须匹配 actionId/runtimeEpoch。`status.debugBridge.nativeExecutionSchema` 声明协议，`nativeAction` 返回活动身份或 null。旧手势专用取消端点和 `nativeGesture` 状态字段已移除。
- Host 传入当前剩余预算。SDK 在 UI 线程验证目标并执行；排队取消不能留下迟到输入。DOWN 后取消发送 CANCEL，不能迟到 UP；输入连接回调返回后，下一次写入仍需通过取消与目标校验。已经提交的输入和业务回调不回滚。
- 主线程或 App 回调尚未返回时，1500 ms 清理宽限只限制响应等待时间。SDK 返回 `settled:false, dispatched:null, ambiguous:true` 并继续占用，不能因 Host 超时、返回或关闭 HTTP 就释放。
- SDK 缓存一份不可变的最近结束回执。再次取消可以取回原回执；复用该已完成 actionId 发另一动作会被拒绝。缓存只在本次运行的内存中，App 重启或缺失回执不构成旧动作已结束的证明。
- Native 与 Flutter 的 Host 身份、预算、取消和回执校验共用 `managed-sdk-execution`，各 provider 保留明确协议和连接端口。设备恢复增加 Native，继续使用派发时保存的包名和传输配置，不替换目标、不重放。
- 结果新增 `executionReceipt`，普通执行历史、Intent/Script action-receipt 都保存它。恢复命令自身另存一条历史，原未知结果不改写。Native 手势原有 `completion` 字符串继续表达手势状态，两者没有覆盖关系。
- `executionReceipt` 包含经过校验的身份、settled/dispatched/ambiguous 和响应摘要；响应哈希来自去掉 Host 元数据后的 SDK 结果 JSON，不是原始 HTTP 字节。`native.action.settled` 手机事件带原动作身份，不带输入正文。结束证明、归档完整性和业务断言分别判断。

公开入口仍为 95 个，见 [3K 机器合同](audits/2026-09-09/command-contract-phase3k.json) 和 [发布合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)。

## 接受的构建与检查

证据根目录为 `build/ai_app_bridge_artifacts/command-production-phase3k-2026-09-09/`。固定设备为 `b46093e6 / PKR110 / API 36 / transport_id 36`，Host 为 macOS、Node 26.3.0。基线 HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`；此前 203 个修改/未跟踪文件的哈希已保存，本轮没有提交、推送或发布。

| 检查 | 接受结果与证据 |
| --- | --- |
| Host 全套 | 930/930，0 失败/取消/跳过，23752.55625 ms；`logs/host-all-accepted.log` |
| Android 单测 | 158/158，0 failure/error/skip；`sdk-unit-results/`、`sdk-unit-verification.json` |
| SDK 真机集成 | 35/35，68.938 秒；30 个真实 Native View/主线程/HTTP 场景，5 个受控 Flutter MethodChannel 场景；`logs/native-sdk-device-second.log`、`accepted-sdk-traces/` |
| 干净 npm 安装 | native 安装生命周期与编译、95 项公开能力、Intent/Script/权限/退出合同通过；95 个非依赖发布文件及 6 个随包依赖文件逐字节核验 |
| Native 手势 | Intent 3 个主要手势均关联本次手机事件；JS/Python 各 9 项设备断言 passed，分别 8463/8388 ms；`native-gestures/report.json` |
| Native 输入 | Intent 2 次目标绑定输入；JS/Python 各 3 项设备断言 passed，分别 614/648 ms；`native-input/report.json` |
| Native 执行中取消 | 先确认真实 DOWN，再取消公开 Script；SDK CANCEL 后释放占用；`native-cancel/report.json` |
| Native Host 崩溃恢复 | 实际 SDK 完成响应丢失、SIGKILL、多入口阻断、恢复再次丢失响应、原身份回执恢复；`native-ownership-second/report.json` |
| 新 SDK 的真实 Flutter | LocalSend Intent/JS/Python 各 11 次动作、22 项检查，24697/21116/21852 ms；`flutter-flows/report.json`。Intent 为外部控制器检查，JS/Python 为设备断言 |
| 持久回执和离线归档 | 新进程读取真实分段 FactStore 的恢复凭据；重新打开存储导出 17 份归档，55 份 SDK 动作凭据保持一致；禁用设备连接及原存储后，搬移副本 17/17 integrity verified |

| 安装物 | SHA-256 |
| --- | --- |
| npm tarball | `46959dfd30b156f6f904eab2ff50dda83b2ebe8e55097a4f6a6e3aa0ea52da92` |
| SDK instrumentation APK | `cef661140df1c90c4f187c25240a0b8e5f01546f94f4f192a29d68a885cc69e4` |
| NotallyX + 新 SDK | `ee6d5ecd901c3a620eac1380073371ad43d585fd4154dacfd689235579638e36` |
| LocalSend + 新 SDK | `3dc6f2c77e485986c43a8c78330ede31cc2d3bf4d3a0b8526a30880aa9a82888` |
| LocalSend 引用的 Android AAR | `ad2398e858577551f5bce16c6a246c9bf05d68654877075fef2c95e9bbf89bab` |

NotallyX 和 LocalSend 通过公开 `install-apk` 启动安装 Intent，再独立核验手机安装 APK 字节。SDK instrumentation APK 使用直接 ADB 作为测试环境准备，未冒充安装 Intent 验收。本轮没有重跑此前的 45 项 Flutter 单测；实际 Dart 组合由新 LocalSend APK 的公开三入口流程验证。

## 真机故障与独立结果

Native 崩溃动作是 `ownership-1788911753995`。控制器从真实树读取搜索按钮位置，公开 `tap` 仅派发一次，手机进入搜索页。Host 故障代理记录真实 SDK 结束响应但不交付；原 Host 存活时另一 Host/包名被 `target_busy` 拦截。SIGKILL 后，新 Host、CLI、Intent、JS/Python 均被 `device_ownership_unresolved` 拦截。恢复响应再次丢失时继续占用；取得原 SDK 回执后才解除，随后恢复列表。

本场景证明“手机动作已经结束、Host 尚未取得证明”时的崩溃恢复，不能代替执行中 App 回调阻塞。后者由 SDK 真机用例单独验证：输入连接阻塞期间的取消返回未知，后续点按被拒绝；释放回调后原操作真正收尾，两个编辑器均未发生迟到文字提交。已完成输入的回执可以按原身份取回，不会重复写入；更换 runtimeEpoch 无法恢复旧操作。

公开手势取消为 `script-1788911653247-1:action-1`，原定 8000 ms 长按；控制器确认 started 后取消，Host 本次收尾 46 ms，SDK 触摸流 elapsed 54 ms，实际 CANCEL，未进入笔记选择状态。时间来自各自时钟，只描述本次短场景。

独立读取全部业务 SQL 表和偏好后，NotallyX 前后 SQL SHA-256 均为 `16090377a96644cacb5f82f11f257d7479573652efd4463d448a07676a11db21`，偏好均为 `f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`，BaseNote/Label 各 11 条。LocalSend 偏好原始字节前后均为 `4917a125543d01f51b35a36eabb92a416eadeae758ac75bbc99ee45942fe8b80`。这不代表所有文件系统状态都相同。

17 份离线归档包含正向流程、真实取消、两个安装、首次控制器失败后取消的 Intent，以及三个按预期被拦截的操作。55 份 SDK 凭据中 22 份 Native、33 份 Flutter；检查原 actionId/runtimeEpoch/settled，重开存储前后的 action-receipt 逐项一致。恢复命令的凭据另从已关闭的真实分段 FactStore 查回，见 `native-recovery-disk-verification.json`，未声称通用执行历史已有独立公开导出命令。

## 保留的失败

首轮 SDK 为 34/35：验证代码在释放阻塞回调后立刻索取结束回执，实际仍是合法 pending。修正测试等待真实 UI 线程空闲后再核验，第二轮 35/35；没有为此改生产逻辑。首次 APK、日志和 trace 均保留。中间 Host 测试保留旧 fixture/能力缺失预期失败，最终全套通过；恢复持久性测试进一步改为真实分段存储，并已包含在最终全套中。

首次 Native 崩溃控制器误传 `x/y`，被公开 schema 以 `tapX is required` 拒绝，未派发；修为真实合同后从新目录重跑通过。首次搜索准备控制器误从轻量 `lastAction` 读完整凭据，真实点按成功但控制器失败并取消 Intent；改从持久 action-receipt 检查，原失败也单独归档。首次落盘检查误用旧 SQLite FactCache，读到空集合；随后通过生产分段 FactStore 正确查回，并将持久性单测改为实际后端。

LocalSend 首次构建缺少本项目 Rust 环境，第二次直接执行了无执行位的环境脚本；使用已存在的工具链脚本经 bash 启动后构建成功，三份日志保留。没有修改样例业务或安装新的工具链来绕开问题。

## 下一关与范围

Native/Flutter 的本轮结束凭据关口已经有真实证据，继续推进 ADB/UIAutomator、安装和 H5 等普通 SDK HTTP 的远端结束合同。尤其要检查未携带派发状态的 HTTP 错误是否被误认为确定失败；不能将本轮严格 Native/Flutter 保证泛化到所有 provider。本地子进程退出、空闲 SDK 或换运行实例，都不能自动清除未知远端操作。

仍需明确普通命令历史写入失败的生产策略、安装整体预算和故障恢复、更多权限组/Android 版本、serial 别名与其他 Host OS/Node、iOS/H5/Web 目标及持久查询、原四 App 固定覆盖、持续运行和压力/性能门禁。本轮短流程耗时不代表整 App/整机回归性能。总目标继续保持全体系生产化。
