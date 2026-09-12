# 命令生产化第三阶段 E：Native 目标引用与执行前校验

Native Intent 的 `tap` / `inputText` 以及 `tap-text` 的 Native 分支已接入 SDK 目标校验。Host 不再把语义选择降成一个坐标交给 SDK；SDK 在 UI 线程内确认运行实例、焦点窗口、View 身份和操作条件，再点击或向指定编辑器提交文本。本阶段通过 **887 项 Host 检查、134 项 Android SDK 单测、干净包与 OPPO 固定场景验证**。

这是 Native 点击和输入的首批执行关口。Native 手势、Flutter、系统 UIA、跨进程仲裁、其他平台、四 App 完整矩阵和压力验收仍未完成。UI 拥堵及自定义焦点回调的手机故障注入也仍需补充；不能据此宣布全部 SDK 原子动作或生产验收完成。本轮没有改 NotallyX 产品功能。

## 合同与实现

- SDK 树提供 `aab.native-target/v1` 引用，绑定 runtimeEpoch、windowId、View 实例 UUID 与语义祖先摘要。UUID 放在 SDK 专用 View tag 中，随 View 生命周期释放；不建立长期保留 View 的快照仓库。几何变化不进入摘要，同一 View 移动后可使用新位置。
- `/v1/action/tap-target` 和 `/v1/action/input-target` 只接收 selector、targetRef、actionId 及输入文本，不接收坐标。保留独立坐标原语端点。专用端点也防止旧 SDK 忽略陌生输入字段后误向焦点编辑器写入。
- SDK 在一次 UI 线程任务中重新选择唯一、可见、可用、未被祖先裁剪的目标，核对焦点窗口与实例引用，并检查点击命中对象属于目标或其响应祖先。输入要求明确 editable，绑定该 EditText 的输入连接，在焦点及连接回调后再次检查。若请求焦点之后失败，回执如实报告 `dispatched:true`。
- 旧 SDK 缺少引用或专用端点，明确返回 `native_atomic_target_unavailable`，选定的 Native 尝试不改走坐标、Flutter 或 ADB。必要坐标命令保留；坐标落在当前焦点窗口之外时拒绝，不再选另一窗口或回到底层 Activity。无坐标的 `input-text` 要求当前焦点编辑器，删除任选第一个可用编辑器的行为。
- SDK UI 等待超时或等待线程中断时，取消尚未开始的排队任务并移除回调。若变更任务已经开始，超时回执为未知派发状态、`ambiguous:true`。不能撤回已发生的 App 回调，也不能把业务结果变成事务。

公开使用边界见 [命令合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md) 和 [Native 编辑说明](../desktop/ai-app-bridge-cli/docs/INTENT_NATIVE_EDITING.md)。原始动作、复合 Script 和 Intent 继续使用各自必要职责；本阶段没有增加同义公开命令。

## 验证

`npm run check`：**887/887**，0 失败、取消、跳过，**16471.18675 ms**，日志 `build/phase3e-host-full-first.log`。新增 Host 用例覆盖专用端点的无坐标载荷、缺失/畸形引用、同名实例替换、选定 Native 后不换通道、坐标原语和互斥输入目标。

Android SDK `:ai-app-bridge-android:testDebugUnitTest`：**134/134**，0 失败、错误、跳过，日志 `build/phase3e-sdk-tests-accepted.log`。新增 10 项目标合同用例及 3 项队列门闩用例；后者包含 1000 次取消/执行竞争，核对恰有一个获胜和取消后无迟到副作用。几何移动、错误窗口/运行实例、重复目标、不可编辑、裁剪和作用域在 SDK 单测中覆盖。这不是手机主线程阻塞注入的证明。

干净 npm 包：`build/ai_app_bridge_artifacts/command-production-phase3e-package-2026-09-09/`。SHA-256：`ece9e2e03a1e4cda79ee47aaff65668ebd4c7209fa9c1be4f3ee2099050e1791`。真实 npm install 与 native node-gyp 生命周期、2 个 MCP 工具、93 项命令、49 类无效执行合同、自主预算、JS/Python、权限与取消/关闭/恢复验证均通过。89 个非依赖、非 npm 规范化 package.json 文件与工作区一致，见 `source-match.json`。后续手机操作执行的就是该安装目录中的 MCP。

