# 0.4.9 统一发行候选

当前状态：本地候选的代码审查、最终安装包验收和指定业务流程实测已完成；
公开发布和本机依赖升级尚未执行。这不证明 npm、Pub、Maven 或 Git tag 中已经存在 0.4.9。

CLI/MCP、Android SDK/Gradle plugin、iOS、Flutter、Web 和可选 Bridge 执行器
统一准备 0.4.9。Flutter 内嵌的 Android 依赖、iOS 源码与 test helper 身份同步更新。
设备/Web 协议版本保持不变。

后续默认统一升级上述版本与当前安装示例，即使某端只有版本元数据变化。
如确实需要分开发行，应先明确原因和依赖关系。历史验收中的实际版本必须保留，
不能为了版本一致改写测试事实。

## 本次候选变化与验收

- Host 的 Android SDK 直连传输、显式路由和按端点/epoch 复用能力信息，
  以及普通命令参考前台查询和截图归属查询的开销调整。最终包已重跑动态混合流程；
  目标身份、不确定结果和原动作回执仍须保留，不得静默换路或重放变更。
- 原始 Script 源码恢复、URL 字节保留、Flutter 部分观察、UIA 可见节点投影、
  iOS 观察失败保留及 Web 错误指引。原始失败和修复后回执均保留。
  UIA 同时补充焦点观察；缺失状态保持未知，不能误报为 false。
- Android HTTP framing 明确拒绝非法长度、过大或截断请求，并限制解析时间；
  已有的合法请求与变更派发合同保持不变。明确未派发的 framing 拒绝保留原错误，
  修正后能继续请求；其他断线仍保留未知结果。
- Host/CLI 与包内 `sdkReleaseVersion` 均为 0.4.9；Android/Flutter 可选执行器
  依赖和运行时身份一致。版本对齐本身不代表各端复杂流程已经通过。

持久化 group commit、设备端树镜像、录屏替代截图和 UIA 连接缓存等实验
不计入本次已交付能力或提速承诺。具体采纳、保留问题和验收范围以仓库
`docs/RELEASE_CANDIDATE_AUDIT_2026-10-14.md` 为准。

## 验收口径

信息充分时，从 Intent/Script 提交到业务结果验证完成计时，包含页面加载、
网络等待和恢复。首次业务编写单列；显式 agent 决策等待分别报告并保留总时长。
小样本、准备耗时及内部命令求和不能替代整个执行过程，也不作为稳定提速比例。

## 版本冻结边界

- CLI `package.json` / `package-lock.json`、各 SDK 发行身份与
  `examples/flutter-workflow-sample/pubspec.lock` 的本地 path 版本同步为 0.4.9。
  第三方依赖的版本、URL 和 integrity 不随发行号改写。
- `web/remote-smoke` 专门消费已发布包，现有 package/lock 仍保持真实的 0.4.8
  公开坐标。0.4.9 Web SDK 发布后再从 registry 更新这一对文件并运行 smoke，
  不预填尚未发布的 tarball URL 或 integrity。
- 内部 FactStore 原生组件和 Playwright 私有依赖容器保留各自的版本；
  它们不是公开 Bridge SDK 发行身份。历史验收及旧 CHANGELOG 段落保留原版本。

## 本地验证结果

- Host 功能回归 1,751/1,751、性能专项 50/50；干净安装的 CLI/MCP/npx、
  JS/Python、native prebuild 和恢复/关闭验证通过。
- 同一个候选 SDK 测试 APK、同一脚本和三个动态 seed，对照公开 0.4.8 Host：
  无额外网络延迟时总时长中位数 10.483 → 7.208 秒；180 ms 延迟并丢失订单响应时
  12.751 → 9.365 秒。十二轮均通过独立账本核对。这是 Host 的 prepared 流程收益，
  不含模型编写、安装或首次冷启动，不泛化成美团全部业务验收。
- 单次 Intent 的 14 条命令用时 4.066 秒；包括观察输入错误后纠正并查询。
- 无 SDK NotallyX 三轮完整业务流程及 SQLite 核验通过；Web Memos 的
  JS/Python 共 185 次命令、83 项断言和六份业务记录通过。
- 三处真实 Host SIGKILL 的 178 项检查通过，诊断加恢复约 1.6–2.2 秒；
  原订单只提交一次。此证据不等同于断电或所有 provider 的故障验收。
- Android SDK/UIA/plugin、Flutter、Web 测试与包检查通过；iOS 共享 Swift
  测试及无签名构建通过，仍无 iOS 真机/模拟器复杂流程运行证据。

完整范围、失败归因和原始证据索引在仓库
`docs/RELEASE_CANDIDATE_AUDIT_2026-10-14.md`。本文件是在执行代码冻结后补充的
结果说明；最终归档仍须验证与实测归档的执行文件逐字节相同。

## 公开发布检查（待完成）

1. 保存本次源码、包哈希和上述本地验收记录；发布的执行文件必须与验证对象一致。
2. 发布统一 Git tag/Release、npm、
   Pub 及 Maven 产物，逐一核对公开版本与归档；公开 Web smoke 锁文件必须
   来自这次真实发布，并通过安装和加载验证。未验证的端保持明确的范围限制。
3. 更新本机 CLI/skill 和最近使用项目的 Bridge 依赖至 0.4.9，验证依赖解析
   与构建，并分别记录当前已连接 MCP 客户端和磁盘安装的实际版本。

公开基线为 0.4.8。它的发行记录
`docs/RELEASE_NOTES_0.4.8_2026-10-13.md` 和历史性能记录保留原样，
0.4.9 的通过结论来自本次最终候选的独立证据。
