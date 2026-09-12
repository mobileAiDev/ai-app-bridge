# 第三阶段 B：前台语义定位与文字等待

本轮完成 Bridge 共用目标选择和 `wait-text` 重整，保留 93 个公开入口。样例只用来验证通用合同，未修改 NotallyX 业务代码。整体生产目标仍在推进，下一项是普通 Intent 的总预算、取消收尾和终态持久化。

## 已实现

- Native 普通文字点击、Intent 选择和页面摘要共用最前面窗口的判断。前台弹窗、未知或禁用的前台根节点会阻挡后台目标；控件中心需要处于窗口和祖先范围内。
- `tap-text`、`tap-uia-text`、`tap-flutter-text` 共用文字点击流程：精确唯一选择、派发前重新观察、前台核对、一次派发。自动发现保留；选中来源后的重验失败不会改用另一个来源操作。
- Native Intent 的点击、输入、长按和滑动，以及 Flutter/UIA 点击，会重新定位并比较语义身份。布局移动使用新坐标；目标身份改变、重复或失去操作资格时拒绝派发。Native 输入要求真实 `editable:true`，删除标准 EditText 类名猜测。
- 删除 Intent 的旧 UIA 模糊文字分支。顶层 `text` 与显式 selector 均要求精确唯一匹配。
- `wait-text` 使用 `timeoutMs`、精确文字数组和同一次前台观察。移除状态 JSON/多来源拼接搜索；元数据、隐藏窗口和其他 provider 的文字不能凑出通过结果。纯消失或单独 Activity 条件必须指定 provider。读取失败返回 `observation_unavailable`，超时返回 `deadline_exceeded`。
- `requireText`/`absentText` 每组最多 64 项，注册表实际执行数组上限校验。CLI 通过重复参数表达数组，逗号保留在文字中。公开合同及仓库/随包 Skill 已同步。

参数与限制见 [命令合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)；完整目录快照见 [本轮 93 项合同](audits/2026-09-08/command-contract-phase3b.json)。

## 验证结果

最终源码测试 **800/800 通过**，0 失败/跳过，耗时 **15.939 秒**。覆盖布局变化、弹窗遮挡、重复目标、Flutter 节点 ID 被重新使用、观察期间超时/取消、跨来源条件拼接、纯消失读取失败、精确逗号文字及数组边界。

发行包实际执行 `npm pack → 干净目录 npm install → 安装后的 MCP`，原生依赖完成构建。85 个非依赖发行文件与最终源码字节一致（package.json 由 npm 规范化，单独排除）。两工具/93 命令、权限四种结果及 JS/Python 关闭收尾检查通过。

- tarball SHA-256：`6407cce651d6aabeebc93a4a6656621a158d53b4213497c988682bd56d140500`
- 主机日志：[phase3b-full-final.log](../build/phase3b-full-final.log)
- 安装结果：[package report](../build/ai_app_bridge_artifacts/command-production-phase3b-package-final-2026-09-08/report.json)
- 源码核对：[source-match.json](../build/ai_app_bridge_artifacts/command-production-phase3b-package-final-2026-09-08/source-match.json)

真机使用已授权设备 `b46093e6 / PKR110` 和 `io.github.mobileaidev.notallyx.sample`。其系统镜像当前报告品牌 OnePlus，设备按已授权序列号和型号锁定，未扩展到其他手机。APK SHA-256 仍为 `ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。

实际流程均为：设置页打开主题弹窗，拒绝被遮住的“外观”点击，验证后台“外观”不能满足等待，再取消弹窗。执行使用最终干净安装包。

| 流程 | operationId | 结果 |
| --- | --- | --- |
| Intent | `semantic-1788876038623` | 完成；后台点击 `target_not_found`，后台文字等待 `deadline_exceeded` |
| JavaScript | `script-1788876041257-1` | 完成，2.117 秒；6 项程序检查，2 次派发、1 次拒绝派发 |
| Python | `script-1788876043371-2` | 完成，2.291 秒；同一流程、相同结果 |

手机实际偏好文件前后 SHA-256 均为 `f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`。截图显示弹窗遮挡与取消后的设置页；当前主题保持“系统主题”。这是短流程的命令验收，不是整 App 性能测量，也不是 Script assertion 系统的新增业务断言验收。

三个执行归档复制到新路径后，在新 MCP 进程、不可用 Host Store 路径及不存在的 ADB 路径下全部通过完整性核验；安装包对 65 项条件在设备访问前返回 `invalid_argument`。归档只证明保留的 Host 记录及引用闭包；手机载荷和外部截图的包含范围以 manifest 为准。

- [真机报告与冻结源码](../build/ai_app_bridge_artifacts/command-production-phase3b-2026-09-08/device-packed-final/report.json)
- [离线核验](../build/ai_app_bridge_artifacts/command-production-phase3b-2026-09-08/device-packed-final/offline-verification/report.json)
- [主题弹窗截图](../build/ai_app_bridge_artifacts/command-production-phase3b-2026-09-08/device-packed-final/theme-dialog.png)
- [取消后的设置页](../build/ai_app_bridge_artifacts/command-production-phase3b-2026-09-08/device-packed-final/settings-after.png)

## 保留的失败与剩余边界

先前测试日志保留：最初从错误工作目录运行导致两项生成路径断言失败；旧测试夹具缺少前台事实、仍假定不重读 selector 或不提供合法前台 package，已按新合同修正。首次设备控制器因系统品牌字符串与设备称呼不同而在操作前停止，改为锁定已授权序列号/型号后通过。最后检查发现数组 schema 上限尚未执行，已补校验并重新跑全量测试、干净安装包和真机三轮。

尚未完成：

1. Host 重读与 SDK 实际派发之间仍有时间窗口；SDK 主线程原子 selector/窗口校验需要单独实现和验收。低层 UIA 遍历与祖先规则也继续统一。
2. 普通 Intent 的总预算、正在观察/等待 Agent/动作期间取消、EOF/SIGTERM 收尾和终态持久化；安装/权限已有独立生命周期，不能用普通 worker 的简化取消覆盖其独立结果核验。
3. 跨进程设备仲裁、operation/nested schemas、H5/iOS/Web 等待与平台合同、远端已接受动作的取消边界。
4. 原四 App 完整矩阵、JS/Python 整机同义回归、跨平台真机及持续运行性能关口。当前短流程不能替代这些关口。

本轮未提交 Git、推送或发布；保留原有脏工作区及无关 Flutter lockfile。