本轮产物目录从 09-08 延续为 `build/ai_app_bridge_artifacts/command-production-phase3e-2026-09-08/`。授权设备为 `b46093e6` / PKR110（系统品牌字段 OnePlus），包名 `io.github.mobileaidev.notallyx.sample`。APK 通过现有安装 Intent 提交并由安装物独立核验，实际安装 SHA-256：`b034afa36eef9c8e409bcbb05107e4d80677945663b1ff98b6a556fb7b78ec28`，固定副本为 `native-target.apk`。本次安装没有出现需要 Agent 决策的系统页面，不算安装安全弹窗分支验收。

| 手机验证 | 实际结果 |
| --- | --- |
| 14 次普通 Native 文字/无障碍名称点击 | 回执均包含 `aab.native-target/v1` 和已派发标记 |
| 主题弹窗打开后，直接向 SDK 提交底层旧引用 | `native_selector_not_found`，未派发 |
| 关闭再打开同名弹窗，提交旧“取消”引用 | `native_window_changed`；新弹窗和按钮引用保持不变 |
| Intent 按资源 ID 输入唯一笔记标题、清空 | 两次指定编辑器输入成功，保留无坐标请求、回执和完整 Host 归档 |
| 输入后再次直接向 SDK 提交空搜索框的旧引用 | `native_target_changed`；当前查询和唯一结果未变化 |
| 返回页面并重建同名搜索框，向 SDK 提交旧点击/输入引用 | 同一 windowId、新 viewId；两次 `native_target_replaced`，新的空输入框未变化 |
| Intent 主题打开、遮挡检查、取消 | completed；背景点击拒绝、背景文字等待按预算超时 |
| JavaScript / Python 同义主题回归 | 各 6 项检查，2 次派发、1 次被拒动作；分别 2504 / 2788 ms |
| 原语回归 Script | 4 项检查：坐标点击可用、无焦点输入拒绝、弹窗外坐标拒绝、Native 语义取消成功 |

以上 5 次 SDK 失效引用拒绝是直接提交冻结引用到真实 SDK 的结果，绕过了 Host 的二次观察，因而能检验 SDK 自身的拒绝行为；不是仅有 Host 提前拦截。独立核验程序和逐次请求/响应在 `device-atomic/` 及 `verify-native-artifacts.js`。

独立读取的偏好 SHA-256 前后同为 `f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`；全部业务表规范化 SHA-256 前后同为 `16090377a96644cacb5f82f11f257d7479573652efd4463d448a07676a11db21`。BaseNote 11、Label 11，其他表不变；查询的唯一标题对应数据库 noteId 11。设置、弹窗、输入查询及恢复设置截图已查看。原语补测偏好也保持不变。

输入 actionId 在手机存储中查到 `ui.interaction` / `ui.changed` 两条已提交事件及手机事实引用。该 connected-history 查询如实返回 `partial/capture_gap`，本阶段只认定这两条记录存在和关联正确，不认定完整历史窗口，也不用它证明其他事件不存在。完整采证覆盖仍遵循手机存查子计划。

安装、搜索 Intent、主题 Intent、两种语言 Script 和原语 Script 共 **6 份归档**，搬移到新目录后，在不可用 Store 与 ADB 配置下通过公开 MCP 离线核验。归档完整性和执行 completed 均不替代业务断言或外部截图、手机事实载荷。

## 保留的失败与范围

初次 Host 定向全量发现 17 个旧夹具没有 SDK 引用。正向夹具现在明确使用合成协议元数据；原 NotallyX 冻结树只在测试副本上增加合成引用，未修改历史证据。SDK 首跑 133/134，一项测试把未知字段预期写成 invalid_argument；实际合同为 unsupported_argument，修正预期后通过。

控制器的旧函数名、`launch`/`after-action`、以及原语 Script 的 x/y 公共参数误用均保留。对应请求未派发或未达到 SDK，不能计入 SDK 拒绝用例；修正到当前能力合同后重新运行。原语首跑 failed 保留在 `device-primitives/`，接受结果单独保存在 `device-primitives-accepted/`。交互控制器关闭其 MCP 后仍保留父进程，已只终止本轮明确拥有的三个控制器 PID；没有残留本轮 MCP/ADB 任务。

分支仍为 `codex/script-intent-isolated-rebuild`，HEAD `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`。未提交、推送或发布；前序工作区与原 Flutter 锁文件保留，锁文件 Git blob hash `465ddc1692212151de90707ace54d232f3b16de6`。本阶段 baseline、源码指纹、构建/测试日志和变更清单另存于产物目录。

下一步继续 Native 手势与 Flutter 的执行时目标校验，并补 UI 拥堵、焦点回调重入的集成故障场景。随后推进跨进程物理设备独占、安装总截止时间/故障、更多权限组、H5/iOS/Web 合同、原四 App 与长期压力关口，保持完整计划范围。
