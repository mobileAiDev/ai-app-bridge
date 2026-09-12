# Android H5：页面绑定、Intent 和 Script（2026-09-12）

本轮由 Wikipedia 实际接入暴露的 Android H5 Intent 缺口驱动。已补 SDK 和公共执行入口，受控真实 WebView 的 Intent → Script 已验证；Wikipedia 的文章/阅读列表业务尚未通过。

## 最终实现

- `h5-dom` 返回 `aab.android-h5-target/v1`，绑定 runtimeEpoch、包、进程、Activity、窗口、WebView、documentId 和 URL。多个可见 WebView 必须明确选择，替换后的页面/元素不复用旧目标。
- Android Intent 正式支持 `provider:h5`，可用 `observationTarget.webViewId` 选择观察对象。决策保留原 observation 和 actionId，经共享 typed H5 port 执行。CLI、MCP 和 Script 使用同一 Runtime 与参数契约。
- click/input/scroll 使用 `{elementId|text|ariaLabel, tag?}`；input 改为 `text`，允许空串。删除 Android H5 的 CSS string/targetText/exact 参数。Flutter H5 显式 adapter 仍保留它自身契约。
- 点击和输入分 DOM 检查、原生遮挡/裁剪检查、最终 DOM 校验。窗口坐标换算覆盖 Activity 与 Dialog。原生变换及非标准 WebView 几何返回明确不支持错误。
- 每次 renderer 调用都等待原始 callback 和 Java invocation 返回；probe 后取消阻止后续 mutation，提交后抛异常仍保留原始回执。没有强制释放或重放。
- `h5-wait` 改为同一 WebView 的只读观察轮询。expert `h5-eval` 必须携带 observed page。Android/iOS 共用 `shared/h5/renderer.js`，三个生成副本检查通过。
- 移除旧 Android eval DOM 脚本、旧测试资源生成器及资源；重写真实 WebView 验证工具，清除旧端口发现和 CSS selector 依赖。

详见 [公共契约](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#android-h5-execution-and-dom-operations)。

## 实际证据

设备为已授权 OPPO `b46093e6`（PKR110）。受控页是真实 Android WebView，编辑结果与点击次数由独立 Android JavascriptInterface Witness 记录；它只验证执行能力，不能充当复杂业务 App 的验收。

最终验证使用干净 npm 安装包，原生绑定真实编译。CLI 创建 Intent，MCP 读取同一个 Intent；MCP 仅断开连接后，CLI 继续输入和点击。随后运行同一份 Agent 编写的 Script 三次：

| Script | 时间 | 断言 | 独立 Witness 点击数 |
|---|---:|---:|---:|
| 第 1 次 | 3.435 秒 | 4 passed | 2 |
| 第 2 次 | 3.563 秒 | 4 passed | 3 |
| 第 3 次 | 3.434 秒 | 4 passed | 4 |

每次含清空、Unicode 输入、只读等待、一次点击、DOM 断言、截图及 3 个原始 H5 action 回执。Intent 的点击数为 1，随后增至 2/3/4，文本均为 `Android H5 回归 café 🧪`。

- Script SHA-256：`2af1d793d0a8475e1480558d228caa8974a0ff77ae2204e859357656e2be2392`。
- 最终 SDK test APK：`4991a4fdb85a8c4aebc7b191f153ba663a9318bfaad27f1699ad2d52e3f3a228`，安装设备读取值与冻结副本一致。
- 最终 AAR：`2554429d4646d7abf6e6e8369c03c64f8d93df4a3ef974198ecc0c919a66c7db`。
- 最终公开流程 1 份 Intent + 3 份 Script 归档均离线核验通过。Runtime 已明确停止。
- H5 Host 定向 21 项通过；参数/Script 监督器 36 项通过；既有 Intent 路由、摘要与 iOS H5 相关检查通过。
- Android H5 task JUnit 9 项通过。真机 14 个边界案例通过（另有 1 个按需公开流程用例在该组跳过）；最终 invocation 修改后新增异常提交、probe 后取消及实际点击/输入 3 项定向通过。最终干净包公开流程另行通过。

证据目录：

- `build/ai_app_bridge_artifacts/android-h5-repro-20260912-final/`：最终公共入口、4 份归档、Witness 与截图。
- `build/ai_app_bridge_artifacts/android-h5-final-sdk-20260912/`：最终 APK/AAR 冻结副本及安装核对。
- `build/ai_app_bridge_artifacts/android-h5-public-20260912-01/`：最初人工编排 Intent/Script 与过程失败记录。
- `build/ai_app_bridge_artifacts/android-h5-package-01/`：干净安装与三入口验证。

过程失败没有删去：首轮熄屏导致窗口未聚焦，已停止并唤醒；旧 Dialog 测试 WebView 实测高度为 0，设置明确布局尺寸后通过。第一次跨入口验证误用了测试 helper 默认 `stopRuntime:true`，它主动停止并取消了 Intent；修正为 `stopRuntime:false` 后验证真实的 MCP 断连续接。第一次离线 verify 漏传 manifest hash，补齐后成功。以上均没有记为业务通过。

## Wikipedia 与下一工作项

最终 AAR 已重新构建进同一固定上游提交，独立开发包通过安装 Intent 更新，APK SHA-256 `a78c0898ee6a5a5d38da87ff76b432f8e7d70d3091127bbaba40ab05873782c8` 与设备一致，没有修改业务代码。

公开 `launch-activity` 打开真实“月球”链接后，Intent 用 UIA 关闭年度回顾引导。实际文章 summary/mobile-html 请求均连接超时，截图显示连接失败，不能继续宣称文章阅读/收藏成功。

另外出现真实工具栏引导浮层：Activity 窗口聚焦，但顶层 `PopupWindow$PopupDecorView` 不聚焦；Native/H5 因 `native_window_not_focused` 拒绝，UIA 只读出底层 Activity 节点。截图有“知道了”按钮，窗口树保留独立 popup bounds。后续已修复窗口指针归属及 raw/local 触摸坐标，真实工具栏 Intent 和固定 Script 三轮完成；过程与证据见 [真实弹窗与工具栏业务](ANDROID_NATIVE_POPUP_BUSINESS_2026-09-12.md)。网络问题仍单独保留。

本次 article Intent 最终为 timeout；不是成功或主动取消完成。安装和文章 Intent 均保留成功/失败证据。网络恢复后沿原路径完成 Wikipedia 搜索、文章、阅读列表与独立数据检查；离线 App 的既定后续仍为 VLC/Organic Maps。不要再复跑已关闭的 LocalSend 和固定存储边界。

## 复跑受控 WebView

先构建并安装 SDK instrumentation APK，解锁已授权设备，再用新的输出目录运行：

```sh
node desktop/ai-app-bridge-cli/scripts/validation/verify-device-h5.js \
  build/ai_app_bridge_artifacts/android-h5-new-run b46093e6 \
  /absolute/path/to/clean-install/node_modules/@mobileaidev/ai-app-bridge/bin/mcp-server.js
```

控制器启动专用 instrumentation Activity，记录 CLI/MCP/Script 和 Witness，导出与离线核验归档，最后停止自己创建的 Runtime。测试 App 的常亮设置仅存在于 instrumentation Activity。
