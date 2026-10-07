# 0.4.4 统一补丁发行检查

WindowManager 的多行窗口属性可以把完整的 `ty=BASE_APPLICATION` 或数值类型
放在行尾。Host 0.4.3 将这种格式误报为窗口类型缺失，阻断本可确认归属的观察与操作。
本次接受完整类型标记后的行尾，统一 CLI/MCP、Android SDK/plugin/六个执行器、
iOS Swift、Flutter SDK/helper、Web SDK 为 0.4.4。嵌入式 native store 保持 0.2.0。

## 修复与验证范围

- 复用已在真机验证的单行解析修正，不以窗口标题替代实际 owner。
- 保留 owner/package/UID、Activity、进程生命周期、窗口切换和操作前目标守卫。
- 回归 API 25/30/36 的多行属性；拒绝缺失或未知类型、重复属性行、其他应用
  Activity 及验证过程中发生的进程变化。
- 原始真机窗口 dump 在旧解析器失败、新解析器成功。相同候选源码已验证嘀嗒
  分身地图首页及“消息”“我的”两个登录入口，未据此声明账号和完整业务流程通过。
- SDK/Web 执行行为不变，仅同步版本和 Android 依赖；其他应用的初始化问题
  仍由各自诊断与业务验收结果判断。

## 放行检查

1. 前台 owner 与操作守卫回归、Host 完整功能组和串行性能组通过。
2. Android build/lint/test、Swift iPhoneOS 构建、Flutter 分析和测试、Web 测试通过。
   无 test 目录的 Flutter helper 只记录分析和发布验证。
3. 最终 npm tarball 在仓库外安装；CLI/MCP 发现、提取、Script、Runtime 合同
   及四平台 native addon 归档字节检查通过，UIA bundle 与源码构建结果一致。
4. 两个 Flutter 包在已提交源码上完成发布 dry-run；保留历史 changelog。

## 发布与本机升级

推送验收提交和新 0.4.4 tag，核实 JitPack SDK/plugin/六个执行器公开坐标后
发布 Flutter SDK/helper。发布受检 CLI 与 Web npm tarball，latest/next 统一
为 0.4.4，并核对公开下载内容与冻结提交、候选归档及 GitHub Release。
源码版本和上传成功不代替公开下载验证；发布结果单独记录。

全局 CLI/MCP 与活动 Runtime 升级后核实路径、版本及 compatible 状态，保留
各 Runtime 的事实目录和配置。MCP 连接需重新加载客户端后实际调用验证。
remote-smoke 在公开 Web SDK 0.4.4 可用后升级精确依赖和锁文件并验证安装内容。
