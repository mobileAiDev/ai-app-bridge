# 0.4.3 统一补丁发行检查

本次修复 Android 前台窗口 owner 识别，并统一 CLI/MCP、Android SDK/plugin/
六个执行器、iOS Swift、Flutter SDK/helper、Web SDK 为 0.4.3。
嵌入式 native store 保持 0.2.0。发布结果单独记录，源码版本不代表 registry 已发布。

## 修复

- Android 前台判断读取 WindowManager 的真实窗口 owner 元数据，窗口标题不再
  用于推断所属 package，避免标题与实际 owner 不同时误判目标应用。
- 执行前复核窗口生命周期；窗口被替换或 owner 改变时，不沿用旧观察的目标身份。
- 识别没有 Activity 组件的前台系统窗口，同时保留 package allowlist 与 UIA
  目标守卫。无法确认所属 package 的窗口明确返回识别失败。
- SDK/Web 的执行行为不变，仅版本和依赖同步。受检 UIA bundle 随 CLI 发布。

## 放行检查

1. WindowManager owner、标题与 owner 不同、窗口替换、系统窗口及普通 Activity
   场景的回归检查；Host 完整功能组和串行性能组。UIA JVM 测试及 DEX/manifest 同步。
2. 在真实设备验证原失败窗口，再验证普通 App 的观察与交互，保存前台 package、
   UI 树、截图及动作回执。命令成功不代替目标页面或业务结果验收。
3. Android build/lint/test、Swift iPhoneOS 构建、Flutter 分析和测试、Web 测试。
   版本同步不代替业务 App 验收；测试 helper 无 test 目录不记为测试通过。
4. 最终 npm tarball 在仓库外安装；CLI/MCP 发现、提取、Script 与 Runtime 合同
   检查通过。未变更的四平台 native addon 校验归档字节。
5. 两个 Flutter 包发布 dry-run；源码和公开依赖版本一致，历史 changelog 保留。

## 发布与客户端升级

推送验收提交和新 0.4.3 tag；核实 JitPack SDK/plugin/六个执行器坐标后发布
Flutter SDK/helper。发布受检 CLI 与 Web npm tarball，并将 latest/next
统一为 0.4.3；核实公开下载 checksum，再创建 GitHub Release。
旧 tag 保留。需要凭据或人工登录时明确记录阻塞，不把未发布渠道写成已发布。

全局 CLI 升级后核实路径、文件校验值及运行 Runtime 的版本和 compatible 状态。
已有 MCP 连接需重连加载新版客户端，并实际调用验证。remote-smoke 保持已发布
Web SDK 的精确版本，待 0.4.3 公开可用后再升级依赖和锁文件并验证安装内容。
