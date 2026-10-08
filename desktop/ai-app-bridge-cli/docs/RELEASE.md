# 0.4.5 统一补丁发行检查

Android WindowManager 按字段解析，支持裸 mAttrs 和 WM.LayoutParams 前缀、合法空白、
跨行、字段顺序与附加属性。缺失、冲突和未知保留诊断及原始依据，不补窗口归属。
CLI/MCP/Script/Intent 把前台不匹配、变化和探测失败作为观测与 warning，保持明确目标。
Android SDK/UIA 根据原节点引用执行并核对回执，不因窗口失焦单独否决或隐式换目标。

## 放行检查

1. 先失败后修复的解析和动作回归；缺字段、冲突、未匹配节点、失效引用、窗口变化与
   原回执恢复回归。Host 完整功能及串行性能检查。
2. Android build/lint/test；UIA bundle 由本次源码重建并核对 hash。
3. 仓库外安装最终 tarball，核实 CLI/MCP/Script 实际加载版本与 warning/派发合同。
4. SUNMI K2 Mini API 25 指定 SIT App 的真机 SDK、Host 与
   Runtime 对应候选；Bridge 点击收银台，以原回执、刷新树和截图确认页面变化。
5. Swift 构建、Flutter 分析/测试/发布 dry-run、Web 测试构建及配套版本检查。

统一版本为 0.4.5，嵌入式 native store 保持 0.2.0。已派发未知结果遵守原执行合同。
不得把静态测试、传输成功或 warning 当成真机业务验收。

## 发布与本机升级

经明确发布授权且门禁通过后，冻结提交和新 tag，发布 GitHub/JitPack、npm CLI/Web、
Flutter SDK/helper；核对公开版本、下载文件及归档与受检源码一致。保持旧 tag。
全局包与实际使用的 Runtime/MCP 升级后核实路径、版本、compatible 和实际调用。
保留各 Runtime 的事实目录与配置。公开可用后再更新 remote-smoke 的精确依赖。
发布结果、真机证据和剩余限制记录在发行交付文档，不能只凭版本号声明完成。
