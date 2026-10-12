# 0.4.6 统一发行检查

本次统一 CLI/MCP、Android SDK/plugin/执行器、Flutter SDK/helper、Web 和
iOS 源码版本。嵌入式 native store 保持 0.2.0。

## 发行范围

- 效率：Script 独立读取并行、队列背压与写入顺序，Python 消除隐式控制往返；
  默认 auto 完整或无损压缩响应，仍超预算时提供部分视图和原响应查询入口。
- 能力：Script 默认支持全部注册命令；Intent 支持 Bridge、Script、子 Intent
  和封装 ADB；设备级任务不强制应用包名。组合选择器区分按钮、长文本及容器。
- 恢复：旧 UIA 会话审计不阻止启动；独立 Runtime owner 元数据和强停入口；
  损坏状态先归档，错误提供适用的简短恢复命令。未知结果不自动重放。
- 正确性：保留真实执行状态、目标身份、原始回执、采集覆盖和文本截断信息。
  前台及历史诊断交给 agent；平台真实失败仍明确报告。

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

发行提交、公开制品、当前连接和项目升级结果见仓库
`docs/RELEASE_HANDOFF_0.4.6_2026-10-12.md`。此前审查及验证边界见
`docs/AGENT_CHOICE_AUDIT_2026-10-12.md`。
