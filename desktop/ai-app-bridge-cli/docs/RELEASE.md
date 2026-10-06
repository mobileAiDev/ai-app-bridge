# 0.4.2 统一补丁发行检查

本次补齐 Android 卡死任务的强制停止与占用重置入口，并统一 CLI/MCP、
Android SDK/plugin/执行器、iOS Swift、Flutter SDK/helper、Web SDK 为 0.4.2。
嵌入式 native store 保持 0.2.0。发布结果单独记录，源码版本不代表 registry 已发布。

## 修复

- `device-ownership force-stop` 在 CLI/MCP 客户端独立执行，绕过挂住的
  Runtime、执行队列和版本检查；终止旧 Host 及共享 Host 的子进程和任务。
- 手机 UIA 增加强制 reset：停止旧进程，在原 owner.lock 下归档未知/损坏记录，
  为新 epoch 清出可用空间。普通 cancel/reconcile 的原回执合同保持不变。
- 原任务结果保留为 `force_stopped/unknown`；占用错误附简短 recoveryHint。
  手机断开时本地占用仍释放，保留 reset-required 标记，重连后重复重置。
- SDK/Web 的执行行为不变，仅版本和依赖同步。新 UIA bundle 随 CLI 发布。

## 放行检查

1. 新增未知回执、活进程、并发占用、离线重试及提示合同回归；Host 完整功能组
   和串行性能组通过。UIA JVM 测试通过，DEX/manifest 同步到 CLI。
2. OnePlus b46093e6 的旧 admitted 操作真实解除；新会话再次观察和操作成功，
   占用返回 idle。保存强制停止事实和新操作原始回执。
3. Android build/lint/test、Swift iPhoneOS 构建、Flutter 分析和测试、Web 测试。
   版本同步不代替业务 App 验收；测试 helper 无 test 目录不记为测试通过。
4. 最终 npm tarball 在仓库外安装；CLI/MCP 发现、提取、Script 和强制停止
   合同通过。未变更的四平台 native addon 校验归档字节。
5. 两个 Flutter 包发布 dry-run；源码和公开依赖版本一致，历史 changelog 保留。

## 发布与客户端升级

推送验收提交和新 0.4.2 tag；核实 JitPack SDK/plugin/执行器坐标后发布
Flutter SDK/helper。发布受检 CLI 与 Web npm tarball，并将 latest/next
统一为 0.4.2；核实公开下载 checksum，再创建 GitHub Release。
旧 tag 保留。需要凭据或人工登录时明确记录阻塞，不把未发布渠道写成已发布。

全局 CLI 升级后核实路径/版本/运行 Runtime。已有 MCP 连接需重连加载新的
客户端控制入口。遇到旧占用可使用新 CLI 的 force-stop，不必等待旧任务。
