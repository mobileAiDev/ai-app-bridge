# 0.4.7 统一发行检查

本次统一 CLI/MCP、Android SDK/plugin/执行器、Flutter SDK/helper、Web 和
iOS 源码版本。嵌入式 native store 保持 0.2.0。

## 发行范围

- 效率：减少重复连接、目标采集及启动探测；Script 决策与继续可在同一次调用
  等待下一问题或完成结果。新增可选 delta 观察交付，保留完整结果查询入口。
- 能力：现有 Intent、普通 JavaScript/Python Script 连续操作、局部分支、
  实际网络等待和动态询问；Web 提供无标签控件的真实祖先文本，完整观察对象
  可以直接用于 Web/H5 动作，无需手动剔除诊断字段。
- 恢复：失败结果保留原因与进度；显式检查点继续、取消和强停仍可用。
  Flutter 执行器绑定实际 Activity，多引擎不再将动作误交后台页面。
  结果未知的动作保留原记录，不自动重放。
- 正确性：目标身份、回执、覆盖和截断信息独立于附加诊断；权限与前台
  信息不会平白拦截已明确目标的动作。Script 计时正确记录 agent 等待。

已知信息充足时的连续执行与首次探索分别计时。首次 Web 探索仍有分钟级
成本，解锁状态下的 Android 冷启动慢轮仍未归因。局部 CRC 微基准收益
不作为实际 App 启动提速证明；本版本没有新增 iOS 运行验收。

## 发布检查

1. Host 完整功能与串行性能回归；UIA 源码和 bundle hash 一致。
2. Android build/lint/test、Swift iPhoneOS 无签名构建、Flutter 分析/测试和
   发布 dry-run、Web 测试构建、生成 H5 四份副本一致。
3. 冻结版本后，在仓库外安装最终 tarball，验证 native prebuild、CLI/MCP、
   Script/Intent、恢复入口及命令合同；归档逐文件核对冻结源码。
4. 复用本轮真实 Android 模拟器选择器、观察、恢复及组合流程的原始证据；
   不把 Host 基准当作真机提速，也不把模拟器通过声明为所有 OEM/iOS 验收。
5. 发布 GitHub/tag、JitPack、npm CLI/Web、Flutter SDK/helper；核对公开归档。
6. 升级本机 CLI、MCP 接入和 skill，保留 Runtime 配置和事实记录；更新近期
   项目对应依赖并验证解析。公开可用后更新 remote-smoke 的精确依赖。

发行范围及已知限制见仓库 `docs/RELEASE_NOTES_0.4.7_2026-10-13.md`，
完整实测记录见 `docs/WORKFLOW_PERFORMANCE_PLAN_2026-10-12.md`。
公开制品、本机升级和项目依赖结果将在发布后单独记录。
