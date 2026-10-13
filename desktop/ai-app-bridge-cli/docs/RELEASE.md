# 0.4.8 统一发行

CLI/MCP、Android、iOS、Flutter、Web 和可选 Bridge 执行器统一发行 0.4.8，
同时更新本机 CLI/skill 与最近使用项目的 Bridge 依赖。设备/Web 协议保持不变。

后续默认统一升级上述版本与当前安装示例，即使某端只有版本元数据变化。
如确实需要分开发行，应先明确原因和依赖关系。历史验收中的实际版本必须保留，
不能为了版本一致改写测试事实。

## 变化

- 可选 Android/Flutter 执行器按包内明确声明的 `sdkReleaseVersion` 解析依赖。
  本次 Host 与 SDK/helper 均为 0.4.8，准备结果分别返回 Host 和 SDK 版本。
- auto 在 8 KiB 以上尝试无损表示，支持可选字段，仍保留完整控件、身份、
  状态及缺失/null 区别；8 KiB 是格式尝试阈值，不是截断或补读阈值。
- 差量观察保留原有 columns 表示，混合诊断数组不会使大页面退化成必须
  补读的结果。明确 `extract:null` 和 Script 内部对象形状保持原合同。
- Script 提供可运行的 JS/Python 例子、完整但更精简的生命周期发现，及
  可编辑的普通 JS Web 辅助源码。已写好的业务程序可直接复用和传参。
- 示例环境探针分别报告显示、前台 PID、App Nap 和 CPU 事实；只给提示，
  不因环境警告阻断测试或改变业务成功结果。

## 验收口径

信息充分时，从 Intent/Script 提交到业务结果验证完成计时，包含页面加载、
网络等待和恢复。首次业务编写单列；显式 agent 决策等待分别报告并保留总时长。
小样本、准备耗时及内部命令求和不能替代整个执行过程，也不作为稳定提速比例。

## 发布检查

1. 冻结实际发行版本，运行 Host 功能和性能回归。
2. 在仓库外安装最终 tarball，核对逐文件哈希、native prebuild、CLI/MCP/npx、
   JS/Python、恢复与关闭。保持全局 Runtime 和其他项目不受验收器影响。
3. 复用原业务源验证 prepared Web 和 Android 路径，保留提交到独立核验的
   时间、原始失败、续跑和清理回执；明确实际 SDK/APK 身份。
4. 完成各 SDK 的构建、测试和发行包检查，再发布统一 Git tag/Release、npm、
   Pub 及 Maven 产物，逐一核对公开版本与归档。
5. 更新本机 CLI/skill 和最近使用项目的 Bridge 依赖至 0.4.8，验证依赖解析
   与构建，并分别记录当前已连接 MCP 客户端和磁盘安装的实际版本。

本次结果和范围见仓库
`docs/RELEASE_NOTES_0.4.8_2026-10-13.md` 与
`docs/WORKFLOW_PERFORMANCE_0.4.8_CANDIDATE_2026-10-13.md`。
